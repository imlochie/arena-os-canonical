import "./worker-local/_separation-test-env";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { applyDesktopMigrationsToPGlite } from "./worker-local/pglite-migrations.test-helper";
import { projects, sourceAnalyses, sourceAssets } from "@workspace/db/waveyardSchema";
import { retryFailedSourceAnalysis, type SourceAnalysisDb } from "./source-analysis-retry";

async function fixture() {
  const client = new PGlite();
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  await applyDesktopMigrationsToPGlite(client, join(root, "desktop-migrations"));
  const db = drizzle(client) as unknown as SourceAnalysisDb;
  const [project] = await db.insert(projects).values({ ownerId: randomUUID(), title: "Analysis retry" }).returning();
  const [source] = await db.insert(sourceAssets).values({
    projectId: project.id,
    originalFilename: "source.wav",
    mimeType: "audio/wav",
    storageKey: `projects/${project.id}/source.wav`,
    checksumSha256: "1".repeat(64),
    durationSeconds: 1,
    sampleRate: 44_100,
    channels: 2,
    codec: "pcm_s16le",
    fileSizeBytes: 176_400,
  }).returning();
  const [analysis] = await db.insert(sourceAnalyses).values({
    projectId: project.id,
    sourceAssetId: source.id,
    status: "failed",
    stage: "failed",
    analysisEngine: "arena-js-dsp",
    analysisEngineVersion: "1.4.0",
    sourceChecksumSha256: "1".repeat(64),
    errorCode: "analysis_failed",
    analysisError: "temporary failure",
    idempotencyKey: `analysis:${source.id}:${randomUUID()}`,
  }).returning();
  return { client, db, analysis };
}

test("analysis retry claims the durable row before hand-off", async () => {
  const f = await fixture();
  try {
    let observedStatus: string | undefined;
    const result = await retryFailedSourceAnalysis(f.db, f.analysis.id, {
      handOff: async () => {
        const [row] = await f.db.select().from(sourceAnalyses).where(eq(sourceAnalyses.id, f.analysis.id));
        observedStatus = row?.status;
      },
    });
    assert.equal(result.kind, "queued");
    assert.equal(observedStatus, "queued");
    if (result.kind === "queued") {
      assert.equal(result.analysis.errorCode, null);
      assert.equal(result.analysis.completedAt, null);
    }
  } finally { await f.client.close(); }
});

test("queue refusal restores the original failure unless a worker already advanced it", async () => {
  const f = await fixture();
  try {
    const refused = await retryFailedSourceAnalysis(f.db, f.analysis.id, {
      handOff: async () => { throw new Error("queue offline"); },
    });
    assert.equal(refused.kind, "queue-refused");
    const [restored] = await f.db.select().from(sourceAnalyses).where(eq(sourceAnalyses.id, f.analysis.id));
    assert.equal(restored.status, "failed");
    assert.equal(restored.errorCode, "analysis_failed");
    assert.equal(restored.analysisError, "temporary failure");

    const advanced = await retryFailedSourceAnalysis(f.db, f.analysis.id, {
      handOff: async () => {
        await f.db.update(sourceAnalyses).set({ status: "processing", stage: "analyzing" })
          .where(eq(sourceAnalyses.id, f.analysis.id));
        throw new Error("late handoff error");
      },
    });
    assert.equal(advanced.kind, "queued");
    if (advanced.kind === "queued") assert.equal(advanced.analysis.status, "processing");
  } finally { await f.client.close(); }
});

test("only failed analyses can be retried", async () => {
  const f = await fixture();
  try {
    await f.db.update(sourceAnalyses).set({ status: "complete" }).where(eq(sourceAnalyses.id, f.analysis.id));
    assert.equal((await retryFailedSourceAnalysis(f.db, f.analysis.id)).kind, "not-retryable");
    assert.equal((await retryFailedSourceAnalysis(f.db, randomUUID())).kind, "not-found");
  } finally { await f.client.close(); }
});
