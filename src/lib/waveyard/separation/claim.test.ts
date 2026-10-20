/**
 * Job-claim tests — "one ACTIVE attempt per target", proven at the
 * database, which is where the guarantee lives.
 *
 * Lifecycle on PGlite (the canonical desktop migrations, in memory):
 *   - a second claim while the first attempt is queued/running is refused
 *     and names the active holder (what the routes turn into a 409);
 *   - once that attempt is complete, failed, or cancelled, the SAME target
 *     is claimable again as a FRESH row — the old row stays as history;
 *   - the old whole-key uniqueness is gone (the migration dropped it).
 *
 * The routes' whole start step (startSeparationJob) on PGlite with the
 * local broker: a claimed row reaches the executor with its payload; when
 * the queue refuses (no executor in this runtime) the row is recorded as a
 * failed, retryable `queue_unavailable` attempt — never left `queued` —
 * and the target's key is free for a fresh request; a retry brings the
 * same row back once an executor exists.
 *
 * Concurrency on the real embedded PostgreSQL cluster (the same binaries
 * the desktop ships), many connections at once: a burst of simultaneous
 * claims yields exactly one new job and every loser names it; a burst
 * after the attempt is over yields exactly one fresh row; and a retry of an
 * earlier failed row racing a fresh claim — in both the local and the
 * server-mode (injected hand-off) flavour — can never leave two active rows
 * nor hand a losing retry to the queue. Skipped visibly when the embedded
 * binaries are not installed.
 */

import "../worker-local/_separation-test-env";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";

import { processingJobIsActive, processingJobs, projects, sourceAssets } from "@/db/waveyardSchema";
import { SEPARATION_QUEUE } from "@/lib/waveyard/queue";
import { getLocalJobBroker, resetLocalJobBrokerForTests } from "@/lib/waveyard/worker-local/broker";
import {
  claimProcessingJob,
  findActiveProcessingJob,
  startSeparationJob,
  type ClaimDb,
  type ClaimOutcome,
  type ProcessingJobInsert,
} from "./claim";
import { retrySeparationJob, type RetryOutcome, type SeparationDb } from "./retry";
import type { SeparationJobPayload } from "@/lib/waveyard/types";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

async function seedProjectAndSource(database: ClaimDb) {
  const [project] = await (database as SeparationDb)
    .insert(projects)
    .values({ ownerId: randomUUID(), title: "Claim" })
    .returning();
  const [source] = await (database as SeparationDb)
    .insert(sourceAssets)
    .values({
      projectId: project.id,
      originalFilename: "source.wav",
      mimeType: "audio/wav",
      storageKey: `projects/${project.id}/source/${randomUUID()}.wav`,
      checksumSha256: "0".repeat(64),
      durationSeconds: 1,
      sampleRate: 44_100,
      channels: 2,
      codec: "pcm_s16le",
      fileSizeBytes: 176_400,
    })
    .returning();
  return { project, source };
}

function deepJobValues(projectId: string, sourceAssetId: string, idempotencyKey: string): ProcessingJobInsert {
  return {
    projectId,
    sourceAssetId,
    type: "separation",
    status: "queued",
    stage: "queued",
    idempotencyKey,
    model: "deep_6s",
    requestedDevice: "auto",
    metadata: JSON.stringify({ kind: "deep-stems", deep: true }),
  };
}

async function pgliteFixture() {
  const client = new PGlite();
  const { applyMigrations } = await import("../../../../desktop/runtime/migrate");
  await applyMigrations({ client: client as unknown as import("pg").Client, migrationsDir: path.join(repoRoot, "desktop-migrations") });
  const database = drizzlePglite(client) as unknown as SeparationDb;
  const { project, source } = await seedProjectAndSource(database);
  return {
    database,
    project,
    source,
    async finish(jobId: string, status: "complete" | "failed" | "cancelled") {
      await database
        .update(processingJobs)
        .set({ status, stage: status, completedAt: new Date(), ...(status === "failed" ? { errorCode: "separation_failed" } : {}) })
        .where(eq(processingJobs.id, jobId));
    },
    async close() {
      await client.close();
    },
  };
}

test("a second claim while the first attempt is queued or running is refused and names the holder", async () => {
  const f = await pgliteFixture();
  try {
    const key = `separation-deep:${f.source.id}`;
    const first = await claimProcessingJob(f.database, deepJobValues(f.project.id, f.source.id, key));
    assert.equal(first.created, true);
    if (!first.created) return;

    for (const status of ["queued", "preparing", "processing", "finalizing"] as const) {
      await f.database.update(processingJobs).set({ status, stage: status }).where(eq(processingJobs.id, first.job.id));
      const again = await claimProcessingJob(f.database, deepJobValues(f.project.id, f.source.id, key));
      assert.equal(again.created, false, `refused while ${status}`);
      if (again.created) return;
      assert.equal(again.active?.id, first.job.id, "the refusal names the attempt that holds the target");
      assert.equal(again.active?.status, status);
    }
    const rows = await f.database.select().from(processingJobs).where(eq(processingJobs.idempotencyKey, key));
    assert.equal(rows.length, 1, "no second row was created");
    assert.equal((await findActiveProcessingJob(f.database, key))?.id, first.job.id);

    // Another target is independent — its own key, its own attempt.
    const other = await claimProcessingJob(f.database, deepJobValues(f.project.id, f.source.id, `separation-deep:${randomUUID()}`));
    assert.equal(other.created, true);
  } finally {
    await f.close();
  }
});

test("once the attempt is complete, failed, or cancelled the same target is claimable again — as a fresh row, history kept", async () => {
  const f = await pgliteFixture();
  try {
    const key = `separation-deep:${f.source.id}`;
    const seen: string[] = [];
    for (const terminal of ["complete", "failed", "cancelled"] as const) {
      const claim = await claimProcessingJob(f.database, deepJobValues(f.project.id, f.source.id, key));
      assert.equal(claim.created, true, `claimable after ${seen.join(", ") || "nothing"}`);
      if (!claim.created) return;
      assert.ok(!seen.includes(claim.job.id), "a FRESH row, not the old one resurrected");
      assert.equal(claim.job.status, "queued");
      assert.equal(claim.job.errorCode, null);
      seen.push(claim.job.id);
      await f.finish(claim.job.id, terminal);
      assert.equal(await findActiveProcessingJob(f.database, key), null, `nothing active after ${terminal}`);
    }
    const rows = await f.database.select().from(processingJobs).where(eq(processingJobs.idempotencyKey, key));
    assert.deepEqual(
      rows.map((row) => row.status).sort(),
      ["cancelled", "complete", "failed"],
      "every earlier attempt stays as history under the same key",
    );
  } finally {
    await f.close();
  }
});

test("the database itself refuses two active rows for one target — no application check involved", async () => {
  const f = await pgliteFixture();
  try {
    const key = `separation-layer:${randomUUID()}:guitar`;
    await f.database.insert(processingJobs).values({ ...deepJobValues(f.project.id, f.source.id, key), status: "processing", stage: "processing" });
    await assert.rejects(
      () => f.database.insert(processingJobs).values(deepJobValues(f.project.id, f.source.id, key)),
      (error: unknown) => {
        const text = (error instanceof Error ? error.message : "") + String((error as { cause?: unknown })?.cause ?? "");
        assert.match(text, /processing_jobs_active_idempotency_unique/);
        return true;
      },
    );
    // …while a terminal row never blocks (the whole-key constraint is gone).
    await f.finish((await findActiveProcessingJob(f.database, key))!.id, "complete");
    await f.database.insert(processingJobs).values({ ...deepJobValues(f.project.id, f.source.id, key), status: "complete", stage: "complete" });
    await f.database.insert(processingJobs).values(deepJobValues(f.project.id, f.source.id, key));
    const active = await f.database
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.idempotencyKey, key), processingJobIsActive(processingJobs.status)));
    assert.equal(active.length, 1);
  } finally {
    await f.close();
  }
});

function payloadFor(values: ProcessingJobInsert, parentStemAssetId?: string) {
  const sourceAssetId = values.sourceAssetId;
  assert.ok(sourceAssetId, "separation fixture requires a real source identity");
  return (job: { id: string }): SeparationJobPayload => ({
    processingJobId: job.id,
    projectId: values.projectId,
    sourceAssetId,
    model: values.model,
    requestedDevice: "auto",
    ...(parentStemAssetId !== undefined ? { parentStemAssetId } : {}),
  });
}

test("startSeparationJob: a claimed row reaches the executor with its payload — the honest 202", async () => {
  const f = await pgliteFixture();
  process.env.ARENA_DESKTOP_MODE = "1";
  resetLocalJobBrokerForTests();
  const submitted: Array<Record<string, unknown>> = [];
  getLocalJobBroker().register(SEPARATION_QUEUE, async (payload) => {
    submitted.push(payload);
  });
  try {
    const parentStemAssetId = randomUUID();
    const values = deepJobValues(f.project.id, f.source.id, `separation-deep:${parentStemAssetId}`);
    const started = await startSeparationJob(f.database, values, payloadFor(values, parentStemAssetId));
    assert.equal(started.outcome, "queued");
    if (started.outcome !== "queued") return;
    assert.equal(submitted.length, 1, "the broker received the job");
    assert.equal(submitted[0].processingJobId, started.job.id);
    assert.equal(submitted[0].parentStemAssetId, parentStemAssetId, "the layer target rides along");

    const again = await startSeparationJob(f.database, values, payloadFor(values, parentStemAssetId));
    assert.equal(again.outcome, "active", "a repeat while queued is the 409");
    if (again.outcome === "active") assert.equal(again.active?.id, started.job.id);
    assert.equal(submitted.length, 1, "nothing was enqueued twice");
  } finally {
    resetLocalJobBrokerForTests();
    delete process.env.ARENA_DESKTOP_MODE;
    await f.close();
  }
});

test("startSeparationJob: when the queue refuses, the row is a failed retryable attempt and the target is FREE — never a stranded `queued` row", async () => {
  const f = await pgliteFixture();
  process.env.ARENA_DESKTOP_MODE = "1";
  resetLocalJobBrokerForTests(); // no executor registered for the separation queue
  try {
    const key = `separation-deep:${f.source.id}`;
    const values = deepJobValues(f.project.id, f.source.id, key);
    const first = await startSeparationJob(f.database, values, payloadFor(values));
    assert.equal(first.outcome, "not-queued");
    if (first.outcome !== "not-queued") return;
    assert.match(first.reason, /no local executor/);
    assert.equal(first.job.status, "failed", "not `queued` — nothing would ever run it");
    assert.equal(first.job.stage, "queue-unavailable");
    assert.equal(first.job.errorCode, "queue_unavailable", "a retryable code (RETRYABLE_ERROR_CODES)");
    assert.match(first.job.errorMessage ?? "", /no local executor/);
    assert.ok(first.job.completedAt !== null);
    assert.equal(await findActiveProcessingJob(f.database, key), null, "the key is released");

    // The target is usable again immediately: a fresh request creates a
    // fresh row (it fails the same honest way while there is no executor).
    const second = await startSeparationJob(f.database, values, payloadFor(values));
    assert.equal(second.outcome, "not-queued");
    if (second.outcome === "not-queued") assert.notEqual(second.job.id, first.job.id, "a fresh attempt, not a 409");

    // And once an executor exists, the failed rows are retryable on their own
    // row — the retry button / post-seed sweep path.
    const submitted: string[] = [];
    getLocalJobBroker().register(SEPARATION_QUEUE, async (payload) => {
      submitted.push(String(payload.processingJobId));
    });
    const retried = await retrySeparationJob(f.database, first.job.id);
    assert.deepEqual(retried, { queued: true });
    assert.deepEqual(submitted, [first.job.id]);
    const blocked = await retrySeparationJob(f.database, second.outcome === "not-queued" ? second.job.id : "");
    assert.equal(blocked.queued === false && blocked.kind, "newer-attempt", "one active attempt per target still holds");

    // A working executor from the start: the honest 202 path on the same target
    // is only possible once the retried attempt is over.
    await f.finish(first.job.id, "complete");
    const third = await startSeparationJob(f.database, values, payloadFor(values));
    assert.equal(third.outcome, "queued");
  } finally {
    resetLocalJobBrokerForTests();
    delete process.env.ARENA_DESKTOP_MODE;
    await f.close();
  }
});

test("startSeparationJob: a test-seam enqueue that throws is released the same way (no broker involved)", async () => {
  const f = await pgliteFixture();
  try {
    const values = deepJobValues(f.project.id, f.source.id, `separation-layer:${randomUUID()}:guitar`);
    const started = await startSeparationJob(f.database, values, payloadFor(values), {
      enqueue: async () => {
        throw new Error("Redis connection refused");
      },
    });
    assert.equal(started.outcome, "not-queued");
    if (started.outcome !== "not-queued") return;
    assert.equal(started.reason, "Redis connection refused");
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, started.job.id));
    assert.equal(row.status, "failed");
    assert.equal(row.errorCode, "queue_unavailable");
    assert.equal(row.errorMessage, "Redis connection refused");
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// Real concurrency: embedded PostgreSQL, many connections.
// ---------------------------------------------------------------------------

function embeddedBinary(name: string): string {
  const pkg = process.platform === "win32" ? "windows-x64" : "linux-x64";
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  return path.join(repoRoot, "node_modules", "@embedded-postgres", pkg, "native", "bin", exe);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function embeddedPostgres(t: TestContext) {
  if (!existsSync(embeddedBinary("initdb")) || !existsSync(embeddedBinary("postgres"))) {
    t.skip("embedded PostgreSQL binaries are not installed here — the concurrency proof needs a real multi-connection server");
    return null;
  }
  const root = mkdtempSync(path.join(tmpdir(), "wy-claim-pg-"));
  const dataDir = path.join(root, "pgdata");
  const port = await freePort();
  const pwFile = path.join(root, ".pw");
  writeFileSync(pwFile, "arena-test", { mode: 0o600 });
  const init = spawnSync(
    embeddedBinary("initdb"),
    ["-D", dataDir, "-U", "arena", "--pwfile", pwFile, "-E", "UTF8", "--locale", "C", "-A", "scram-sha-256"],
    { encoding: "utf8", timeout: 120_000 },
  );
  rmSync(pwFile, { force: true });
  if (init.status !== 0) throw new Error(`initdb failed (${init.status}): ${(init.stdout ?? "") + (init.stderr ?? "")}`.slice(0, 2000));
  const postgresProcess: ChildProcess = spawn(
    embeddedBinary("postgres"),
    ["-D", dataDir, "-p", String(port), "-h", "127.0.0.1", "-F", "-c", "max_connections=50"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const { Client, Pool } = await import("pg");
  const { waitForPostgresReady } = await import("../library/pg-readiness");
  await waitForPostgresReady({
    createClient: () => new Client({ connectionString: `postgresql://arena:arena-test@127.0.0.1:${port}/postgres` }),
    useConnectedClient: async (admin) => {
      await admin.query("create database arena_claim_test");
    },
  });
  const connectionString = `postgresql://arena:arena-test@127.0.0.1:${port}/arena_claim_test`;
  const migrator = new Client({ connectionString });
  await migrator.connect();
  const { applyMigrations } = await import("../../../../desktop/runtime/migrate");
  await applyMigrations({ client: migrator, migrationsDir: path.join(repoRoot, "desktop-migrations") });
  await migrator.end();

  const pool = new Pool({ connectionString, max: 24 });
  const database = drizzlePg(pool) as unknown as SeparationDb;
  return {
    database,
    async close() {
      await pool.end().catch(() => undefined);
      spawnSync(embeddedBinary("pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "-t", "20", "stop"], { timeout: 30_000 });
      if (postgresProcess.exitCode === null) postgresProcess.kill();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("concurrent requests on real PostgreSQL never create two active attempts for one target", async (t) => {
  const pg = await embeddedPostgres(t);
  if (pg === null) return;
  try {
    const { project, source } = await seedProjectAndSource(pg.database);
    const key = `separation-deep:${source.id}`;
    const burst = 16;

    // 1. Sixteen simultaneous first requests → exactly one job; every other
    //    caller is refused and told which job holds the target.
    const outcomes = await Promise.all(
      Array.from({ length: burst }, () => claimProcessingJob(pg.database, deepJobValues(project.id, source.id, key))),
    );
    const created = outcomes.filter((outcome) => outcome.created);
    assert.equal(created.length, 1, `exactly one created, got ${created.length}`);
    const winner = created[0].created ? created[0].job : null;
    for (const outcome of outcomes) {
      if (outcome.created) continue;
      assert.equal(outcome.active?.id, winner?.id, "every refusal names the winning attempt");
    }
    const activeRows = async () =>
      pg.database
        .select()
        .from(processingJobs)
        .where(and(eq(processingJobs.idempotencyKey, key), processingJobIsActive(processingJobs.status)));
    assert.equal((await activeRows()).length, 1);

    // 2. The attempt fails. Sixteen simultaneous retries-by-request → exactly
    //    one FRESH row; the failed one stays as history.
    await pg.database
      .update(processingJobs)
      .set({ status: "failed", stage: "failed", errorCode: "separation_failed", completedAt: new Date() })
      .where(eq(processingJobs.id, winner!.id));
    const second = await Promise.all(
      Array.from({ length: burst }, () => claimProcessingJob(pg.database, deepJobValues(project.id, source.id, key))),
    );
    const fresh = second.filter((outcome) => outcome.created);
    assert.equal(fresh.length, 1);
    const freshJob = fresh[0].created ? fresh[0].job : null;
    assert.notEqual(freshJob?.id, winner?.id, "a new attempt, not the failed row");
    assert.equal((await activeRows()).length, 1);
    const all = await pg.database.select().from(processingJobs).where(eq(processingJobs.idempotencyKey, key));
    assert.deepEqual(all.map((row) => row.status).sort(), ["failed", "queued"]);

    // 3. The fresh attempt completes; now a retry of the OLD failed row races
    //    a brand-new claim for the same target. Whichever wins, there is
    //    never more than one active row — the index arbitrates the UPDATE
    //    (unique_violation → honest reason) exactly as it does the INSERT.
    await pg.database
      .update(processingJobs)
      .set({ status: "complete", stage: "complete", completedAt: new Date() })
      .where(eq(processingJobs.id, freshJob!.id));
    process.env.ARENA_DESKTOP_MODE = "1";
    resetLocalJobBrokerForTests();
    getLocalJobBroker().register(SEPARATION_QUEUE, async () => undefined);
    try {
      // Server-mode flavour: the hand-off stands in for BullMQ's
      // queueJob.retry(); it must run only when the retry actually owns the
      // key, and must see the row already claimed.
      let handOffs = 0;
      let handOffsOnQueuedRow = 0;
      const serverHandOff = async (row: { id: string }) => {
        handOffs += 1;
        const [current] = await pg.database.select().from(processingJobs).where(eq(processingJobs.id, row.id));
        if (current.status === "queued") handOffsOnQueuedRow += 1;
      };
      const settle = async (ids: string[]) =>
        pg.database
          .update(processingJobs)
          .set({ status: "failed", stage: "failed", errorCode: "separation_failed", completedAt: new Date() })
          .where(inArray(processingJobs.id, ids));
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      let serverRetryWins = 0;
      let serverRounds = 0;
      // Free-running races. The retry needs three round trips before its
      // claim, the fresh claim one, so the claim is handicapped by a few
      // random milliseconds to make both orderings happen.
      for (let round = 0; round < 12; round += 1) {
        const serverMode = round % 2 === 1;
        if (serverMode) serverRounds += 1;
        const retryRun: Promise<RetryOutcome> = retrySeparationJob(
          pg.database,
          winner!.id,
          serverMode ? { handOff: serverHandOff } : {},
        );
        const claimRun: Promise<ClaimOutcome> = sleep(Math.random() * 6).then(() =>
          claimProcessingJob(pg.database, deepJobValues(project.id, source.id, key)),
        );
        const retried: RetryOutcome = await retryRun;
        const claimed: ClaimOutcome = await claimRun;
        const active = await activeRows();
        assert.equal(active.length, 1, `round ${round}: one active row (retry ${retried.queued}, claim ${claimed.created})`);
        assert.equal(
          [retried.queued, claimed.created].filter(Boolean).length,
          1,
          `round ${round}: exactly one of them won — retry: ${JSON.stringify(retried)}, claim: ${claimed.created}`,
        );
        if (retried.queued) {
          if (serverMode) serverRetryWins += 1;
          assert.equal(active[0].id, winner!.id, `round ${round}: the retried row is the active one`);
          assert.equal(claimed.created, false);
          if (!claimed.created) assert.equal(claimed.active?.id, winner!.id, "the losing claim names the retried row");
        } else {
          assert.equal(retried.kind, "newer-attempt");
          assert.match(retried.reason, /newer attempt/);
        }
        await settle(active.map((row) => row.id));
      }
      assert.equal(handOffs, serverRetryWins, "the server-mode hand-off ran exactly when the retry owned the key — a losing retry never reaches BullMQ");
      assert.equal(handOffsOnQueuedRow, handOffs, "and always on an already-claimed row");
      t.diagnostic(`retry-vs-claim race: server-mode retry won ${serverRetryWins}/${serverRounds} rounds, hand-offs ${handOffs}`);

      // 4. Deterministic interleaving, server mode: the fresh claim arrives
      //    WHILE the retry is inside its hand-off (row claimed, BullMQ being
      //    asked). It must lose and name the retried row.
      const handOffsBefore = handOffs;
      const during: { claim: ClaimOutcome | null } = { claim: null };
      const retried = await retrySeparationJob(pg.database, winner!.id, {
        handOff: async (row) => {
          await serverHandOff(row);
          during.claim = await claimProcessingJob(pg.database, deepJobValues(project.id, source.id, key));
        },
      });
      assert.deepEqual(retried, { queued: true });
      assert.equal(handOffs, handOffsBefore + 1);
      const claimDuringHandOff = during.claim;
      assert.ok(claimDuringHandOff !== null, "the claim ran inside the hand-off");
      assert.equal(claimDuringHandOff.created, false, "a claim that arrives during the hand-off is refused");
      if (!claimDuringHandOff.created) assert.equal(claimDuringHandOff.active?.id, winner!.id);
      assert.equal((await activeRows()).length, 1);
      await settle([winner!.id]);

      // 5. And the mirror image: the fresh claim lands first; the server-mode
      //    retry must refuse WITHOUT ever invoking the hand-off.
      const fresh = await claimProcessingJob(pg.database, deepJobValues(project.id, source.id, key));
      assert.equal(fresh.created, true);
      const lost = await retrySeparationJob(pg.database, winner!.id, { handOff: serverHandOff });
      assert.equal(lost.queued === false && lost.kind, "newer-attempt");
      assert.equal(handOffs, handOffsBefore + 1, "the hand-off did not run for the losing retry");
      assert.equal((await activeRows()).length, 1);
    } finally {
      resetLocalJobBrokerForTests();
      delete process.env.ARENA_DESKTOP_MODE;
    }
  } finally {
    await pg.close();
  }
});
