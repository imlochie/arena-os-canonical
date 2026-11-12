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
  projects, processingJobs, sourceAnalyses, sourceAssets, sourceSectionAnalyses, stemAssets, bassAnalyses, bassEvents, drumAnalyses, drumEvents,
  harmonyAnalyses, harmonyEvents, stemHarmonyAnalyses, stemHarmonyEvents, vocalAnalyses, vocalActivityIntervals, vocalPitchFrames, vocalPhrases,
  remixSessions, remixVersions, exportJobs, exportAssets,
} from "@workspace/db/waveyardSchema";
import {
  LOCAL_DRUM_ANALYSIS_ENGINE, LOCAL_DRUM_ANALYSIS_ENGINE_VERSION, drumAnalysisIdempotencyKey,
} from "@workspace/arena/lib/waveyard/types/drum-analysis";
import {
  LOCAL_BASS_ANALYSIS_ENGINE, LOCAL_BASS_ANALYSIS_ENGINE_VERSION, bassAnalysisIdempotencyKey,
} from "@workspace/arena/lib/waveyard/types/bass-analysis";
import {
  LOCAL_HARMONY_ANALYSIS_ENGINE, LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION, harmonyAnalysisIdempotencyKey,
} from "@workspace/arena/lib/waveyard/types/harmony-analysis";
import {
  LOCAL_STEM_HARMONY_ANALYSIS_ENGINE, LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION, stemHarmonyAnalysisIdempotencyKey,
} from "@workspace/arena/lib/waveyard/types/stem-harmony-analysis";
import {
  LOCAL_VOCAL_ANALYSIS_ENGINE, LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION, vocalAnalysisIdempotencyKey,
} from "@workspace/arena/lib/waveyard/types/vocal-analysis";
import { handleBassAnalysisJob, handleDrumAnalysisJob, handleHarmonyAnalysisJob, handleStemHarmonyAnalysisJob, handleVocalAnalysisJob } from "./stem-analysis";
import { handleMidiExportJob } from "./export";
import { provisionDesktopVocalAnalysis } from "./analysis";
import { parseStandardMidiFile } from "../midi-file";
import {
  recoverPendingLocalDrumAnalyses,
  recoverPendingLocalBassAnalyses,
  recoverPendingLocalHarmonyAnalyses,
  recoverPendingLocalStemHarmonyAnalyses,
  recoverPendingLocalVocalAnalyses,
} from "./recovery";

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
function vocalPulseTone(frequency: number, seconds: number) {
  const mono = new Float32Array(RATE * seconds);
  for (let i = 0; i < mono.length; i += 1) {
    const time = i / RATE;
    const active = (time >= 0.4 && time < 1.45) || (time >= 1.9 && time < 3.45);
    if (active) mono[i] = 0.3 * Math.sin((2 * Math.PI * frequency * i) / RATE);
  }
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
    const files = [stereoWav(chordSource()), stereoWav(clickStem()), stereoWav(vocalPulseTone(220, 4))];
    const paths = files.map((_, index) => join(root, `${index}.wav`));
    await Promise.all(files.map((bytes, index) => writeFile(paths[index]!, bytes)));
    const sourceKey = privateObjectKey(project.id, "source", "wav");
    await storage.putFile(sourceKey, paths[0]!, "audio/wav");
    const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const [source] = await db.insert(sourceAssets).values({ projectId: project.id, originalFilename: "source.wav", mimeType: "audio/wav",
      storageKey: sourceKey, checksumSha256: checksum(files[0]!), durationSeconds: 4, sampleRate: RATE, channels: 2,
      codec: "pcm_s16le", fileSizeBytes: files[0]!.length }).returning();
    await db.insert(sourceAnalyses).values({
      projectId: project.id,
      sourceAssetId: source.id,
      status: "complete",
      idempotencyKey: `analysis:${source.id}:${randomUUID()}`,
      analysisEngine: "arena-js-dsp",
      analysisEngineVersion: "1.4.0",
      sourceChecksumSha256: source.checksumSha256,
      beatGrid: JSON.stringify([0, 500, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000]),
      beatConfidence: 0.8,
    });
    const [separation] = await db.insert(processingJobs).values({ projectId: project.id, sourceAssetId: source.id, type: "separation",
      model: "test-local", requestedDevice: "cpu", idempotencyKey: `separation:${source.id}` }).returning();
    const createStem = async (stemType: "drums" | "vocals" | "bass", fileIndex: number, separationJobId = separation.id) => {
      const storageKey = privateObjectKey(project.id, "stem", "wav");
      await storage.putFile(storageKey, paths[fileIndex]!, "audio/wav");
      return (await db.insert(stemAssets).values({ projectId: project.id, sourceAssetId: source.id, separationJobId,
        stemType, engine: "test", model: "test-local", modelVersion: "1", storageKey, checksumSha256: checksum(files[fileIndex]!),
        durationSeconds: 4, sampleRate: RATE, channels: 2, codec: "pcm_s16le", format: "wav", fileSizeBytes: files[fileIndex]!.length }).returning())[0]!;
    };
    const drumStem = await createStem("drums", 1);
    const vocalStem = await createStem("vocals", 2);
    const bassStem = await createStem("bass", 1);
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
    const [bass] = await db.insert(bassAnalyses).values({ projectId: project.id, sourceAssetId: source.id, stemAssetId: bassStem.id,
      idempotencyKey: bassAnalysisIdempotencyKey(bassStem.id),
      analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256, stemChecksumSha256: bassStem.checksumSha256 }).returning();
    const refreshedSections: unknown[] = [];
    const deps = {
      db,
      storage,
      enqueueSectionAnalysis: async (payload: unknown) => { refreshedSections.push(payload); },
    };
    await handleDrumAnalysisJob({ drumAnalysisId: drum.id, projectId: project.id, sourceAssetId: source.id, stemAssetId: drumStem.id,
      analysisEngine: LOCAL_DRUM_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_DRUM_ANALYSIS_ENGINE_VERSION }, deps);
    await handleBassAnalysisJob({ bassAnalysisId: bass.id, projectId: project.id, sourceAssetId: source.id, stemAssetId: bassStem.id,
      analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_BASS_ANALYSIS_ENGINE_VERSION }, deps);
    await handleHarmonyAnalysisJob({ harmonyAnalysisId: harmony.id, projectId: project.id, sourceAssetId: source.id,
      analysisEngine: LOCAL_HARMONY_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION }, deps);
    await handleVocalAnalysisJob({ vocalAnalysisId: vocal.id, projectId: project.id, sourceAssetId: source.id, stemAssetId: vocalStem.id,
      analysisEngine: LOCAL_VOCAL_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION }, deps);
    const [drumDone] = await db.select().from(drumAnalyses).where(eq(drumAnalyses.id, drum.id));
    const [harmonyDone] = await db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.id, harmony.id));
    const [vocalDone] = await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.id, vocal.id));
    const [bassDone] = await db.select().from(bassAnalyses).where(eq(bassAnalyses.id, bass.id));
    assert.equal(drumDone.status, "complete"); assert.equal(drumDone.attempts, 1); assert.equal(drumDone.analysisEngine, LOCAL_DRUM_ANALYSIS_ENGINE);
    assert.equal(harmonyDone.status, "complete"); assert.equal(harmonyDone.analysisEngineVersion, LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION);
    assert.equal(vocalDone.status, "complete"); assert.equal(vocalDone.analysisEngine, LOCAL_VOCAL_ANALYSIS_ENGINE);
    assert.equal(bassDone.status, "complete"); assert.equal(bassDone.analysisEngine, LOCAL_BASS_ANALYSIS_ENGINE);
    assert.ok((await db.select().from(drumEvents).where(eq(drumEvents.drumAnalysisId, drum.id))).length > 0);
    assert.ok((await db.select().from(harmonyEvents).where(eq(harmonyEvents.harmonyAnalysisId, harmony.id))).length > 0);
    const persistedVocalFrames = await db.select().from(vocalPitchFrames).where(eq(vocalPitchFrames.vocalAnalysisId, vocal.id));
    assert.ok(persistedVocalFrames.length > 0);
    const finalVocalFrameMs = Math.max(...persistedVocalFrames.map((frame) => frame.timestampMs));
    assert.ok(finalVocalFrameMs <= 4_000, "persisted vocal pitch timing stays inside the decoded PCM");
    assert.ok((await db.select().from(vocalPhrases).where(eq(vocalPhrases.vocalAnalysisId, vocal.id))).length > 0);
    const persistedActivity = await db.select().from(vocalActivityIntervals).where(eq(vocalActivityIntervals.vocalAnalysisId, vocal.id));
    assert.equal(persistedActivity.length, 2, "separate vocal activity intervals persist through the local analysis route");
    assert.ok(persistedActivity[0]!.startMs >= 350 && persistedActivity[0]!.startMs <= 450);
    assert.ok(persistedActivity[0]!.endMs >= 1_400 && persistedActivity[0]!.endMs <= 1_500);
    assert.ok(persistedActivity[1]!.startMs >= 1_850 && persistedActivity[1]!.startMs <= 1_950);
    assert.ok(persistedActivity[1]!.endMs >= 3_400 && persistedActivity[1]!.endMs <= 3_500);
    assert.ok((await db.select().from(bassEvents).where(eq(bassEvents.bassAnalysisId, bass.id))).length > 0);
    assert.equal(refreshedSections.length, 1, "completed vocal timing refreshes structural fingerprints");
    assert.equal(
      typeof (refreshedSections[0] as { dispatchKey?: string } | undefined)?.dispatchKey,
      "string",
      "vocal evidence uses a distinct refresh dispatch identity",
    );
    assert.equal(
      (await db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.sourceAssetId, source.id)))[0]?.status,
      "queued",
    );

    await db.update(drumAnalyses).set({ status: "processing", stage: "analyzing" }).where(eq(drumAnalyses.id, drum.id));
    await db.update(bassAnalyses).set({ status: "processing", stage: "analyzing" }).where(eq(bassAnalyses.id, bass.id));
    await db.update(harmonyAnalyses).set({ status: "processing", stage: "analyzing" }).where(eq(harmonyAnalyses.id, harmony.id));
    await db.update(vocalAnalyses).set({ status: "processing", stage: "analyzing" }).where(eq(vocalAnalyses.id, vocal.id));
    const recoveredDrums: unknown[] = []; const recoveredBass: unknown[] = []; const recoveredHarmony: unknown[] = []; const recoveredVocals: unknown[] = [];
    assert.deepEqual(await recoverPendingLocalDrumAnalyses(db, async (payload) => { recoveredDrums.push(payload); }), { requeuedJobIds: [drum.id], failedJobIds: [] });
    assert.deepEqual(await recoverPendingLocalBassAnalyses(db, async (payload) => { recoveredBass.push(payload); }), { requeuedJobIds: [bass.id], failedJobIds: [] });
    assert.deepEqual(await recoverPendingLocalHarmonyAnalyses(db, async (payload) => { recoveredHarmony.push(payload); }), { requeuedJobIds: [harmony.id], failedJobIds: [] });
    assert.deepEqual(await recoverPendingLocalVocalAnalyses(db, async (payload) => { recoveredVocals.push(payload); }), { requeuedJobIds: [vocal.id], failedJobIds: [] });
    assert.equal((await db.select().from(drumAnalyses).where(eq(drumAnalyses.id, drum.id)))[0]!.status, "queued");
    assert.equal((await db.select().from(bassAnalyses).where(eq(bassAnalyses.id, bass.id)))[0]!.status, "queued");
    assert.equal((await db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.id, harmony.id)))[0]!.status, "queued");
    assert.equal((await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.id, vocal.id)))[0]!.status, "queued");
    assert.equal(recoveredDrums.length, 1); assert.equal(recoveredBass.length, 1); assert.equal(recoveredHarmony.length, 1); assert.equal(recoveredVocals.length, 1);
    assert.deepEqual(recoveredBass, [{
      bassAnalysisId: bass.id,
      projectId: project.id,
      sourceAssetId: source.id,
      stemAssetId: bassStem.id,
      analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE,
      analysisEngineVersion: LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
    }]);

    const [staleSeparation] = await db.insert(processingJobs).values({
      projectId: project.id, sourceAssetId: source.id, type: "separation", model: "test-local", requestedDevice: "cpu",
      idempotencyKey: `separation-stale:${source.id}`,
    }).returning();
    const staleBassStem = await createStem("bass", 2, staleSeparation.id);
    const [staleBass] = await db.insert(bassAnalyses).values({
      projectId: project.id, sourceAssetId: source.id, stemAssetId: staleBassStem.id,
      idempotencyKey: bassAnalysisIdempotencyKey(staleBassStem.id),
      analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256, stemChecksumSha256: staleBassStem.checksumSha256,
    }).returning();
    await db.update(stemAssets).set({ checksumSha256: "c".repeat(64) }).where(eq(stemAssets.id, staleBassStem.id));
    await assert.rejects(handleBassAnalysisJob({
      bassAnalysisId: staleBass.id, projectId: project.id, sourceAssetId: source.id, stemAssetId: staleBassStem.id,
      analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
    }, deps), /changed before analysis/);
    const [staleBassAfter] = await db.select().from(bassAnalyses).where(eq(bassAnalyses.id, staleBass.id));
    assert.equal(staleBassAfter.status, "failed");
    assert.equal(staleBassAfter.errorCode, "analysis_stale");
    assert.equal((await db.select().from(bassEvents).where(eq(bassEvents.bassAnalysisId, staleBass.id))).length, 0);

    const [corruptSeparation] = await db.insert(processingJobs).values({
      projectId: project.id, sourceAssetId: source.id, type: "separation", model: "test-local", requestedDevice: "cpu",
      idempotencyKey: `separation-corrupt:${source.id}`,
    }).returning();
    const corruptBassStem = await createStem("bass", 2, corruptSeparation.id);
    const [corruptBass] = await db.insert(bassAnalyses).values({
      projectId: project.id, sourceAssetId: source.id, stemAssetId: corruptBassStem.id,
      idempotencyKey: bassAnalysisIdempotencyKey(corruptBassStem.id),
      analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256, stemChecksumSha256: corruptBassStem.checksumSha256,
    }).returning();
    await storage.putFile(corruptBassStem.storageKey, paths[0]!, "audio/wav");
    await assert.rejects(handleBassAnalysisJob({
      bassAnalysisId: corruptBass.id, projectId: project.id, sourceAssetId: source.id, stemAssetId: corruptBassStem.id,
      analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE, analysisEngineVersion: LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
    }, deps), /stored bass stem bytes do not match/);
    const [corruptBassAfter] = await db.select().from(bassAnalyses).where(eq(bassAnalyses.id, corruptBass.id));
    assert.equal(corruptBassAfter.status, "failed");
    assert.equal((await db.select().from(bassEvents).where(eq(bassEvents.bassAnalysisId, corruptBass.id))).length, 0);

    // Let the recovered jobs finish before introducing a separate failed row.
    await db.update(drumAnalyses).set({ status: "complete", stage: "complete" }).where(eq(drumAnalyses.id, drum.id));
    await db.update(bassAnalyses).set({ status: "complete", stage: "complete" }).where(eq(bassAnalyses.id, bass.id));
    await db.update(harmonyAnalyses).set({ status: "complete", stage: "complete" }).where(eq(harmonyAnalyses.id, harmony.id));
    await db.update(vocalAnalyses).set({ status: "complete", stage: "complete" }).where(eq(vocalAnalyses.id, vocal.id));

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

    const [session] = await db.insert(remixSessions).values({
      projectId: project.id, ownerId: project.ownerId, name: "MIDI export integration",
    }).returning();
    const [version] = await db.insert(remixVersions).values({
      remixSessionId: session.id, createdById: project.ownerId, name: "MIDI export snapshot", snapshot: "{}",
    }).returning();
    const exportDb = db as unknown as Parameters<typeof handleMidiExportJob>[2];
    for (const target of [
      { kind: "vocal" as const, stemId: vocalStem.id, analysisId: vocal.id, engine: LOCAL_VOCAL_ANALYSIS_ENGINE, engineVersion: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION },
      { kind: "harmony" as const, stemId: null, analysisId: harmony.id, engine: LOCAL_HARMONY_ANALYSIS_ENGINE, engineVersion: LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION },
    ]) {
      const [midiJob] = await db.insert(exportJobs).values({
        projectId: project.id, remixSessionId: session.id, remixVersionId: version.id, requestedById: project.ownerId,
        idempotencyKey: "midi-export:" + target.kind + ":" + randomUUID(), format: "midi", midiKind: target.kind,
        midiSourceAssetId: source.id, midiStemAssetId: target.stemId, midiPpq: 480, midiAnalysisId: target.analysisId,
        midiSourceChecksumSha256: source.checksumSha256, midiAnalysisEngine: target.engine,
        midiAnalysisEngineVersion: target.engineVersion, sampleRate: 0, channels: 0,
      }).returning();
      await handleMidiExportJob(midiJob, version, exportDb, storage);
      const [completed] = await db.select().from(exportJobs).where(eq(exportJobs.id, midiJob.id));
      assert.equal(completed.status, "complete", completed.errorMessage ?? target.kind + " MIDI export completes");
      const [asset] = await db.select().from(exportAssets).where(eq(exportAssets.exportJobId, midiJob.id));
      assert.ok(asset, "the durable export asset is created");
      assert.equal(asset.format, "midi");
      const bytes = await storage.getBuffer(asset.storageKey, 1024 * 1024);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.checksumSha256);
      const parsed = parseStandardMidiFile(bytes);
      assert.ok(parsed, "persisted bytes round-trip through the Standard MIDI reader");
       assert.ok(parsed.notes.length > 0, `local ${target.kind} analysis produces notes without a remote worker`);
    }

    await db.update(vocalAnalyses).set({
      status: "complete",
      stage: "complete",
      analysisEngineVersion: "1.0.0",
      idempotencyKey: vocalAnalysisIdempotencyKey(vocalStem.id, LOCAL_VOCAL_ANALYSIS_ENGINE, "1.0.0"),
    }).where(eq(vocalAnalyses.id, vocal.id));
    const upgradePayloads: Array<Record<string, unknown>> = [];
    const upgradedVocal = await provisionDesktopVocalAnalysis(source, vocalStem, {
      database: db,
      enqueue: async (payload) => { upgradePayloads.push(payload); },
    });
    assert.equal(upgradedVocal?.analysisEngineVersion, LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION);
    assert.equal(upgradedVocal?.status, "queued", "old local vocal evidence is reanalyzed in place for the new activity signal");
    assert.equal(upgradePayloads.length, 1);
    const currentPayload = upgradePayloads[0]!;
    await assert.rejects(handleVocalAnalysisJob({
      ...currentPayload,
      analysisEngineVersion: "1.0.0",
    }, deps), /does not match its durable target/);
    assert.equal(
      (await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.id, vocal.id)))[0]?.status,
      "queued",
      "a late stale-version job cannot fail the upgraded row",
    );
    await handleVocalAnalysisJob(currentPayload, deps);
    assert.equal((await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.id, vocal.id)))[0]?.status, "complete");
    assert.equal(
      (await db.select().from(vocalActivityIntervals).where(eq(vocalActivityIntervals.vocalAnalysisId, vocal.id))).length,
      2,
      "the upgraded full route replaces old evidence with current activity intervals",
    );

    const [staleMidiJob] = await db.insert(exportJobs).values({
      projectId: project.id, remixSessionId: session.id, remixVersionId: version.id, requestedById: project.ownerId,
      idempotencyKey: "midi-export:stale:" + randomUUID(), format: "midi", midiKind: "vocal",
      midiSourceAssetId: source.id, midiStemAssetId: vocalStem.id, midiPpq: 480, midiAnalysisId: vocal.id,
      midiSourceChecksumSha256: source.checksumSha256, midiAnalysisEngine: LOCAL_VOCAL_ANALYSIS_ENGINE,
      midiAnalysisEngineVersion: "obsolete-version", sampleRate: 0, channels: 0,
    }).returning();
    await assert.rejects(handleMidiExportJob(staleMidiJob, version, exportDb, storage), /Complete current vocal analysis/);
    const [staleResult] = await db.select().from(exportJobs).where(eq(exportJobs.id, staleMidiJob.id));
    assert.equal(staleResult.status, "failed");
    assert.equal(staleResult.errorCode, "analysis_stale");
    assert.equal((await db.select().from(exportAssets).where(eq(exportAssets.exportJobId, staleMidiJob.id))).length, 0);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("separated backing harmony is computed from persisted stem PCM and restart-recoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-stem-harmony-"));
  const client = new PGlite();
  try {
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    await applyDesktopMigrationsToPGlite(client, join(repoRoot, "desktop-migrations"));
    const db = drizzle(client) as unknown as NonNullable<Parameters<typeof handleStemHarmonyAnalysisJob>[1]>["db"];
    const storage = new LocalStorageProvider(join(root, "storage"));
    const [project] = await db.insert(projects).values({ ownerId: randomUUID(), title: "Stem harmony" }).returning();
    const audio = stereoWav(chordSource());
    const audioPath = join(root, "other.wav");
    await writeFile(audioPath, audio);
    const checksum = createHash("sha256").update(audio).digest("hex");
    const sourceKey = privateObjectKey(project.id, "source", "wav");
    const stemKey = privateObjectKey(project.id, "stem", "wav");
    await storage.putFile(sourceKey, audioPath, "audio/wav");
    await storage.putFile(stemKey, audioPath, "audio/wav");
    const [source] = await db.insert(sourceAssets).values({
      projectId: project.id,
      originalFilename: "mix.wav",
      mimeType: "audio/wav",
      storageKey: sourceKey,
      checksumSha256: checksum,
      durationSeconds: 4,
      sampleRate: RATE,
      channels: 2,
      codec: "pcm_s16le",
      fileSizeBytes: audio.length,
    }).returning();
    const [separation] = await db.insert(processingJobs).values({
      projectId: project.id,
      sourceAssetId: source.id,
      type: "separation",
      status: "complete",
      stage: "complete",
      idempotencyKey: `separation:${source.id}`,
      model: "test",
      requestedDevice: "cpu",
      completedAt: new Date(),
    }).returning();
    const [stem] = await db.insert(stemAssets).values({
      projectId: project.id,
      sourceAssetId: source.id,
      separationJobId: separation.id,
      stemType: "other",
      engine: "test",
      model: "test",
      modelVersion: "1",
      storageKey: stemKey,
      checksumSha256: checksum,
      durationSeconds: 4,
      sampleRate: RATE,
      channels: 2,
      codec: "pcm_s16le",
      format: "wav",
      fileSizeBytes: audio.length,
    }).returning();
    const [analysis] = await db.insert(stemHarmonyAnalyses).values({
      projectId: project.id,
      sourceAssetId: source.id,
      stemAssetId: stem.id,
      idempotencyKey: stemHarmonyAnalysisIdempotencyKey(stem.id),
      analysisEngine: LOCAL_STEM_HARMONY_ANALYSIS_ENGINE,
      analysisEngineVersion: LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256,
      stemChecksumSha256: stem.checksumSha256,
    }).returning();

    const deps = { db, storage };
    const payload = {
      stemHarmonyAnalysisId: analysis.id,
      projectId: project.id,
      sourceAssetId: source.id,
      stemAssetId: stem.id,
      analysisEngine: LOCAL_STEM_HARMONY_ANALYSIS_ENGINE,
      analysisEngineVersion: LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION,
    };
    await handleStemHarmonyAnalysisJob(payload, deps);
    const [completed] = await db.select().from(stemHarmonyAnalyses).where(eq(stemHarmonyAnalyses.id, analysis.id));
    const events = await db.select().from(stemHarmonyEvents).where(eq(stemHarmonyEvents.stemHarmonyAnalysisId, analysis.id));
    assert.equal(completed.status, "complete");
    assert.equal(completed.sourceChecksumSha256, source.checksumSha256);
    assert.equal(completed.stemChecksumSha256, stem.checksumSha256);
    assert.ok(events.length > 0, "actual decoded isolated PCM produced persisted chord events");
    assert.ok(events.every((event) => event.endMs <= 4_000), "event timing remains within the source and stem duration");

    await db.update(stemHarmonyAnalyses).set({ status: "processing", stage: "analyzing" })
      .where(eq(stemHarmonyAnalyses.id, analysis.id));
    const recoveredPayloads: Array<Record<string, unknown>> = [];
    const recovered = await recoverPendingLocalStemHarmonyAnalyses(db, async (job) => { recoveredPayloads.push(job); });
    assert.deepEqual(recovered.requeuedJobIds, [analysis.id]);
    assert.equal(recoveredPayloads.length, 1);
    assert.equal(recoveredPayloads[0]?.stemAssetId, stem.id);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
