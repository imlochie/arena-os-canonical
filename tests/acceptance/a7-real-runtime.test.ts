/**
 * A7 REAL-RUNTIME ACCEPTANCE — PostgreSQL + Redis + BullMQ, nothing faked.
 *
 * The A7 retry work shipped with PGlite tests and a `fakeQueue` stand-in.
 * Those prove the branch logic; they do not prove the behaviour *on the
 * runtime the behaviour is for*. This suite closes that gap: the database is
 * a real PostgreSQL server holding the repo's real schema, the broker is a
 * real Redis, the queue records are real BullMQ jobs, and jobs are consumed
 * by a real BullMQ `Worker` (the app's own `waveyard-separation` queue and
 * payload shape). No PGlite, no fakeQueue, no in-memory broker.
 *
 * Scenarios (one `test` each, named A/B/C/D/E):
 *   A. A failed row whose BullMQ record does not exist (the original enqueue
 *      never reached Redis) is retried by a FRESH submission rebuilt from the
 *      row: the worker receives the payload, the row was claimed before the
 *      queue saw it, and a layer retry still carries `parentStemAssetId`.
 *   B. Existing FINISHED records (failed and completed) are retried IN PLACE:
 *      the same BullMQ record (unchanged creation time), one record, one new
 *      execution — never a duplicate beside it.
 *   C. Records BullMQ still holds — waiting, delayed, active — are not
 *      duplicated by a retry, and the row honestly says `queued` while the
 *      executor owns the work (then follows the lifecycle to `complete`).
 *   D. An unreachable Redis fails in bounded time: the hand-off's designed
 *      deadline fires, the row is restored to exactly its failed state, and
 *      the HTTP route answers 503 instead of hanging or claiming success.
 *   E. A retry raced against a fresh claim: the active-only unique index
 *      (`processing_jobs_active_idempotency_unique`) permits at most one
 *      active attempt per target, whichever side wins, and the loser never
 *      hands work to an executor.
 *
 * NOT proven here: separation itself. This process has no Demucs checkpoint
 * and no model install, so the worker below records the payload and follows
 * the row lifecycle; it does not fabricate stems. Real Demucs inference is a
 * separate, environment-gated check.
 *
 * HOW TO RUN (see docs/a7-real-runtime-acceptance.md):
 *   A7_ACCEPTANCE=1 \
 *   DATABASE_URL=postgresql://…/app_db \
 *   A7_ACCEPTANCE_REDIS_URL=redis://127.0.0.1:6379/0 \
 *   npm run test:acceptance:a7
 *
 * The suite is deliberately outside the `npm test` globs (`src/**` and
 * `desktop/**`), so the normal suite never pays for it and never needs
 * services. With `A7_ACCEPTANCE` unset this file registers one skipped test.
 * With it set and a service missing, it FAILS LOUDLY — a CI job that lost
 * Redis must not turn into a silent skip.
 *
 * Safety: use a Redis dedicated to acceptance. The suite only ever deletes
 * the job ids it created (never FLUSHDB / obliterate / drain) and deletes
 * only the projects it created (cascade removes their rows). It never sets
 * `REDIS_URL` in the parent environment; it sets it inside this process,
 * which is dedicated to the suite, so the desktop `LocalJobBroker` policy in
 * the normal test run is untouched.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { Queue, Worker, type Job, type JobType } from "bullmq";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import Redis from "ioredis";
import { Pool } from "pg";

import { LOCAL_OWNER_ID } from "@/db/schema";
import { processingJobs, projects, sourceAssets } from "@/db/waveyardSchema";
import {
  claimProcessingJob,
  type ClaimDb,
  type ProcessingJobInsert,
} from "@/lib/waveyard/separation/claim";
import {
  isUniqueViolation,
  retrySeparationJob,
  SERVER_QUEUE_HANDOFF_TIMEOUT_MS,
  serverQueueHandOff,
} from "@/lib/waveyard/separation/retry";
import { SEPARATION_QUEUE } from "@/lib/waveyard/queue";

const RUN = randomUUID().slice(0, 8);

if (process.env.A7_ACCEPTANCE !== "1") {
  test(
    "A7 real-runtime acceptance (disabled)",
    { skip: "set A7_ACCEPTANCE=1 (npm run test:acceptance:a7) to run against real PostgreSQL + Redis" },
    () => undefined,
  );
} else {
  runAcceptanceSuite();
}

function runAcceptanceSuite(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const redisUrl = process.env.A7_ACCEPTANCE_REDIS_URL ?? "";
  // A port that is guaranteed closed on loopback: scenario D's "unreachable".
  const deadRedisUrl = process.env.A7_ACCEPTANCE_DEAD_REDIS_URL ?? "redis://127.0.0.1:1";

  // Fail loudly, at module load, when explicitly enabled but unconfigured —
  // never let a misconfigured CI job turn the acceptance gate into a skip.
  if (databaseUrl === "") {
    throw new Error(
      "A7 acceptance: A7_ACCEPTANCE=1 but DATABASE_URL is not set. Point it at a PostgreSQL database whose schema was pushed with `npx drizzle-kit push --force`.",
    );
  }
  if (redisUrl === "") {
    throw new Error(
      "A7 acceptance: A7_ACCEPTANCE=1 but A7_ACCEPTANCE_REDIS_URL is not set. Point it at a DEDICATED Redis (the suite uses the app's real `waveyard-separation` queue).",
    );
  }

  // Server mode for the whole process: the retry route and queue.ts resolve
  // their runtime from the environment, and this file exists to exercise the
  // BullMQ path — not the desktop LocalJobBroker. The parent environment is
  // untouched; this process is the suite.
  process.env.REDIS_URL = redisUrl;
  delete process.env.ARENA_DESKTOP_MODE;
  delete process.env.WAVEYARD_LOCAL_WORKER;

  type Db = ReturnType<typeof drizzle>;
  let pool: Pool;
  let pool2: Pool;
  let db: Db;
  let db2: Db;
  let redis: Redis;
  const createdProjects: string[] = [];
  const createdJobIds = new Set<string>();

  // ----------------------------------------------------------- connection

  type QueueHandle = { queue: Queue; connection: Redis };
  type WorkerHandle = { worker: Worker; connection: Redis };

  function openQueue(url: string = redisUrl): QueueHandle {
    const connection = new Redis(url, { maxRetriesPerRequest: null });
    connection.on("error", () => undefined); // ioredis reconnects loudly otherwise
    return { queue: new Queue(SEPARATION_QUEUE, { connection }), connection };
  }

  async function closeQueue(handle: QueueHandle): Promise<void> {
    try {
      await handle.queue.close();
    } finally {
      handle.connection.disconnect();
    }
  }

  function openWorker(processor: (job: Job) => Promise<unknown>): WorkerHandle {
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    connection.on("error", () => undefined);
    const worker = new Worker(SEPARATION_QUEUE, processor, { connection });
    worker.on("error", () => undefined);
    return { worker, connection };
  }

  async function closeWorker(handle: WorkerHandle): Promise<void> {
    try {
      await handle.worker.close();
    } finally {
      handle.connection.disconnect();
    }
  }

  // -------------------------------------------------------------- fixtures

  async function createProject(): Promise<{ projectId: string; sourceId: string }> {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      ownerId: LOCAL_OWNER_ID,
      title: `A7 acceptance ${RUN}`,
    });
    createdProjects.push(projectId);
    const sourceId = randomUUID();
    await db.insert(sourceAssets).values({
      id: sourceId,
      projectId,
      originalFilename: "a7-acceptance.wav",
      mimeType: "audio/wav",
      storageKey: `a7-acceptance/${RUN}/${sourceId}.wav`,
      checksumSha256: "a".repeat(64),
      durationSeconds: 2,
      sampleRate: 44100,
      channels: 2,
      codec: "pcm_s16le",
      fileSizeBytes: 352800,
    });
    return { projectId, sourceId };
  }

  type FailedJob = ProcessingJobInsert & { id: string; projectId: string; sourceAssetId: string };

  async function insertFailedJob(overrides: Partial<ProcessingJobInsert> = {}): Promise<FailedJob> {
    const { projectId, sourceId } = await createProject();
    const id = randomUUID();
    const values: FailedJob = {
      id,
      projectId,
      sourceAssetId: sourceId,
      type: "separation",
      status: "failed",
      stage: "failed",
      idempotencyKey: `separation:${randomUUID()}`,
      model: "kim_vocal_2",
      requestedDevice: "auto",
      errorCode: "separation_unavailable",
      errorMessage: "model not present",
      metadata: "{}",
      completedAt: new Date("2026-01-02T03:04:05.000Z"),
      ...overrides,
    };
    await db.insert(processingJobs).values(values);
    createdJobIds.add(id);
    return values;
  }

  function payloadOf(row: FailedJob): Record<string, unknown> {
    return {
      processingJobId: row.id,
      projectId: row.projectId,
      sourceAssetId: row.sourceAssetId,
      model: row.model,
      requestedDevice: "auto",
    };
  }

  async function readRow(id: string): Promise<typeof processingJobs.$inferSelect> {
    const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
    assert.ok(row, `row ${id} exists`);
    return row;
  }

  async function activeAttempts(key: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.idempotencyKey, key),
          sql`${processingJobs.status} not in ('complete', 'failed', 'cancelled')`,
        ),
      );
    return Number(row?.count ?? 0);
  }

  async function recordCount(queue: Queue, id: string): Promise<number> {
    const states: JobType[] = [
      "waiting",
      "active",
      "delayed",
      "failed",
      "completed",
      "prioritized",
      "waiting-children",
    ];
    const jobs = await queue.getJobs(states, 0, -1);
    return jobs.filter((job) => job?.id === id).length;
  }

  async function stateOf(queue: Queue, id: string): Promise<string> {
    const job = await queue.getJob(id);
    assert.ok(job, `BullMQ record ${id} exists`);
    return String(await job.getState());
  }

  async function waitFor<T>(
    probe: () => Promise<T | null | undefined> | T | null | undefined,
    what: string,
    timeoutMs = 15_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown = undefined;
    while (Date.now() < deadline) {
      last = await probe();
      if (last !== null && last !== undefined) return last as T;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what} (last probe result: ${String(last)})`);
  }

  function waitForState(queue: Queue, id: string, wanted: string, timeoutMs = 15_000): Promise<string> {
    return waitFor(
      async () => {
        const actual = await stateOf(queue, id);
        return actual === wanted ? actual : null;
      },
      `BullMQ record ${id} to reach state "${wanted}"`,
      timeoutMs,
    );
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function deferred(id: string, gates: Map<string, { promise: Promise<void>; release: () => void }>): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(id, { promise, release });
  }

  // -------------------------------------------------------------- lifecycle

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    pool2 = new Pool({ connectionString: databaseUrl, max: 4 });
    db = drizzle(pool);
    db2 = drizzle(pool2);

    try {
      await db.select().from(processingJobs).limit(1);
    } catch (error) {
      throw new Error(
        `A7 acceptance: PostgreSQL at ${databaseUrl} does not hold the app schema (processing_jobs unreadable). Run \`npx drizzle-kit push --force\` first. Cause: ${(error as Error).message}`,
      );
    }

    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, retryStrategy: () => null });
    redis.on("error", () => undefined);
    const pong = await Promise.race([
      redis.ping(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timed out after 5000ms")), 5_000)),
    ]).catch((error: unknown) => {
      throw new Error(`A7 acceptance: Redis at ${redisUrl} is not reachable: ${(error as Error).message}`);
    });
    assert.equal(pong, "PONG", `Redis at ${redisUrl} answers PING`);
  });

  after(async () => {
    if (pool === undefined) return;
    // Redis cleanup first: only the records this suite created, by id.
    const handle = openQueue();
    try {
      for (const id of createdJobIds) {
        const job = await handle.queue.getJob(id).catch(() => undefined);
        if (job === undefined || job === null) continue;
        try {
          await job.remove();
        } catch (error) {
          console.error(`A7 acceptance cleanup: could not remove BullMQ record ${id}: ${(error as Error).message}`);
        }
      }
    } finally {
      await closeQueue(handle);
    }
    if (createdProjects.length > 0) {
      // Deleting the project cascades to its sources and processing jobs.
      await db.delete(projects).where(inArray(projects.id, createdProjects));
    }
    redis.disconnect();
    await pool.end();
    await pool2.end();
  });

  // ------------------------------------------------------------------- A

  test("A — no BullMQ record: retried by a fresh submission; the real worker receives the payload, row claimed first, layer target preserved", { timeout: 60_000 }, async () => {
    const parentStemAssetId = randomUUID();
    const row = await insertFailedJob({
      model: "deep_6s",
      stage: "queue-unavailable",
      errorCode: "queue_unavailable",
      errorMessage: "Queue unavailable: Redis is not reachable.",
      metadata: JSON.stringify({ kind: "deep-layers", parentStemAssetId, parentStemType: "other" }),
    });

    const received: Array<{ jobId: string; data: Record<string, unknown>; rowStatus: string; rowStage: string }> = [];
    const handle = openQueue();
    const workerHandle = openWorker(async (job) => {
      const current = await readRow(String(job.id));
      received.push({
        jobId: String(job.id),
        data: job.data as Record<string, unknown>,
        rowStatus: current.status,
        rowStage: current.stage,
      });
      return "delivered";
    });

    try {
      assert.equal(await handle.queue.getJob(row.id), undefined, "no BullMQ record exists — the original enqueue never reached Redis");

      const result = await retrySeparationJob(db, row.id, { handOff: serverQueueHandOff(handle.queue) });
      assert.deepEqual(result, { queued: true });

      const delivered = await waitFor(() => received[0], "the real BullMQ worker to receive the re-submitted job");
      assert.equal(delivered.jobId, row.id, "the record is keyed by the processing job id");
      assert.equal(delivered.data.processingJobId, row.id, "the payload was rebuilt from the durable row");
      assert.equal(delivered.data.projectId, row.projectId);
      assert.equal(delivered.data.sourceAssetId, row.sourceAssetId);
      assert.equal(delivered.data.model, "deep_6s");
      assert.equal(delivered.data.parentStemAssetId, parentStemAssetId, "a layer retry must keep separating the same parent stem");
      assert.equal("parentStemType" in delivered.data, false, "only the handler's payload contract rides the queue");
      assert.equal(delivered.rowStatus, "queued", "the row was claimed BEFORE the queue was asked");
      assert.equal(delivered.rowStage, "queued");

      await waitForState(handle.queue, row.id, "completed", 20_000);
      assert.equal(await recordCount(handle.queue, row.id), 1, "exactly one record, one execution");

      const afterRow = await readRow(row.id);
      assert.equal(afterRow.status, "queued", "the row stays claimed until the worker moves it");
      assert.equal(afterRow.errorCode, null, "the old failure was cleared by the claim");
      assert.equal(afterRow.completedAt, null);
      assert.equal(received.length, 1);
    } finally {
      await closeWorker(workerHandle);
      await closeQueue(handle);
    }
  });

  // ------------------------------------------------------------------- B

  test("B — an existing FAILED record is retried in place: same record, same creation time, one new execution", { timeout: 60_000 }, async () => {
    const row = await insertFailedJob();
    const handle = openQueue();
    const executions: string[] = [];
    const firstWorker = openWorker(async () => {
      executions.push(String(row.id));
      throw new Error("first attempt fails on purpose");
    });
    let secondWorker: WorkerHandle | null = null;

    try {
      await handle.queue.add("separate", payloadOf(row), {
        jobId: row.id,
        attempts: 1,
        removeOnComplete: { age: 60 * 60 * 24, count: 5000 },
        removeOnFail: { age: 60 * 60 * 24 * 7, count: 5000 },
      });
      await waitForState(handle.queue, row.id, "failed");
      const before = await handle.queue.getJob(row.id);
      assert.ok(before);
      const createdAt = before.timestamp;
      await closeWorker(firstWorker);
      await handle.queue.pause();

      const result = await retrySeparationJob(db, row.id, { handOff: serverQueueHandOff(handle.queue) });
      assert.deepEqual(result, { queued: true });

      const retried = await handle.queue.getJob(row.id);
      assert.ok(retried, "the record still exists");
      assert.equal(await retried.getState(), "waiting", "BullMQ moved the SAME record back to the wait list");
      assert.equal(retried.timestamp, createdAt, "creation time unchanged — this is a retry, not a new submission");
      assert.equal(await recordCount(handle.queue, row.id), 1, "no duplicate record beside it");

      const claimed = await readRow(row.id);
      assert.equal(claimed.status, "queued", "the row was claimed before the hand-off");
      assert.equal(claimed.errorCode, null, "the earlier failure is cleared for the retry");
      assert.equal(claimed.completedAt, null);

      secondWorker = openWorker(async (job) => {
        executions.push(String(job.id));
        await db
          .update(processingJobs)
          .set({ status: "complete", stage: "complete", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(processingJobs.id, row.id));
        return "ok";
      });
      await handle.queue.resume();
      await waitForState(handle.queue, row.id, "completed", 20_000);

      assert.deepEqual(executions, [row.id, row.id], "the record ran once as a failure and once as the retry — never twice in parallel");
      const finished = await readRow(row.id);
      assert.equal(finished.status, "complete");
      assert.equal(finished.errorCode, null);
    } finally {
      await handle.queue.resume().catch(() => undefined);
      await closeWorker(firstWorker).catch(() => undefined);
      if (secondWorker !== null) await closeWorker(secondWorker).catch(() => undefined);
      await closeQueue(handle);
    }
  });

  test("B — an existing COMPLETED record is retried in place: same record, one new execution", { timeout: 60_000 }, async () => {
    const row = await insertFailedJob();
    const handle = openQueue();
    const executions: string[] = [];
    const firstWorker = openWorker(async () => {
      executions.push(String(row.id));
      return "first run";
    });
    let secondWorker: WorkerHandle | null = null;

    try {
      await handle.queue.add("separate", payloadOf(row), {
        jobId: row.id,
        attempts: 1,
        removeOnComplete: { age: 60 * 60 * 24, count: 5000 },
      });
      await waitForState(handle.queue, row.id, "completed");
      const before = await handle.queue.getJob(row.id);
      assert.ok(before);
      const createdAt = before.timestamp;
      await closeWorker(firstWorker);
      await handle.queue.pause();

      const result = await retrySeparationJob(db, row.id, { handOff: serverQueueHandOff(handle.queue) });
      assert.deepEqual(result, { queued: true });

      const retried = await handle.queue.getJob(row.id);
      assert.ok(retried);
      assert.equal(await retried.getState(), "waiting", "retry('completed') moved the finished record back to waiting");
      assert.equal(retried.timestamp, createdAt, "the same record — not a fresh submission");
      assert.equal(await recordCount(handle.queue, row.id), 1, "no duplicate record");

      secondWorker = openWorker(async (job) => {
        executions.push(String(job.id));
        return "second run";
      });
      await handle.queue.resume();
      await waitForState(handle.queue, row.id, "completed", 20_000);
      assert.deepEqual(executions, [row.id, row.id], "exactly one new execution");
      assert.equal(await recordCount(handle.queue, row.id), 1);
    } finally {
      await handle.queue.resume().catch(() => undefined);
      await closeWorker(firstWorker).catch(() => undefined);
      if (secondWorker !== null) await closeWorker(secondWorker).catch(() => undefined);
      await closeQueue(handle);
    }
  });

  // ------------------------------------------------------------------- C

  test("C — records BullMQ still holds (waiting / delayed / active) are not duplicated, and the row follows the live lifecycle", { timeout: 90_000 }, async () => {
    const handle = openQueue();
    const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
    const seen: string[] = [];

    const workerHandle = openWorker(async (job) => {
      // BullMQ claims in Redis before application processor setup finishes.
      // Exercise that real lifecycle boundary rather than relying on speed.
      await sleep(75);
      const id = String(job.id);
      seen.push(id);
      const gate = gates.get(id);
      if (gate !== undefined) await gate.promise;
      await db
        .update(processingJobs)
        .set({ status: "complete", stage: "complete", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(processingJobs.id, id));
      return "ok";
    });

    try {
      // (a) waiting: the queue is paused, so the record is held by BullMQ.
      const waitingRow = await insertFailedJob();
      await handle.queue.pause();
      await handle.queue.add("separate", payloadOf(waitingRow), { jobId: waitingRow.id, attempts: 1 });
      await waitForState(handle.queue, waitingRow.id, "waiting");

      const waitingRetry = await retrySeparationJob(db, waitingRow.id, { handOff: serverQueueHandOff(handle.queue) });
      assert.deepEqual(waitingRetry, { queued: true });
      assert.equal(await stateOf(handle.queue, waitingRow.id), "waiting", "the existing record was left where it was");
      assert.equal(await recordCount(handle.queue, waitingRow.id), 1, "a waiting record is not duplicated");
      assert.equal(seen.filter((id) => id === waitingRow.id).length, 0, "nothing ran while the queue was paused");
      const waitingClaim = await readRow(waitingRow.id);
      assert.equal(waitingClaim.status, "queued", "the row honestly says the executor still holds it");
      // Remove the held record while the queue is paused, then let it run.
      await (await handle.queue.getJob(waitingRow.id))?.remove();
      await handle.queue.resume();

      // (b) delayed: a scheduled record is equally owned by BullMQ.
      const delayedRow = await insertFailedJob();
      await handle.queue.add("separate", payloadOf(delayedRow), { jobId: delayedRow.id, attempts: 1, delay: 60_000 });
      await waitForState(handle.queue, delayedRow.id, "delayed");

      const delayedRetry = await retrySeparationJob(db, delayedRow.id, { handOff: serverQueueHandOff(handle.queue) });
      assert.deepEqual(delayedRetry, { queued: true });
      assert.equal(await stateOf(handle.queue, delayedRow.id), "delayed", "the scheduled record was left alone");
      assert.equal(await recordCount(handle.queue, delayedRow.id), 1, "a delayed record is not duplicated");
      assert.equal((await readRow(delayedRow.id)).status, "queued");
      await (await handle.queue.getJob(delayedRow.id))?.remove();

      // (c) active: the record is running right now; the retry must not add a
      // second one, and the row must show the attempt is owned.
      const activeRow = await insertFailedJob();
      deferred(activeRow.id, gates);
      await handle.queue.add("separate", payloadOf(activeRow), { jobId: activeRow.id, attempts: 1 });
      await waitForState(handle.queue, activeRow.id, "active");
      await waitFor(() => seen.includes(activeRow.id) ? true : null, "the actual application processor to enter after Redis claim");
      assert.equal(seen.filter((id) => id === activeRow.id).length, 1, "the real worker is processing it");

      const activeRetry = await retrySeparationJob(db, activeRow.id, { handOff: serverQueueHandOff(handle.queue) });
      assert.deepEqual(activeRetry, { queued: true });
      assert.equal(await stateOf(handle.queue, activeRow.id), "active", "still the one running record");
      assert.equal(await recordCount(handle.queue, activeRow.id), 1, "an active record is not duplicated");
      assert.equal(seen.filter((id) => id === activeRow.id).length, 1, "the retry did not start a second execution");
      assert.equal((await readRow(activeRow.id)).status, "queued", "the row is claimed by the running attempt");

      gates.get(activeRow.id)?.release();
      await waitForState(handle.queue, activeRow.id, "completed", 20_000);
      assert.equal((await readRow(activeRow.id)).status, "complete", "the row follows the record to completion");
    } finally {
      for (const gate of gates.values()) gate.release();
      await handle.queue.resume().catch(() => undefined);
      await closeWorker(workerHandle);
      await closeQueue(handle);
    }
  });

  // ------------------------------------------------------------------- D

  test("D1 — an unreachable Redis fails the hand-off within its designed deadline and restores the row exactly", { timeout: 30_000 }, async () => {
    const row = await insertFailedJob({
      stage: "queue-unavailable",
      errorCode: "queue_unavailable",
      errorMessage: "Queue unavailable: Redis is not reachable.",
    });
    const connection = new Redis(deadRedisUrl, { maxRetriesPerRequest: null, connectTimeout: 500 });
    connection.on("error", () => undefined);
    const queue = new Queue(SEPARATION_QUEUE, { connection });

    const started = Date.now();
    let result!: Awaited<ReturnType<typeof retrySeparationJob>>;
    try {
      result = await retrySeparationJob(db, row.id, {
        handOff: serverQueueHandOff(queue, { timeoutMs: 750 }),
      });
    } finally {
      await queue.close().catch(() => undefined);
      connection.disconnect();
    }
    const elapsed = Date.now() - started;

    assert.equal(result.queued, false);
    if (result.queued) return;
    assert.equal(result.kind, "queue-refused");
    assert.match(result.reason, /did not answer within/);
    assert.match(result.reason, /not reachable/);
    assert.ok(elapsed >= 700, `the designed timeout fired (elapsed ${elapsed}ms)`);
    assert.ok(elapsed < 10_000, `bounded — did not hang (elapsed ${elapsed}ms)`);

    const restored = await readRow(row.id);
    assert.equal(restored.status, "failed");
    assert.equal(restored.stage, "queue-unavailable");
    assert.equal(restored.errorCode, "queue_unavailable");
    assert.equal(restored.errorMessage, "Queue unavailable: Redis is not reachable.");
    assert.equal(restored.completedAt?.toISOString(), row.completedAt?.toISOString());
  });

  test("D2 — the retry ROUTE answers 503 within the designed deadline when Redis is unreachable, with the row restored", { timeout: 90_000 }, async () => {
    const row = await insertFailedJob();
    const previousRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = deadRedisUrl;

    let status = 0;
    let body: { error?: string } = {};
    let elapsed = 0;
    try {
      const route = await import("@/app/api/jobs/[id]/retry/route");
      const started = Date.now();
      const response = await route.POST(
        new Request(`http://localhost/api/jobs/${row.id}/retry`, { method: "POST" }),
        { params: Promise.resolve({ id: row.id }) },
      );
      elapsed = Date.now() - started;
      status = response.status;
      body = (await response.json()) as { error?: string };
    } finally {
      if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedisUrl;
    }

    assert.equal(status, 503, "the route answers honestly instead of hanging or claiming success");
    assert.match(String(body.error), /not reachable|did not answer/i);
    assert.ok(
      elapsed >= SERVER_QUEUE_HANDOFF_TIMEOUT_MS - 1_000,
      `the designed ${SERVER_QUEUE_HANDOFF_TIMEOUT_MS}ms deadline fired (elapsed ${elapsed}ms)`,
    );
    assert.ok(elapsed < 30_000, `bounded (elapsed ${elapsed}ms)`);

    const restored = await readRow(row.id);
    assert.equal(restored.status, "failed");
    assert.equal(restored.stage, row.stage);
    assert.equal(restored.errorCode, row.errorCode);
    assert.equal(restored.errorMessage, row.errorMessage);
    assert.equal(restored.completedAt?.toISOString(), row.completedAt?.toISOString());
  });

  // ------------------------------------------------------------------- E

  test("E1 — a retry raced against a fresh claim: exactly one active attempt per target, loser never enqueues", { timeout: 120_000 }, async () => {
    // Pre-warm the second pool so both sides start with a live connection.
    await db2.select().from(processingJobs).limit(1);
    const iterations = 20;
    let retryWins = 0;
    let claimWins = 0;

    for (let index = 0; index < iterations; index += 1) {
      const key = `separation-deep:${randomUUID()}`;
      const failed = await insertFailedJob({ model: "deep_6s", idempotencyKey: key });
      const claimValues: ProcessingJobInsert = {
        projectId: failed.projectId,
        sourceAssetId: failed.sourceAssetId,
        type: "separation",
        status: "queued",
        stage: "queued",
        idempotencyKey: key,
        model: "deep_6s",
        requestedDevice: "auto",
        metadata: JSON.stringify({ kind: "deep-layers" }),
      };
      let handOffs = 0;

      const retry = () =>
        retrySeparationJob(db, failed.id, {
          handOff: async () => {
            handOffs += 1;
          },
        });
      const claim = () => claimProcessingJob(db2 as unknown as ClaimDb, claimValues);

      // Genuine races, plus both deterministic interleavings, so neither
      // ordering can be skipped by luck.
      const order = index % 3;
      const [retryOutcome, claimOutcome] =
        order === 0
          ? await Promise.all([retry(), sleep(15).then(claim)])
          : order === 1
            ? await Promise.all([sleep(15).then(retry), claim()])
            : await Promise.all([retry(), claim()]);

      assert.equal(await activeAttempts(key), 1, `iteration ${index}: the partial unique index admits one active attempt`);

      if (retryOutcome.queued) {
        retryWins += 1;
        assert.equal(claimOutcome.created, false, `iteration ${index}: the fresh claim was refused while the retry held the key`);
        assert.equal(handOffs, 1);
      } else {
        claimWins += 1;
        assert.equal(
          claimOutcome.created,
          true,
          `iteration ${index}: a lost retry can only mean the fresh claim won — got ${JSON.stringify(retryOutcome)}`,
        );
        assert.equal(handOffs, 0, "the losing retry never asked an executor to take the job");
      }
    }

    assert.equal(retryWins + claimWins, iterations);
    assert.ok(retryWins > 0, "at least one race had the retry claim first");
    assert.ok(claimWins > 0, "at least one race had the fresh claim first");
  });

  test("E2 — two simultaneous retries of the same row: one claim, one hand-off, one queued row", { timeout: 60_000 }, async () => {
    const row = await insertFailedJob();
    let handOffs = 0;
    const [first, second] = await Promise.all([
      retrySeparationJob(db, row.id, {
        handOff: async () => {
          handOffs += 1;
        },
      }),
      retrySeparationJob(db2, row.id, {
        handOff: async () => {
          handOffs += 1;
        },
      }),
    ]);

    const winners = [first, second].filter((outcome) => outcome.queued);
    assert.equal(winners.length, 1, "exactly one retry claimed the row");
    assert.equal(handOffs, 1, "the executor was asked exactly once");
    assert.equal((await readRow(row.id)).status, "queued");
    assert.equal(await activeAttempts(row.idempotencyKey), 1);
  });

  test("E3 — PostgreSQL itself refuses a second active attempt, and frees the key once the attempt is terminal", { timeout: 60_000 }, async () => {
    const key = `separation-deep:${randomUUID()}`;
    const row = await insertFailedJob({ model: "deep_6s", idempotencyKey: key });
    const claimed = await retrySeparationJob(db, row.id, { handOff: async () => undefined });
    assert.deepEqual(claimed, { queued: true });

    const duplicate: ProcessingJobInsert = {
      projectId: row.projectId,
      sourceAssetId: row.sourceAssetId,
      type: "separation",
      status: "queued",
      stage: "queued",
      idempotencyKey: key,
      model: "deep_6s",
      requestedDevice: "auto",
      metadata: "{}",
    };

    await assert.rejects(
      () => db.insert(processingJobs).values(duplicate).returning(),
      (error: unknown) => {
        assert.equal(isUniqueViolation(error), true, `expected a 23505 unique violation, got ${String(error)}`);
        return true;
      },
      "a second active attempt at the same target is refused by the database",
    );

    // Once the attempt is terminal, the same target is free again.
    await db
      .update(processingJobs)
      .set({ status: "failed", stage: "failed", errorCode: "separation_failed", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(processingJobs.id, row.id));
    const [replacement] = await db.insert(processingJobs).values(duplicate).returning();
    assert.ok(replacement, "the key was freed by the terminal state");
    assert.equal(await activeAttempts(key), 1);
  });
}
