import "./_separation-test-env";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { applyDesktopMigrationsToPGlite } from "./pglite-migrations.test-helper";
import { projects, processingJobs, sourceAssets, stemAssets, bassAnalyses, bassEvents, bassPitchSegments } from "@workspace/db/waveyardSchema";
import { ensureBassAnalysis } from "../bass-analysis";
import { LOCAL_BASS_ANALYSIS_ENGINE, LOCAL_BASS_ANALYSIS_ENGINE_VERSION } from "../types/bass-analysis";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
// The durable-analysis helpers refuse to queue unless this process is allowed to
// run the local worker. Without it the ensure path short-circuits before the
// reanalysis logic this test exists to cover.
process.env.WAVEYARD_LOCAL_WORKER = "1";

/**
 * Reanalysis and replacement.
 *
 * A 1.0.0 bass analysis recorded attacks with no pitch. Once pitch participates in
 * selection, leaving those rows marked merely "stale" would mean every existing
 * project silently loses its harmonic foundation forever. They must be reset and
 * reanalyzed -- but only when the bytes are the same. Different bytes are a
 * different source, not an older analysis.
 */
test("a superseded bass analysis is reanalyzed, but a different source is refused", async () => {
  const client = new PGlite();
  try {
    await applyDesktopMigrationsToPGlite(client, join(repoRoot, "desktop-migrations"));
    const db = drizzle(client) as unknown as Parameters<typeof ensureBassAnalysis>[0];
    const [project] = await db.insert(projects).values({ ownerId: randomUUID(), title: "Bass reanalysis" }).returning();
    const [source] = await db.insert(sourceAssets).values({
      projectId: project.id, originalFilename: "s.wav", mimeType: "audio/wav", storageKey: `k/${randomUUID()}`,
      checksumSha256: "a".repeat(64), durationSeconds: 8, sampleRate: 22_050, channels: 2,
      codec: "pcm_s16le", fileSizeBytes: 100,
    }).returning();
    const [separation] = await db.insert(processingJobs).values({
      projectId: project.id, sourceAssetId: source.id, type: "separation",
      model: "test", requestedDevice: "cpu", idempotencyKey: `sep:${source.id}`,
    }).returning();
    const [stem] = await db.insert(stemAssets).values({
      projectId: project.id, sourceAssetId: source.id, separationJobId: separation.id,
      stemType: "bass", engine: "test", model: "m",
      modelVersion: "1", storageKey: `k/${randomUUID()}`, checksumSha256: "b".repeat(64),
      durationSeconds: 8, sampleRate: 22_050, channels: 2, codec: "pcm_s16le", format: "wav", fileSizeBytes: 100,
    }).returning();
    const sourceIdentity = { id: source.id, projectId: project.id, checksumSha256: source.checksumSha256 };
    const stemIdentity = {
      id: stem.id, projectId: project.id, sourceAssetId: source.id,
      stemType: "bass", checksumSha256: stem.checksumSha256,
    };

    // An older-engine analysis that carries no pitch.
    const [legacy] = await db.insert(bassAnalyses).values({
      projectId: project.id, sourceAssetId: source.id, stemAssetId: stem.id,
      status: "complete", stage: "complete", idempotencyKey: `bass-attacks:${stem.id}:legacy`,
      analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE, analysisEngineVersion: "1.0.0",
      sourceChecksumSha256: source.checksumSha256, stemChecksumSha256: stem.checksumSha256,
    }).returning();
    await db.insert(bassEvents).values({
      bassAnalysisId: legacy.id, eventIndex: 0, timestampMs: 100, strength: 0.8, confidence: 0.9,
    });
    assert.equal((await db.select().from(bassPitchSegments).where(eq(bassPitchSegments.bassAnalysisId, legacy.id))).length, 0);

    const queued: unknown[] = [];
    const result = await ensureBassAnalysis(db, sourceIdentity, stemIdentity, async (payload) => {
      queued.push(payload);
    });

    // Reset to the current engine, requeued, and the superseded evidence dropped.
    assert.equal(result.stale, false);
    assert.equal(result.queued, true);
    assert.equal(result.analysis!.analysisEngineVersion, LOCAL_BASS_ANALYSIS_ENGINE_VERSION);
    assert.equal(result.analysis!.id, legacy.id, "the same analysis row is reused, not duplicated");
    assert.equal(queued.length, 1, "the refreshed analysis is actually enqueued");
    assert.equal((await db.select().from(bassEvents).where(eq(bassEvents.bassAnalysisId, legacy.id))).length, 0,
      "evidence from the superseded analysis must not survive");
    assert.equal((await db.select().from(bassAnalyses).where(eq(bassAnalyses.stemAssetId, stem.id))).length, 1);

    // Now a source whose BYTES changed. That is a different source, not an older
    // analysis, and must not be silently reanalysed as if it were the same music.
    const changedSource = { ...sourceIdentity, checksumSha256: "c".repeat(64) };
    const refused = await ensureBassAnalysis(db, changedSource, stemIdentity, async () => {
      throw new Error("must not enqueue for a different source");
    });
    assert.equal(refused.stale, true);
    assert.equal(refused.queued, false);
  } finally {
    await client.close();
  }
});
