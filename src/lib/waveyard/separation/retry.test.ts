/**
 * Separation retry tests — the durable-row half of the retry story, proven
 * on a PGlite database with the local broker in desktop mode (a stub
 * handler records what would be executed). What is proven: a failed job is
 * re-enqueued with a payload rebuilt from its own row and reset ONLY after
 * the queue accepts it; non-failed jobs are refused; the post-seed sweep
 * touches only this model's jobs in retryable states; a queue that cannot
 * accept the job leaves the row honestly failed.
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
import { requeueFailedSeparationsForModel, retrySeparationJob, type SeparationDb } from "./retry";

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

  async function addJob(overrides: { model?: string; status?: string; errorCode?: string | null } = {}) {
    const model = overrides.model ?? "kim_vocal_2";
    const [row] = await database
      .insert(processingJobs)
      .values({
        projectId: project.id,
        sourceAssetId: source.id,
        type: "separation",
        status: overrides.status ?? "failed",
        stage: "failed",
        errorCode: overrides.errorCode ?? "separation_unavailable",
        errorMessage: "model not present",
        idempotencyKey: `separation:${source.id}:${model}:${randomUUID()}`,
        model,
        requestedDevice: "auto",
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

test("a failed separation job is re-enqueued from its own row and reset only after acceptance", async () => {
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
    assert.equal(row.status, "failed", "row untouched when the queue refused");
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
