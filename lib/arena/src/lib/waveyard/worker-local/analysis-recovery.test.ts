import "./_separation-test-env";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { applyDesktopMigrationsToPGlite } from "./pglite-migrations.test-helper";
import { projects, sourceAnalyses, sourceAssets, sourceSectionAnalyses } from "@workspace/db/waveyardSchema";
import {
  recoverPendingLocalSourceAnalyses,
  recoverPendingLocalSourceSectionAnalyses,
} from "./recovery";

async function fixture() {
  const client = new PGlite();
  const arenaRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  await applyDesktopMigrationsToPGlite(client, join(arenaRoot, "desktop-migrations"));
  const db = drizzle(client);
  const [project] = await db.insert(projects).values({ ownerId: randomUUID(), title: "Analysis recovery" }).returning();
  const [source] = await db.insert(sourceAssets).values({
    projectId: project.id,
    originalFilename: "restart.wav",
    mimeType: "audio/wav",
    storageKey: `projects/${project.id}/restart.wav`,
    checksumSha256: "a".repeat(64),
    durationSeconds: 8,
    sampleRate: 44_100,
    channels: 2,
    codec: "pcm_s16le",
    fileSizeBytes: 705_600,
  }).returning();
  const [analysis] = await db.insert(sourceAnalyses).values({
    projectId: project.id,
    sourceAssetId: source.id,
    status: "processing",
    stage: "analyzing",
    idempotencyKey: `analysis:${source.id}:${randomUUID()}`,
    analysisEngine: "arena-js-dsp",
    analysisEngineVersion: "1.4.0",
    sourceChecksumSha256: source.checksumSha256,
    startedAt: new Date(),
  }).returning();
  const [section] = await db.insert(sourceSectionAnalyses).values({
    projectId: project.id,
    sourceAssetId: source.id,
    sourceAnalysisId: analysis.id,
    status: "preparing",
    stage: "preparing",
    idempotencyKey: `sections:${source.id}:${randomUUID()}`,
    analysisEngine: "arena-js-structure",
    analysisEngineVersion: "1.0.0",
    sourceChecksumSha256: source.checksumSha256,
    startedAt: new Date(),
  }).returning();
  return { client, db, analysis, section };
}

test("local restart recovery requeues active source and section analyses from durable rows", async () => {
  const f = await fixture();
  try {
    const sourcePayloads: unknown[] = [];
    const sectionPayloads: unknown[] = [];
    const sourceResult = await recoverPendingLocalSourceAnalyses(f.db, async (payload) => { sourcePayloads.push(payload); });
    const sectionResult = await recoverPendingLocalSourceSectionAnalyses(f.db, async (payload) => { sectionPayloads.push(payload); });
    assert.deepEqual(sourceResult, { requeuedJobIds: [f.analysis.id], failedJobIds: [] });
    assert.deepEqual(sectionResult, { requeuedJobIds: [f.section.id], failedJobIds: [] });
    assert.deepEqual(sourcePayloads, [{
      sourceAnalysisId: f.analysis.id,
      projectId: f.analysis.projectId,
      sourceAssetId: f.analysis.sourceAssetId,
      analysisEngine: f.analysis.analysisEngine,
      analysisEngineVersion: f.analysis.analysisEngineVersion,
    }]);
    assert.deepEqual(sectionPayloads, [{
      sourceSectionAnalysisId: f.section.id,
      projectId: f.section.projectId,
      sourceAssetId: f.section.sourceAssetId,
      sourceAnalysisId: f.section.sourceAnalysisId,
      analysisEngine: f.section.analysisEngine,
      analysisEngineVersion: f.section.analysisEngineVersion,
    }]);
    const [analysis] = await f.db.select().from(sourceAnalyses).where(eq(sourceAnalyses.id, f.analysis.id));
    const [section] = await f.db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.id, f.section.id));
    assert.equal(analysis.status, "queued");
    assert.equal(analysis.startedAt, null);
    assert.match(analysis.stage, /^recovery-submitting:/);
    assert.equal(section.status, "queued");
    assert.equal(section.startedAt, null);
    assert.match(section.stage, /^recovery-submitting:/);
  } finally { await f.client.close(); }
});

test("queue refusal marks only an unclaimed recovery row failed", async () => {
  const f = await fixture();
  try {
    const failed = await recoverPendingLocalSourceAnalyses(f.db, async () => { throw new Error("queue offline"); });
    assert.deepEqual(failed, { requeuedJobIds: [], failedJobIds: [f.analysis.id] });
    const [row] = await f.db.select().from(sourceAnalyses).where(eq(sourceAnalyses.id, f.analysis.id));
    assert.equal(row.status, "failed");
    assert.equal(row.errorCode, "queue_unavailable");

    await f.db.update(sourceSectionAnalyses).set({ status: "processing", stage: "analyzing" })
      .where(eq(sourceSectionAnalyses.id, f.section.id));
    const advanced = await recoverPendingLocalSourceSectionAnalyses(f.db, async () => {
      await f.db.update(sourceSectionAnalyses).set({ status: "complete", stage: "complete" })
        .where(eq(sourceSectionAnalyses.id, f.section.id));
      throw new Error("late acknowledgement error");
    });
    assert.deepEqual(advanced, { requeuedJobIds: [f.section.id], failedJobIds: [] });
    const [completed] = await f.db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.id, f.section.id));
    assert.equal(completed.status, "complete");
  } finally { await f.client.close(); }
});
