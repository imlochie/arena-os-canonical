/**
 * Separation retry tests — the durable-row half of the retry story, proven
 * on a PGlite database with the local broker in desktop mode (a stub
 * handler records what would be executed). What is proven: a failed job is
 * re-enqueued with a payload rebuilt from its own row (a layer job keeps
 * its parent stem) and the row is claimed BEFORE the queue is asked, then
 * restored exactly if the queue refuses; non-failed jobs are refused; a
 * failed row is never resurrected while a newer attempt at the same target
 * is active (one active job per target, see claim.ts), and is retryable
 * again once that attempt is over; the post-seed sweep touches only this
 * model's jobs in retryable states. The server-mode flavour follows the
 * SAME order: the hand-off runs only after the row is claimed, never when a
 * newer attempt holds the target, and a failing hand-off restores the row.
 * serverQueueHandOff itself is proven against a fake BullMQ queue: a
 * `queue_unavailable` row with NO queue record is retried by a FRESH
 * submission (claimed first), a finished record is retried in place, a
 * record BullMQ still holds is left alone, and a Redis that never answers
 * is a bounded refusal with the row restored.
 */

import "../worker-local/_separation-test-env";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { processingJobs, projects, sourceAssets } from "@/db/waveyardSchema";
import { SEPARATION_QUEUE } from "@/lib/waveyard/queue";
import { getLocalJobBroker, resetLocalJobBrokerForTests } from "@/lib/waveyard/worker-local/broker";
import type { QueueJobLike, QueueLike } from "@/lib/waveyard/queue";
import type { ProcessingJobRow } from "./claim";
import { requeueFailedSeparationsForModel, retrySeparationJob, serverQueueHandOff, type SeparationDb } from "./retry";

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const client = new PGlite();
  const { applyMigrations } = await import("../../../../desktop/runtime/migrate");
  const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  await applyMigrations({ client: client as unknown as import("pg").Client, migrationsDir: join(repoRoot, "desktop-migrations") });
  const database = drizzle(client) as unknown as SeparationDb;

  const [project] = await database
    .insert(projects)
    .values({ ownerId: randomUUID(), title: "Retry E2E" })
    .returning();
  const [source] = await database
    .insert(sourceAssets)
    .values({
      projectId: project.id,
      originalFilename: "source.wav",
      mimeType: "audio/wav",
      storageKey: "projects/x/source/uuid.wav",
      checksumSha256: "0".repeat(64),
      durationSeconds: 1,
      sampleRate: 44_100,
      channels: 2,
      codec: "pcm_s16le",
      fileSizeBytes: 176_400,
    })
    .returning();

  const submitted: Array<{ jobId: string; payload: Record<string, unknown> }> = [];
  const broker = getLocalJobBroker();
  broker.register(SEPARATION_QUEUE, async (payload) => {
    submitted.push({ jobId: String(payload.processingJobId), payload });
  });

  async function addJob(
    overrides: { model?: string; status?: string; stage?: string; errorCode?: string | null; errorMessage?: string; idempotencyKey?: string; metadata?: string } = {},
  ) {
    const model = overrides.model ?? "kim_vocal_2";
    const status = overrides.status ?? "failed";
    const failed = status === "failed";
    const [row] = await database
      .insert(processingJobs)
      .values({
        projectId: project.id,
        sourceAssetId: source.id,
        type: "separation",
        status,
        stage: overrides.stage ?? (failed ? "failed" : status),
        errorCode: failed ? (overrides.errorCode ?? "separation_unavailable") : null,
        errorMessage: failed ? (overrides.errorMessage ?? "model not present") : null,
        completedAt: failed || status === "complete" ? new Date() : null,
        idempotencyKey: overrides.idempotencyKey ?? `separation:${source.id}:${model}:${randomUUID()}`,
        model,
        requestedDevice: "auto",
        ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
      })
      .returning();
    return row;
  }

  return {
    database,
    project,
    source,
    submitted,
    addJob,
    async close() {
      resetLocalJobBrokerForTests();
      await client.close();
    },
  };
}

const ENV_KEYS = ["ARENA_DESKTOP_MODE", "REDIS_URL"] as const;

test.beforeEach(() => {
  process.env.ARENA_DESKTOP_MODE = "1";
  delete process.env.REDIS_URL;
  resetLocalJobBrokerForTests();
});

test.afterEach(() => {
  delete process.env.ARENA_DESKTOP_MODE;
});

test("a failed separation job is re-enqueued from its own row (claimed first, then handed to the queue)", async () => {
  const f = await fixture();
  try {
    const job = await f.addJob();
    const result = await retrySeparationJob(f.database, job.id);
    assert.deepEqual(result, { queued: true });
    assert.equal(f.submitted.length, 1, "the local broker received the job");
    assert.equal(f.submitted[0].payload.model, "kim_vocal_2");
    assert.equal(f.submitted[0].payload.projectId, f.project.id);
    assert.equal(f.submitted[0].payload.sourceAssetId, f.source.id);
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    assert.equal(row.status, "queued");
    assert.equal(row.stage, "queued");
    assert.equal(row.errorCode, null);
    assert.equal(row.completedAt, null);
  } finally {
    await f.close();
  }
});

test("non-failed and non-separation jobs are refused; a missing job is not found", async () => {
  const f = await fixture();
  try {
    const complete = await f.addJob({ status: "complete" });
    assert.equal((await retrySeparationJob(f.database, complete.id)).queued, false);
    assert.equal((await retrySeparationJob(f.database, randomUUID())).queued, false);
    assert.equal(f.submitted.length, 0, "nothing was enqueued");
  } finally {
    await f.close();
  }
});

test("a queue that cannot accept the job leaves the row honestly failed", async () => {
  const f = await fixture();
  try {
    // No handler registered for the separation queue on this broker.
    resetLocalJobBrokerForTests();
    const job = await f.addJob();
    const result = await retrySeparationJob(f.database, job.id);
    assert.equal(result.queued, false);
    assert.match(result.reason, /no local executor/);
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    assert.equal(row.status, "failed", "row back to failed when the queue refused");
    assert.equal(row.stage, "failed");
    assert.equal(row.errorCode, "separation_unavailable", "the original failure stays visible…");
    assert.equal(row.errorMessage, "model not present");
    assert.ok(row.completedAt !== null);
    assert.equal((await retrySeparationJob(f.database, job.id)).queued, false, "…and nothing is left 'queued' that no executor holds");
  } finally {
    await f.close();
  }
});

test("a retried layer job carries its parent stem in the payload again", async () => {
  const f = await fixture();
  try {
    const parentStemAssetId = randomUUID();
    const job = await f.addJob({
      model: "deep_6s",
      metadata: JSON.stringify({ kind: "deep-layers", parentStemAssetId, parentStemType: "other" }),
    });
    assert.deepEqual(await retrySeparationJob(f.database, job.id), { queued: true });
    assert.equal(f.submitted[0]?.payload.parentStemAssetId, parentStemAssetId, "without it the retry would separate the whole source");
    const whole = await f.addJob();
    await retrySeparationJob(f.database, whole.id);
    assert.equal("parentStemAssetId" in (f.submitted[1]?.payload ?? {}), false, "a whole-song job carries none");
  } finally {
    await f.close();
  }
});

test("a failed row is not resurrected while a newer attempt at its target is active — and is retryable once that attempt is over", async () => {
  const f = await fixture();
  try {
    const key = `separation-deep:${randomUUID()}`;
    const earlier = await f.addJob({ model: "deep_6s", idempotencyKey: key });
    const newer = await f.addJob({ model: "deep_6s", idempotencyKey: key, status: "processing" });

    const refused = await retrySeparationJob(f.database, earlier.id);
    assert.equal(refused.queued, false);
    assert.match(refused.reason, /newer attempt .* already running/);
    assert.equal(f.submitted.length, 0, "nothing was enqueued");
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, earlier.id));
    assert.equal(row.status, "failed", "the old row is untouched");

    // Even if the pre-check is skipped by timing, the database refuses the
    // resurrection itself: the active-only unique index makes the UPDATE a
    // unique_violation, which the retry reports as the same honest reason.
    await assert.rejects(
      () =>
        f.database
          .update(processingJobs)
          .set({ status: "queued" })
          .where(eq(processingJobs.id, earlier.id)),
      (error: unknown) => {
        assert.match(error instanceof Error ? error.message + String((error as { cause?: unknown }).cause ?? "") : "", /processing_jobs_active_idempotency_unique/);
        return true;
      },
    );

    await f.database
      .update(processingJobs)
      .set({ status: "failed", stage: "failed", errorCode: "separation_failed", completedAt: new Date() })
      .where(eq(processingJobs.id, newer.id));
    assert.deepEqual(await retrySeparationJob(f.database, earlier.id), { queued: true }, "the key is free again");
    assert.equal(f.submitted.length, 1);
    assert.equal((await retrySeparationJob(f.database, newer.id)).queued, false, "…and now the OTHER failed row is the one that must wait");
  } finally {
    await f.close();
  }
});

test("the post-seed sweep requeues ONLY this model's retryable failures", async () => {
  const f = await fixture();
  try {
    const modelMissing = await f.addJob({ errorCode: "separation_unavailable" });
    const queueMissing = await f.addJob({ errorCode: "queue_unavailable" });
    const realFailure = await f.addJob({ errorCode: "separation_failed" });
    const otherModel = await f.addJob({ model: "some_other_model", errorCode: "separation_unavailable" });

    const sweep = await requeueFailedSeparationsForModel(f.database, "kim_vocal_2");
    assert.equal(sweep.considered, 2);
    assert.equal(sweep.requeued, 2);
    assert.deepEqual(sweep.failures, []);

    const statuses = await f.database.select().from(processingJobs);
    const byId = new Map(statuses.map((row) => [row.id, row]));
    assert.equal(byId.get(modelMissing.id)!.status, "queued");
    assert.equal(byId.get(queueMissing.id)!.status, "queued");
    assert.equal(byId.get(realFailure.id)!.status, "failed", "a real separation failure is not blindly retried");
    assert.equal(byId.get(otherModel.id)!.status, "failed", "other models' jobs are not touched");
    assert.equal(f.submitted.length, 2);
  } finally {
    await f.close();
  }
});

test("server-mode hand-off: invoked only AFTER the row is claimed, never when a newer attempt holds the target, restored when it fails", async () => {
  const f = await fixture();
  try {
    // 1. The hand-off sees a row that is already queued — the claim came first.
    const job = await f.addJob();
    const seenAtHandOff: string[] = [];
    const result = await retrySeparationJob(f.database, job.id, {
      handOff: async (row) => {
        const [current] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, row.id));
        seenAtHandOff.push(current.status);
      },
    });
    assert.deepEqual(result, { queued: true });
    assert.deepEqual(seenAtHandOff, ["queued"], "the executor is asked only once the row is ours");
    assert.equal(f.submitted.length, 0, "the injected hand-off replaced the local broker entirely");

    // 2. A newer attempt holds the target: the hand-off is NEVER invoked
    //    (this is the race the server route used to lose — it had already
    //    asked BullMQ to retry before the database said no).
    const key = `separation-deep:${randomUUID()}`;
    const earlier = await f.addJob({ model: "deep_6s", idempotencyKey: key });
    await f.addJob({ model: "deep_6s", idempotencyKey: key, status: "queued" });
    let handOffs = 0;
    const refused = await retrySeparationJob(f.database, earlier.id, { handOff: async () => { handOffs += 1; } });
    assert.equal(refused.queued, false);
    if (refused.queued) return;
    assert.equal(refused.kind, "newer-attempt");
    assert.equal(handOffs, 0, "nothing was handed to the queue");
    const [untouched] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, earlier.id));
    assert.equal(untouched.status, "failed");

    // 3. The hand-off throws (BullMQ refused / record gone): the row is
    //    restored exactly, and the outcome says the queue refused.
    const other = await f.addJob({ errorCode: "separation_unavailable" });
    const failed = await retrySeparationJob(f.database, other.id, {
      handOff: async () => {
        throw new Error("Job is not in the failed state");
      },
    });
    assert.equal(failed.queued, false);
    if (failed.queued) return;
    assert.equal(failed.kind, "queue-refused");
    assert.match(failed.reason, /not in the failed state/);
    const [restored] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, other.id));
    assert.equal(restored.status, "failed");
    assert.equal(restored.stage, "failed");
    assert.equal(restored.errorCode, "separation_unavailable");
    assert.equal(restored.errorMessage, "model not present");
    assert.ok(restored.completedAt !== null);

    // 4. The outcome kinds the route maps to status codes.
    const complete = await f.addJob({ status: "complete" });
    const notRetryable = await retrySeparationJob(f.database, complete.id);
    assert.equal(notRetryable.queued === false && notRetryable.kind, "not-retryable");
    const missing = await retrySeparationJob(f.database, randomUUID());
    assert.equal(missing.queued === false && missing.kind, "not-found");
  } finally {
    await f.close();
  }
});

/** A stand-in for the BullMQ queue API the server hand-off touches. */
function fakeQueue(record: { state: string; retryError?: Error } | null, lookup: "answers" | "hangs" = "answers") {
  const calls = { getJob: 0, getState: 0, retry: [] as string[] };
  const job: QueueJobLike | null = record
    ? {
        async getState() {
          calls.getState += 1;
          return record.state;
        },
        async retry(state?: "completed" | "failed") {
          calls.retry.push(state ?? "failed");
          if (record.retryError) throw record.retryError;
        },
        async remove() {},
      }
    : null;
  const queue: Pick<QueueLike, "getJob"> = {
    getJob() {
      calls.getJob += 1;
      if (lookup === "hangs") return new Promise(() => undefined);
      return Promise.resolve(job ?? undefined);
    },
  };
  return { queue, calls };
}

test("server mode: a queue_unavailable row with NO queue record is retried by a FRESH submission — claimed first", async () => {
  const f = await fixture();
  try {
    // The row startSeparationJob leaves behind when Redis was unreachable
    // (or REDIS_URL unset) at request time: no BullMQ record was ever made.
    const parentStemAssetId = randomUUID();
    const job = await f.addJob({
      model: "deep_6s",
      stage: "queue-unavailable",
      errorCode: "queue_unavailable",
      errorMessage: "Queue unavailable: Redis is not reachable.",
      metadata: JSON.stringify({ kind: "deep-layers", parentStemAssetId }),
    });
    const { queue, calls } = fakeQueue(null);
    const submissions: Array<{ status: string; row: ProcessingJobRow }> = [];
    const result = await retrySeparationJob(f.database, job.id, {
      handOff: serverQueueHandOff(queue, {
        enqueue: async (row) => {
          const [current] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, row.id));
          submissions.push({ status: current.status, row });
        },
      }),
    });
    assert.deepEqual(result, { queued: true }, "retryable through the button, not only via a brand-new request");
    assert.equal(calls.getJob, 1, "the record was looked up…");
    assert.deepEqual(calls.retry, [], "…and nothing was retried in place: there was nothing to retry");
    assert.equal(submissions.length, 1, "one fresh submission");
    assert.equal(submissions[0].status, "queued", "the row was claimed BEFORE the fresh enqueue");
    assert.equal(submissions[0].row.id, job.id, "rebuilt from the row…");
    assert.equal(JSON.parse(submissions[0].row.metadata ?? "{}").parentStemAssetId, parentStemAssetId, "…with its layer target");
    const [after] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    assert.equal(after.status, "queued");
    assert.equal(after.errorCode, null);
    assert.equal(f.submitted.length, 0, "the local broker was not involved — this is the server flavour");
  } finally {
    await f.close();
  }
});

test("server mode: an existing FINISHED record is retried in place — no fresh submission", async () => {
  const f = await fixture();
  try {
    for (const state of ["failed", "completed"] as const) {
      const job = await f.addJob();
      const { queue, calls } = fakeQueue({ state });
      let fresh = 0;
      const result = await retrySeparationJob(f.database, job.id, {
        handOff: serverQueueHandOff(queue, { enqueue: async () => { fresh += 1; } }),
      });
      assert.deepEqual(result, { queued: true }, state);
      assert.deepEqual(calls.retry, [state], `retry() is told the record's actual finished state (${state})`);
      assert.equal(fresh, 0, "no duplicate submission beside the existing record");
    }
  } finally {
    await f.close();
  }
});

test("server mode: a record BullMQ still holds (waiting / delayed / active) is left alone — the claimed row is honestly queued", async () => {
  const f = await fixture();
  try {
    for (const state of ["waiting", "delayed", "active", "prioritized"]) {
      const job = await f.addJob();
      const { queue, calls } = fakeQueue({ state });
      let fresh = 0;
      const handOff = serverQueueHandOff(queue, { enqueue: async () => { fresh += 1; } });
      let outcome: string | null = null;
      const result = await retrySeparationJob(f.database, job.id, {
        handOff: async (row) => {
          outcome = await handOff(row);
        },
      });
      assert.deepEqual(result, { queued: true }, state);
      assert.equal(outcome, "already-queued");
      assert.deepEqual(calls.retry, [], `no retry() on a ${state} record`);
      assert.equal(fresh, 0, `no second submission for a ${state} record`);
    }
  } finally {
    await f.close();
  }
});

test("server mode: a Redis that never answers is a bounded refusal — the claimed row is restored, never held hostage", async () => {
  const f = await fixture();
  try {
    const job = await f.addJob({ errorCode: "queue_unavailable", stage: "queue-unavailable" });
    const { queue } = fakeQueue(null, "hangs");
    const started = Date.now();
    const result = await retrySeparationJob(f.database, job.id, {
      handOff: serverQueueHandOff(queue, { timeoutMs: 60, enqueue: async () => assert.fail("never reached") }),
    });
    assert.ok(Date.now() - started < 5_000, "bounded");
    assert.equal(result.queued, false);
    if (result.queued) return;
    assert.equal(result.kind, "queue-refused");
    assert.match(result.reason, /did not answer within/);
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    assert.equal(row.status, "failed", "restored");
    assert.equal(row.stage, "queue-unavailable");
    assert.equal(row.errorCode, "queue_unavailable", "…and still retryable");

    // A fresh submission that is refused restores the row the same way.
    const { queue: emptyQueue } = fakeQueue(null);
    const refused = await retrySeparationJob(f.database, job.id, {
      handOff: serverQueueHandOff(emptyQueue, {
        enqueue: async () => {
          throw new Error("Queue unavailable: Redis is not reachable.");
        },
      }),
    });
    assert.equal(refused.queued === false && refused.kind, "queue-refused");
    const [again] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    assert.equal(again.status, "failed");
    assert.equal(again.errorCode, "queue_unavailable");
  } finally {
    await f.close();
  }
});
