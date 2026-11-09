import "./_separation-test-env";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { applyDesktopMigrationsToPGlite } from "./pglite-migrations.test-helper";
import { encodeWav16 } from "@workspace/arena/lib/waveyard/mixer/synth";
import { LocalStorageProvider, privateObjectKey } from "@workspace/arena/lib/waveyard/storage";
import {
  projects, processingJobs, sourceAssets, stemAssets, drumAnalyses, drumEvents,
  harmonyAnalyses, harmonyEvents, vocalAnalyses, vocalPitchFrames,
} from "@workspace/db/waveyardSchema";
import {
  LOCAL_DRUM_ANALYSIS_ENGINE, LOCAL_DRUM_ANALYSIS_ENGINE_VERSION, drumAnalysisIdempotencyKey,
} from "@workspace/arena/lib/waveyard/types/drum-analysis";
import {
  LOCAL_HARMONY_ANALYSIS_ENGINE, LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION, harmonyAnalysisIdempotencyKey,
} from "@workspace/arena/lib/waveyard/types/harmony-analysis";
import {
  LOCAL_VOCAL_ANALYSIS_ENGINE, LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION, vocalAnalysisIdempotencyKey,
} from "@workspace/arena/lib/waveyard/types/vocal-analysis";
import { handleDrumAnalysisJob, handleHarmonyAnalysisJob, handleVocalAnalysisJob } from "./stem-analysis";
import { recoverPendingLocalVocalAnalyses } from "./recovery";

const RATE = 22_050;
function stereoWav(mono: Float32Array) {
  const stereo = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i += 1) stereo[i * 2] = stereo[i * 2 + 1] = mono[i]!;
  return encodeWav16(stereo, RATE);
}
function tone(frequency: number, seconds: number) {
  const mono = new Float32Array(RATE * seconds);
  for (let i = 0; i < mono.length; i += 1) mono[i] = 0.3 * Math.sin((2 * Math.PI * frequency * i) / RATE);
  return mono;
}
function clickStem() {
  const mono = new Float32Array(RATE * 4);
  for (const second of [0.25, 0.75, 1.25, 2.25, 3.25]) {
    const start = Math.round(second * RATE);
    for (let i = start; i < start + 600; i += 1) mono[i] = 0.8 * Math.exp(-(i - start) / 90) * Math.sin((2 * Math.PI * 90 * (i - start)) / RATE);
  }
  return mono;
}
function chordSource() {
  const mono = new Float32Array(RATE * 4);
  const chords = [[261.63, 329.63, 392], [349.23, 440, 523.25]];
  for (let i = 0; i < mono.length; i += 1) mono[i] = chords[Math.floor(i / (RATE * 2))]!.reduce((sum, hz) => sum + 0.2 * Math.sin((2 * Math.PI * hz * i) / RATE), 0);
  return mono;
}

test("local stem analysis executes, persists versioned results, fails honestly, and recovers after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-local-stem-analysis-"));
  const client = new PGlite();
  try {
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    await applyDesktopMigrationsToPGlite(client, join(repoRoot, "desktop-migrations"));
    const db = drizzle(client) as unknown as NonNullable<Parameters<typeof handleDrumAnalysisJob>[1]>["db"];
    const storage = new LocalStorageProvider(join(root, "storage"));
    const [project] = await db.insert(projects).values({ ownerId: randomUUID(), title: "Local analysis execution" }).returning();
    const files = [stereoWav(chordSource()), stereoWav(clickStem()), stereoWav(tone(220, 4))];
    const paths = files.map((_, index) => join(root, `${index}.wav`));
    await Promise.all(files.map((bytes, index) => writeFile(paths[index]!, bytes)));
    const sourceKey = privateObjectKey(project.id, "source", "wav");
    await storage.putFile(sourceKey, paths[0]!, "audio/wav");
    const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const [source] = await db.insert(sourceAssets).values({ projectId: project.id, originalFilename: "source.wav", mimeType: "audio/wav",
      storageKey: sourceKey, checksumSha256: checksum(files[0]!), durationSeconds: 4, sampleRate: RATE, channels: 2,
      codec: "pcm_s16le", fileSizeBytes: files[0]!.length }).returning();
    const [separation] = await db.insert(processingJobs).values({ projectId: project.id, sourceAssetId: source.id, type: "separation",
      model: "test-local", requestedDevice: "cpu", idempotencyKey: `separation:${source.id}` }).returning();
    const createStem = async (stemType: "drums" | "vocals", fileIndex: number) => {
      const storageKey = privateObjectKey(project.id, "stem", "wav");
      await storage.putFile(storageKey, paths[fileIndex]!, "audio/wav");
      return (await db.insert(stemAssets).values({ projectId: project.id, sourceAssetId: source.id, separationJobId: separation.id,
        stemType, engine: "test", model: "test-local", modelVersion: "1", storageKey, checksumSha256: checksum(files[fileIndex]!),
        durationSeconds: 4, sampleRate: RATE, channels: 2, codec: "pcm_s16le", format: "wav", fileSizeBytes: files[fileIndex]!.length }).returning())[0]!;
    };
    const drumStem = await createStem("drums", 1);
    const vocalStem = await createStem("vocals", 2);
    const [drum] = await db.insert(drumAnalyses).values({ projectId: project.id, sourceAssetId: source.id, stemAssetId: drumStem.id,
      idempotencyKey: drumAnalysisIdempotencyKey(drumStem.id, LOCAL_DRUM_ANALYSIS_ENGINE, LOCAL_DRUM_ANALYSIS_ENGINE_VERSION),
      analysisEngine: LOCAL_DRUM_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256, stemChecksumSha256: drumStem.checksumSha256 }).returning();
    const [harmony] = await db.insert(harmonyAnalyses).values({ projectId: project.id, sourceAssetId: source.id,
      idempotencyKey: harmonyAnalysisIdempotencyKey(source.id, LOCAL_HARMONY_ANALYSIS_ENGINE, LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION),
      analysisEngine: LOCAL_HARMONY_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256 }).returning();
    const [vocal] = await db.insert(vocalAnalyses).values({ projectId: project.id, sourceAssetId: source.id, stemAssetId: vocalStem.id,
      idempotencyKey: vocalAnalysisIdempotencyKey(vocalStem.id, LOCAL_VOCAL_ANALYSIS_ENGINE, LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION),
      analysisEngine: LOCAL_VOCAL_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256, stemChecksumSha256: vocalStem.checksumSha256 }).returning();
    const deps = { db, storage };
    await handleDrumAnalysisJob({ drumAnalysisId: drum.id, projectId: project.id, sourceAssetId: source.id, stemAssetId: drumStem.id,
      analysisEngine: LOCAL_DRUM_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_DRUM_ANALYSIS_ENGINE_VERSION }, deps);
    await handleHarmonyAnalysisJob({ harmonyAnalysisId: harmony.id, projectId: project.id, sourceAssetId: source.id,
      analysisEngine: LOCAL_HARMONY_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION }, deps);
    await handleVocalAnalysisJob({ vocalAnalysisId: vocal.id, projectId: project.id, sourceAssetId: source.id, stemAssetId: vocalStem.id,
      analysisEngine: LOCAL_VOCAL_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION }, deps);
    const [drumDone] = await db.select().from(drumAnalyses).where(eq(drumAnalyses.id, drum.id));
    const [harmonyDone] = await db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.id, harmony.id));
    const [vocalDone] = await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.id, vocal.id));
    assert.equal(drumDone.status, "complete"); assert.equal(drumDone.attempts, 1); assert.equal(drumDone.analysisEngine, LOCAL_DRUM_ANALYSIS_ENGINE);
    assert.equal(harmonyDone.status, "complete"); assert.equal(harmonyDone.analysisEngineVersion, LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION);
    assert.equal(vocalDone.status, "complete"); assert.equal(vocalDone.analysisEngine, LOCAL_VOCAL_ANALYSIS_ENGINE);
    assert.ok((await db.select().from(drumEvents).where(eq(drumEvents.drumAnalysisId, drum.id))).length > 0);
    assert.ok((await db.select().from(harmonyEvents).where(eq(harmonyEvents.harmonyAnalysisId, harmony.id))).length > 0);
    assert.ok((await db.select().from(vocalPitchFrames).where(eq(vocalPitchFrames.vocalAnalysisId, vocal.id))).length > 0);

    const [failureJob] = await db.insert(processingJobs).values({ projectId: project.id, sourceAssetId: source.id, type: "separation",
      model: "test-local", requestedDevice: "cpu", idempotencyKey: `separation-failure:${source.id}` }).returning();
    const [failedStem] = await db.insert(stemAssets).values({ projectId: project.id, sourceAssetId: source.id, separationJobId: failureJob.id,
      stemType: "vocals", engine: "test", model: "test-local", modelVersion: "1", storageKey: "missing.wav",
      checksumSha256: "b".repeat(64), durationSeconds: 4, sampleRate: RATE, channels: 2, codec: "pcm_s16le", format: "wav", fileSizeBytes: 44 }).returning();
    const [failedAnalysis] = await db.insert(vocalAnalyses).values({ projectId: project.id, sourceAssetId: source.id, stemAssetId: failedStem.id,
      idempotencyKey: vocalAnalysisIdempotencyKey(failedStem.id, LOCAL_VOCAL_ANALYSIS_ENGINE, LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION),
      analysisEngine: LOCAL_VOCAL_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256, stemChecksumSha256: failedStem.checksumSha256 }).returning();
    await assert.rejects(handleVocalAnalysisJob({ vocalAnalysisId: failedAnalysis.id, projectId: project.id, sourceAssetId: source.id,
      stemAssetId: failedStem.id, analysisEngine: LOCAL_VOCAL_ANALYSIS_ENGINE,
      analysisEngineVersion: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION }, deps), /ENOENT|no such file|missing/i);
    const [failed] = await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.id, failedAnalysis.id));
    assert.equal(failed.status, "failed"); assert.equal(failed.errorCode, "analysis_failed");

    await storage.putFile("missing.wav", paths[2]!, "audio/wav");
    await handleVocalAnalysisJob({ vocalAnalysisId: failedAnalysis.id, projectId: project.id, sourceAssetId: source.id,
      stemAssetId: failedStem.id, analysisEngine: LOCAL_VOCAL_ANALYSIS_ENGINE,
      analysisEngineVersion: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION }, deps);
    const [retried] = await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.id, failedAnalysis.id));
    assert.equal(retried.status, "complete"); assert.equal(retried.attempts, 2);

    await db.update(vocalAnalyses).set({ status: "processing", stage: "analyzing" }).where(eq(vocalAnalyses.id, failedAnalysis.id));
    const recovered: unknown[] = [];
    const result = await recoverPendingLocalVocalAnalyses(db, async (payload) => { recovered.push(payload); });
    assert.deepEqual(result, { requeuedJobIds: [failedAnalysis.id], failedJobIds: [] });
    assert.deepEqual(recovered, [{ vocalAnalysisId: failedAnalysis.id, projectId: project.id, sourceAssetId: source.id,
      stemAssetId: failedStem.id, analysisEngine: LOCAL_VOCAL_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION }]);
    const [afterRestart] = await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.id, failedAnalysis.id));
    assert.equal(afterRestart.status, "queued"); assert.equal(afterRestart.startedAt, null);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
