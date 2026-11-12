/**
 * Desktop stem-analysis handlers. These use the same arena-js-dsp engine as
 * local BPM/key analysis and persist the existing versioned Waveyard result
 * contracts. The remote NumPy worker keeps its own truthful provenance.
 */

import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { drizzle } from "drizzle-orm/node-postgres";

import { db as defaultDb } from "@workspace/db";
import {
  bassAnalyses, bassEvents, drumAnalyses, drumEvents, harmonyAnalyses, harmonyEvents,
  sourceAnalyses, sourceAssets, stemAssets,
  vocalAnalyses, vocalActivityIntervals, vocalPitchFrames, vocalPhrases,
} from "@workspace/db/waveyardSchema";
import { getStorage, type StorageProvider } from "@workspace/arena/lib/waveyard/storage";
import { enqueueSourceSectionAnalysis } from "@workspace/arena/lib/waveyard/queue";
import type { BassAnalysisJobPayload, DrumAnalysisJobPayload, HarmonyAnalysisJobPayload, VocalAnalysisJobPayload } from "@workspace/arena/lib/waveyard/types";
import {
  bassAnalysisProvenanceReason,
  LOCAL_BASS_ANALYSIS_ENGINE,
  LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
  normaliseBassEvents,
} from "@workspace/arena/lib/waveyard/types/bass-analysis";
import {
  classifiedDrumEvent, drumAnalysisProvenanceReason, LOCAL_DRUM_ANALYSIS_ENGINE,
  LOCAL_DRUM_ANALYSIS_ENGINE_VERSION, normaliseDrumEvents,
} from "@workspace/arena/lib/waveyard/types/drum-analysis";
import {
  harmonyAnalysisProvenanceReason, LOCAL_HARMONY_ANALYSIS_ENGINE,
  LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION, normaliseHarmonyEvents,
} from "@workspace/arena/lib/waveyard/types/harmony-analysis";
import {
  LOCAL_VOCAL_ANALYSIS_ENGINE, LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
  normaliseVocalPitchFrames, segmentVocalPhrases, vocalAnalysisProvenanceReason,
} from "@workspace/arena/lib/waveyard/types/vocal-analysis";
import { usableBeatGrid } from "@workspace/arena/lib/waveyard/types/beat-grid";
import { provisionDesktopSectionAnalysis } from "./analysis";
import { ANALYSIS_PCM_RATE, decodeMonoPcm, detectBassAttacks, detectDrumTransients, detectHarmonyTimeline, detectVocalActivityIntervals, detectVocalPitchFrames } from "./analysis-engine";

type AnalysisDb = ReturnType<typeof drizzle>;
type StemAnalysisDeps = {
  db?: AnalysisDb;
  storage?: StorageProvider;
  decode?: typeof decodeMonoPcm;
  enqueueSectionAnalysis?: typeof enqueueSourceSectionAnalysis;
};

const active = (status: string) => status === "queued" || status === "failed";

async function rejectPayload(db: AnalysisDb, table: typeof bassAnalyses | typeof drumAnalyses | typeof vocalAnalyses, id: string, checksum: string, message: string) {
  await db.update(table).set({
    status: "failed", stage: "invalid-payload", errorCode: "invalid_payload",
    errorMessage: message, completedAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(table.id, id), eq(table.sourceChecksumSha256, checksum)));
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Analysis cancelled.");
}

export async function handleDrumAnalysisJob(payloadInput: Record<string, unknown>, deps: StemAnalysisDeps = {}): Promise<void> {
  const payload = payloadInput as unknown as DrumAnalysisJobPayload;
  const database = deps.db ?? defaultDb;
  const storage = deps.storage ?? getStorage();
  const decode = deps.decode ?? decodeMonoPcm;
  const [job] = await database.select().from(drumAnalyses).where(eq(drumAnalyses.id, payload.drumAnalysisId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  const valid = job.projectId === payload.projectId && job.sourceAssetId === payload.sourceAssetId
    && job.stemAssetId === payload.stemAssetId && job.analysisEngine === payload.analysisEngine
    && job.analysisEngineVersion === payload.analysisEngineVersion
    && job.analysisEngine === LOCAL_DRUM_ANALYSIS_ENGINE && job.analysisEngineVersion === LOCAL_DRUM_ANALYSIS_ENGINE_VERSION;
  if (!valid) {
    await rejectPayload(database, drumAnalyses, job.id, job.sourceChecksumSha256, "Local drum analysis payload does not match its versioned target.");
    throw new Error("Local drum analysis payload does not match its durable target.");
  }
  const [source] = await database.select().from(sourceAssets).where(and(eq(sourceAssets.id, job.sourceAssetId), eq(sourceAssets.projectId, job.projectId))).limit(1);
  const [stem] = await database.select().from(stemAssets).where(and(eq(stemAssets.id, job.stemAssetId), eq(stemAssets.projectId, job.projectId))).limit(1);
  const provenance = source && stem ? drumAnalysisProvenanceReason({
    sourceAssetId: job.sourceAssetId, expectedSourceAssetId: source.id,
    stemAssetId: job.stemAssetId, expectedStemAssetId: stem.id,
    sourceChecksumSha256: job.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: job.stemChecksumSha256, expectedStemChecksumSha256: stem.checksumSha256,
    analysisEngine: job.analysisEngine, analysisEngineVersion: job.analysisEngineVersion,
  }, { engine: LOCAL_DRUM_ANALYSIS_ENGINE, version: LOCAL_DRUM_ANALYSIS_ENGINE_VERSION }) : "source_stem_mismatch";
  if (!source || !stem || (stem.stemType !== "drums" && stem.stemType !== "percussion") || provenance) {
    await database.update(drumAnalyses).set({ status: "failed", stage: "provenance-failed", errorCode: "analysis_stale", errorMessage: "The source or isolated drum stem changed before analysis.", completedAt: new Date(), updatedAt: new Date() }).where(and(eq(drumAnalyses.id, job.id), eq(drumAnalyses.status, job.status)));
    throw new Error("The source or isolated drum stem changed before analysis.");
  }
  const [claimed] = await database.update(drumAnalyses).set({
    status: "preparing", stage: "preparing", attempts: job.attempts + 1, errorCode: null,
    errorMessage: null, startedAt: new Date(), completedAt: null, updatedAt: new Date(),
  }).where(and(eq(drumAnalyses.id, job.id), eq(drumAnalyses.status, job.status))).returning({ id: drumAnalyses.id });
  if (!claimed || !active(job.status)) return;
  const [processing] = await database.update(drumAnalyses).set({ status: "processing", stage: "analyzing", updatedAt: new Date() })
    .where(and(eq(drumAnalyses.id, job.id), eq(drumAnalyses.status, "preparing"))).returning({ id: drumAnalyses.id });
  if (!processing) return;
  try {
    const inputPath = await prepareStemFile(storage, stem.storageKey);
    try {
      const pcm = await decode(inputPath);
      if (pcm.length < 2_205) throw new Error("The isolated drum stem is too short for transient analysis.");
      const raw = detectDrumTransients(pcm);
      const events = normaliseDrumEvents(raw, Math.round(source.durationSeconds * 1000));
      if (events === null) throw new Error("The local DSP engine returned invalid drum events.");
      const [sourceTempo] = await database.select({ beatGrid: sourceAnalyses.beatGrid }).from(sourceAnalyses)
        .where(and(eq(sourceAnalyses.sourceAssetId, source.id), eq(sourceAnalyses.status, "complete"))).limit(1);
      const beatGrid = parseBeatGrid(sourceTempo?.beatGrid ?? null);
      const analyzedAt = new Date();
      await database.transaction(async (tx) => {
        const [currentSource] = await tx.select().from(sourceAssets).where(eq(sourceAssets.id, source.id)).for("update").limit(1);
        const [currentStem] = await tx.select().from(stemAssets).where(eq(stemAssets.id, stem.id)).for("update").limit(1);
        if (!currentSource || !currentStem || currentSource.checksumSha256 !== job.sourceChecksumSha256 || currentStem.checksumSha256 !== job.stemChecksumSha256)
          throw new Error("The source or isolated drum stem changed while it was being analyzed.");
        await tx.delete(drumEvents).where(eq(drumEvents.drumAnalysisId, job.id));
        if (events.length) await tx.insert(drumEvents).values(events.map((event, eventIndex) => {
          const projected = classifiedDrumEvent(event, beatGrid ? {
            nearestBeatIndex: nearestBeatIndex(event.timestampMs, beatGrid),
            beatOffsetMs: event.timestampMs - beatGrid[nearestBeatIndex(event.timestampMs, beatGrid)]!,
          } : null);
          return { drumAnalysisId: job.id, eventIndex, ...projected };
        }));
        const [completed] = await tx.update(drumAnalyses).set({ status: "complete", stage: "complete", analysisEngine: LOCAL_DRUM_ANALYSIS_ENGINE,
          analysisEngineVersion: LOCAL_DRUM_ANALYSIS_ENGINE_VERSION, errorCode: null, errorMessage: null,
          analyzedAt, completedAt: analyzedAt, updatedAt: analyzedAt,
        }).where(and(eq(drumAnalyses.id, job.id), eq(drumAnalyses.status, "processing"), eq(drumAnalyses.sourceChecksumSha256, job.sourceChecksumSha256), eq(drumAnalyses.stemChecksumSha256, job.stemChecksumSha256))).returning({ id: drumAnalyses.id });
        if (!completed) throw new Error("Drum analysis lost its active durable claim before completion.");
      });
    } finally { await removeStemFile(inputPath); }
  } catch (error) {
    await database.update(drumAnalyses).set({ status: "failed", stage: "failed", errorCode: "analysis_failed",
      errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Local drum analysis failed.", completedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(drumAnalyses.id, job.id), eq(drumAnalyses.status, "processing"), eq(drumAnalyses.sourceChecksumSha256, job.sourceChecksumSha256)));
    throw error;
  }
}

function nearestBeatIndex(timestamp: number, grid: number[]): number {
  let index = 0;
  for (let candidate = 1; candidate < grid.length; candidate += 1)
    if (Math.abs(grid[candidate]! - timestamp) < Math.abs(grid[index]! - timestamp)) index = candidate;
  return index;
}

async function prepareStemFile(storage: StorageProvider, storageKey: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "arena-stem-analysis-"));
  const inputPath = join(directory, "input-audio");
  try { await storage.getToFile(storageKey, inputPath); return inputPath; }
  catch (error) { await removeStemFile(inputPath); throw error; }
}

async function removeStemFile(inputPath: string) {
  const { rm } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await rm(dirname(inputPath), { recursive: true, force: true });
}

function parseBeatGrid(value: string | null): number[] | null {
  if (!value) return null;
  try { return usableBeatGrid(JSON.parse(value)); } catch { return null; }
}

export async function handleBassAnalysisJob(payloadInput: Record<string, unknown>, deps: StemAnalysisDeps = {}): Promise<void> {
  const payload = payloadInput as unknown as BassAnalysisJobPayload;
  const database = deps.db ?? defaultDb;
  const storage = deps.storage ?? getStorage();
  const decode = deps.decode ?? decodeMonoPcm;
  const [job] = await database.select().from(bassAnalyses).where(eq(bassAnalyses.id, payload.bassAnalysisId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  const valid = job.projectId === payload.projectId && job.sourceAssetId === payload.sourceAssetId
    && job.stemAssetId === payload.stemAssetId && job.analysisEngine === payload.analysisEngine
    && job.analysisEngineVersion === payload.analysisEngineVersion
    && job.analysisEngine === LOCAL_BASS_ANALYSIS_ENGINE && job.analysisEngineVersion === LOCAL_BASS_ANALYSIS_ENGINE_VERSION;
  if (!valid) {
    await rejectPayload(database, bassAnalyses, job.id, job.sourceChecksumSha256, "Local bass analysis payload does not match its versioned target.");
    throw new Error("Local bass analysis payload does not match its durable target.");
  }
  const [source] = await database.select().from(sourceAssets).where(and(eq(sourceAssets.id, job.sourceAssetId), eq(sourceAssets.projectId, job.projectId))).limit(1);
  const [stem] = await database.select().from(stemAssets).where(and(eq(stemAssets.id, job.stemAssetId), eq(stemAssets.projectId, job.projectId))).limit(1);
  const provenance = source && stem ? bassAnalysisProvenanceReason({
    sourceAssetId: job.sourceAssetId, expectedSourceAssetId: source.id,
    stemAssetId: job.stemAssetId, expectedStemAssetId: stem.id,
    sourceChecksumSha256: job.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: job.stemChecksumSha256, expectedStemChecksumSha256: stem.checksumSha256,
    analysisEngine: job.analysisEngine, analysisEngineVersion: job.analysisEngineVersion,
  }) : "source_stem_mismatch";
  if (!source || !stem || stem.stemType !== "bass" || provenance) {
    await database.update(bassAnalyses).set({
      status: "failed", stage: "provenance-failed", errorCode: "analysis_stale",
      errorMessage: "The source or isolated bass stem changed before analysis.",
      completedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(bassAnalyses.id, job.id), eq(bassAnalyses.status, job.status)));
    throw new Error("The source or isolated bass stem changed before analysis.");
  }
  const [claimed] = await database.update(bassAnalyses).set({
    status: "preparing", stage: "preparing", attempts: job.attempts + 1, errorCode: null,
    errorMessage: null, startedAt: new Date(), completedAt: null, updatedAt: new Date(),
  }).where(and(eq(bassAnalyses.id, job.id), eq(bassAnalyses.status, job.status))).returning({ id: bassAnalyses.id });
  if (!claimed || !active(job.status)) return;
  const [processing] = await database.update(bassAnalyses).set({ status: "processing", stage: "analyzing", updatedAt: new Date() })
    .where(and(eq(bassAnalyses.id, job.id), eq(bassAnalyses.status, "preparing"))).returning({ id: bassAnalyses.id });
  if (!processing) return;
  try {
    const inputPath = await prepareStemFile(storage, stem.storageKey);
    try {
      if (await fileSha256(inputPath) !== job.stemChecksumSha256) {
        throw new Error("The stored bass stem bytes do not match their saved checksum.");
      }
      const pcm = await decode(inputPath);
      if (pcm.length < 2_205) throw new Error("The isolated bass stem is too short for attack analysis.");
      const events = normaliseBassEvents(detectBassAttacks(pcm), Math.round(source.durationSeconds * 1000));
      if (events === null) throw new Error("The local DSP engine returned invalid bass attack events.");
      const [sourceTempo] = await database.select({ beatGrid: sourceAnalyses.beatGrid }).from(sourceAnalyses)
        .where(and(eq(sourceAnalyses.sourceAssetId, source.id), eq(sourceAnalyses.status, "complete"))).limit(1);
      const beatGrid = parseBeatGrid(sourceTempo?.beatGrid ?? null);
      const analyzedAt = new Date();
      await database.transaction(async (tx) => {
        const [currentSource] = await tx.select().from(sourceAssets).where(eq(sourceAssets.id, source.id)).for("update").limit(1);
        const [currentStem] = await tx.select().from(stemAssets).where(eq(stemAssets.id, stem.id)).for("update").limit(1);
        if (!currentSource || !currentStem || currentSource.checksumSha256 !== job.sourceChecksumSha256
          || currentStem.checksumSha256 !== job.stemChecksumSha256) {
          throw new Error("The source or isolated bass stem changed while it was being analyzed.");
        }
        await tx.delete(bassEvents).where(eq(bassEvents.bassAnalysisId, job.id));
        if (events.length) await tx.insert(bassEvents).values(events.map((event, eventIndex) => {
          const beatIndex = beatGrid ? nearestBeatIndex(event.timestampMs, beatGrid) : null;
          return {
            bassAnalysisId: job.id,
            eventIndex,
            ...event,
            nearestBeatIndex: beatIndex,
            beatOffsetMs: beatIndex === null ? null : event.timestampMs - beatGrid![beatIndex]!,
          };
        }));
        const [completed] = await tx.update(bassAnalyses).set({
          status: "complete", stage: "complete",
          analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE,
          analysisEngineVersion: LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
          errorCode: null, errorMessage: null, analyzedAt, completedAt: analyzedAt, updatedAt: analyzedAt,
        }).where(and(
          eq(bassAnalyses.id, job.id),
          eq(bassAnalyses.status, "processing"),
          eq(bassAnalyses.sourceChecksumSha256, job.sourceChecksumSha256),
          eq(bassAnalyses.stemChecksumSha256, job.stemChecksumSha256),
        )).returning({ id: bassAnalyses.id });
        if (!completed) throw new Error("Bass analysis lost its active durable claim before completion.");
      });
    } finally { await removeStemFile(inputPath); }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local bass analysis failed.";
    const stale = /checksum|changed while/i.test(message);
    await database.update(bassAnalyses).set({
      status: "failed", stage: stale ? "provenance-failed" : "failed",
      errorCode: stale ? "analysis_stale" : "analysis_failed",
      errorMessage: message.slice(0, 1000),
      completedAt: new Date(), updatedAt: new Date(),
    }).where(and(
      eq(bassAnalyses.id, job.id),
      eq(bassAnalyses.status, "processing"),
      eq(bassAnalyses.sourceChecksumSha256, job.sourceChecksumSha256),
      eq(bassAnalyses.stemChecksumSha256, job.stemChecksumSha256),
    ));
    throw error;
  }
}

export async function handleHarmonyAnalysisJob(payloadInput: Record<string, unknown>, deps: StemAnalysisDeps = {}): Promise<void> {
  const payload = payloadInput as unknown as HarmonyAnalysisJobPayload;
  const database = deps.db ?? defaultDb;
  const storage = deps.storage ?? getStorage();
  const decode = deps.decode ?? decodeMonoPcm;
  const [job] = await database.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.id, payload.harmonyAnalysisId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  const valid = job.projectId === payload.projectId && job.sourceAssetId === payload.sourceAssetId
    && job.analysisEngine === payload.analysisEngine && job.analysisEngineVersion === payload.analysisEngineVersion
    && job.analysisEngine === LOCAL_HARMONY_ANALYSIS_ENGINE && job.analysisEngineVersion === LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION;
  if (!valid) {
    await database.update(harmonyAnalyses).set({ status: "failed", stage: "invalid-payload", errorCode: "invalid_payload", errorMessage: "Local harmony analysis payload does not match its versioned target.", completedAt: new Date(), updatedAt: new Date() }).where(eq(harmonyAnalyses.id, job.id));
    throw new Error("Local harmony analysis payload does not match its durable target.");
  }
  const [source] = await database.select().from(sourceAssets).where(and(eq(sourceAssets.id, job.sourceAssetId), eq(sourceAssets.projectId, job.projectId))).limit(1);
  const reason = source ? harmonyAnalysisProvenanceReason({ sourceAssetId: job.sourceAssetId, expectedSourceAssetId: source.id,
    sourceChecksumSha256: job.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
    analysisEngine: job.analysisEngine, analysisEngineVersion: job.analysisEngineVersion,
  }, { engine: LOCAL_HARMONY_ANALYSIS_ENGINE, version: LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION }) : "source_identity_mismatch";
  if (!source || reason) {
    await database.update(harmonyAnalyses).set({ status: "failed", stage: "provenance-failed", errorCode: "analysis_stale", errorMessage: "The source changed before harmony analysis.", completedAt: new Date(), updatedAt: new Date() }).where(and(eq(harmonyAnalyses.id, job.id), eq(harmonyAnalyses.status, job.status)));
    throw new Error("The source changed before harmony analysis.");
  }
  const [claimed] = await database.update(harmonyAnalyses).set({ status: "preparing", stage: "preparing", attempts: job.attempts + 1,
    errorCode: null, errorMessage: null, startedAt: new Date(), completedAt: null, updatedAt: new Date(),
  }).where(and(eq(harmonyAnalyses.id, job.id), eq(harmonyAnalyses.status, job.status))).returning({ id: harmonyAnalyses.id });
  if (!claimed || !active(job.status)) return;
  const [processing] = await database.update(harmonyAnalyses).set({ status: "processing", stage: "analyzing", updatedAt: new Date() })
    .where(and(eq(harmonyAnalyses.id, job.id), eq(harmonyAnalyses.status, "preparing"))).returning({ id: harmonyAnalyses.id });
  if (!processing) return;
  let inputPath: string | undefined;
  try {
    inputPath = await prepareStemFile(storage, source.storageKey);
    const pcm = await decode(inputPath);
    if (pcm.length < 2_205) throw new Error("Source audio is too short for harmony analysis.");
    const raw = detectHarmonyTimeline(pcm);
    const events = normaliseHarmonyEvents(raw, Math.round(source.durationSeconds * 1000));
    if (events === null) throw new Error("The local DSP engine returned invalid harmony events.");
    const analyzedAt = new Date();
    await database.transaction(async (tx) => {
      const [currentSource] = await tx.select().from(sourceAssets).where(eq(sourceAssets.id, source.id)).for("update").limit(1);
      if (!currentSource || currentSource.checksumSha256 !== job.sourceChecksumSha256) throw new Error("Source audio changed while harmony was being analyzed.");
      await tx.delete(harmonyEvents).where(eq(harmonyEvents.harmonyAnalysisId, job.id));
      if (events.length) await tx.insert(harmonyEvents).values(events.map((event, eventIndex) => ({ harmonyAnalysisId: job.id, eventIndex, ...event })));
      const [completed] = await tx.update(harmonyAnalyses).set({ status: "complete", stage: "complete", analysisEngine: LOCAL_HARMONY_ANALYSIS_ENGINE,
        analysisEngineVersion: LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION, errorCode: null, errorMessage: null,
        analyzedAt, completedAt: analyzedAt, updatedAt: analyzedAt,
      }).where(and(eq(harmonyAnalyses.id, job.id), eq(harmonyAnalyses.status, "processing"), eq(harmonyAnalyses.sourceChecksumSha256, job.sourceChecksumSha256))).returning({ id: harmonyAnalyses.id });
      if (!completed) throw new Error("Harmony analysis lost its active durable claim before completion.");
    });
  } catch (error) {
    await database.update(harmonyAnalyses).set({ status: "failed", stage: "failed", errorCode: "analysis_failed",
      errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Local harmony analysis failed.", completedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(harmonyAnalyses.id, job.id), eq(harmonyAnalyses.status, "processing"), eq(harmonyAnalyses.sourceChecksumSha256, job.sourceChecksumSha256)));
    throw error;
  } finally { if (inputPath) await removeStemFile(inputPath); }
}

export async function handleVocalAnalysisJob(payloadInput: Record<string, unknown>, deps: StemAnalysisDeps = {}): Promise<void> {
  const payload = payloadInput as unknown as VocalAnalysisJobPayload;
  const database = deps.db ?? defaultDb;
  const storage = deps.storage ?? getStorage();
  const decode = deps.decode ?? decodeMonoPcm;
  const [job] = await database.select().from(vocalAnalyses).where(eq(vocalAnalyses.id, payload.vocalAnalysisId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  const valid = job.projectId === payload.projectId && job.sourceAssetId === payload.sourceAssetId && job.stemAssetId === payload.stemAssetId
    && job.analysisEngine === payload.analysisEngine && job.analysisEngineVersion === payload.analysisEngineVersion
    && job.analysisEngine === LOCAL_VOCAL_ANALYSIS_ENGINE && job.analysisEngineVersion === LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION;
  if (!valid) {
    await database.update(vocalAnalyses).set({
      status: "failed",
      stage: "invalid-payload",
      errorCode: "invalid_payload",
      errorMessage: "Local vocal analysis payload does not match its versioned target.",
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(vocalAnalyses.id, job.id),
      eq(vocalAnalyses.status, job.status),
      eq(vocalAnalyses.projectId, payload.projectId),
      eq(vocalAnalyses.sourceAssetId, payload.sourceAssetId),
      eq(vocalAnalyses.stemAssetId, payload.stemAssetId),
      eq(vocalAnalyses.analysisEngine, payload.analysisEngine),
      eq(vocalAnalyses.analysisEngineVersion, payload.analysisEngineVersion),
    ));
    throw new Error("Local vocal analysis payload does not match its durable target.");
  }
  const [source] = await database.select().from(sourceAssets).where(and(eq(sourceAssets.id, job.sourceAssetId), eq(sourceAssets.projectId, job.projectId))).limit(1);
  const [stem] = await database.select().from(stemAssets).where(and(eq(stemAssets.id, job.stemAssetId), eq(stemAssets.projectId, job.projectId))).limit(1);
  const reason = source && stem ? vocalAnalysisProvenanceReason({
    sourceAssetId: job.sourceAssetId, expectedSourceAssetId: source.id,
    stemAssetId: job.stemAssetId, expectedStemAssetId: stem.id,
    sourceChecksumSha256: job.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: job.stemChecksumSha256, expectedStemChecksumSha256: stem.checksumSha256,
    analysisEngine: job.analysisEngine, analysisEngineVersion: job.analysisEngineVersion,
  }, { engine: LOCAL_VOCAL_ANALYSIS_ENGINE, version: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION }) : "source_stem_mismatch";
  if (!source || !stem || stem.stemType !== "vocals" || reason) {
    await database.update(vocalAnalyses).set({ status: "failed", stage: "provenance-failed", errorCode: "analysis_stale", errorMessage: "The source or isolated vocal stem changed before analysis.", completedAt: new Date(), updatedAt: new Date() }).where(and(eq(vocalAnalyses.id, job.id), eq(vocalAnalyses.status, job.status)));
    throw new Error("The source or isolated vocal stem changed before analysis.");
  }
  const [claimed] = await database.update(vocalAnalyses).set({ status: "preparing", stage: "preparing", attempts: job.attempts + 1,
    errorCode: null, errorMessage: null, startedAt: new Date(), completedAt: null, updatedAt: new Date(),
  }).where(and(eq(vocalAnalyses.id, job.id), eq(vocalAnalyses.status, job.status))).returning({ id: vocalAnalyses.id });
  if (!claimed || !active(job.status)) return;
  const [processing] = await database.update(vocalAnalyses).set({ status: "processing", stage: "analyzing", updatedAt: new Date() })
    .where(and(eq(vocalAnalyses.id, job.id), eq(vocalAnalyses.status, "preparing"))).returning({ id: vocalAnalyses.id });
  if (!processing) return;
  let inputPath: string | undefined;
  try {
    inputPath = await prepareStemFile(storage, stem.storageKey);
    const pcm = await decode(inputPath);
    if (pcm.length < 2_205) throw new Error("The isolated vocal stem is too short for pitch analysis.");
    const decodedDurationMs = Math.floor((pcm.length * 1000) / ANALYSIS_PCM_RATE);
    const frames = normaliseVocalPitchFrames(detectVocalPitchFrames(pcm), decodedDurationMs);
    if (frames === null) throw new Error("The local DSP engine returned invalid vocal pitch frames.");
    // Keep voiced pitch-continuity candidates and acoustic vocal-stem activity
    // as separate signals. The latter captures unvoiced consonants and
    // pitchless/breathy material; it is never presented as lyric segmentation.
    const phrases = segmentVocalPhrases(frames);
    const activityIntervals = detectVocalActivityIntervals(pcm, frames);
    const analyzedAt = new Date();
    await database.transaction(async (tx) => {
      const [currentSource] = await tx.select().from(sourceAssets).where(eq(sourceAssets.id, source.id)).for("update").limit(1);
      const [currentStem] = await tx.select().from(stemAssets).where(eq(stemAssets.id, stem.id)).for("update").limit(1);
      if (!currentSource || !currentStem || currentSource.checksumSha256 !== job.sourceChecksumSha256 || currentStem.checksumSha256 !== job.stemChecksumSha256)
        throw new Error("The source or isolated vocal stem changed while it was being analyzed.");
      await tx.delete(vocalPitchFrames).where(eq(vocalPitchFrames.vocalAnalysisId, job.id));
      await tx.delete(vocalPhrases).where(eq(vocalPhrases.vocalAnalysisId, job.id));
      await tx.delete(vocalActivityIntervals).where(eq(vocalActivityIntervals.vocalAnalysisId, job.id));
      if (frames.length) await tx.insert(vocalPitchFrames).values(frames.map((frame, frameIndex) => ({ vocalAnalysisId: job.id, frameIndex, ...frame })));
      if (phrases.length) await tx.insert(vocalPhrases).values(phrases.map((phrase, phraseIndex) => ({ vocalAnalysisId: job.id, phraseIndex, ...phrase })));
      if (activityIntervals.length) await tx.insert(vocalActivityIntervals).values(activityIntervals.map((interval, intervalIndex) => ({
        vocalAnalysisId: job.id, intervalIndex, ...interval,
      })));
      const [completed] = await tx.update(vocalAnalyses).set({ status: "complete", stage: "complete", analysisEngine: LOCAL_VOCAL_ANALYSIS_ENGINE,
        analysisEngineVersion: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION, errorCode: null, errorMessage: null,
        analyzedAt, completedAt: analyzedAt, updatedAt: analyzedAt,
      }).where(and(eq(vocalAnalyses.id, job.id), eq(vocalAnalyses.status, "processing"), eq(vocalAnalyses.sourceChecksumSha256, job.sourceChecksumSha256), eq(vocalAnalyses.stemChecksumSha256, job.stemChecksumSha256))).returning({ id: vocalAnalyses.id });
      if (!completed) throw new Error("Vocal analysis lost its active durable claim before completion.");
    });
    try {
      const [sourceAnalysis] = await database.select().from(sourceAnalyses).where(and(
        eq(sourceAnalyses.sourceAssetId, source.id),
        eq(sourceAnalyses.status, "complete"),
        eq(sourceAnalyses.sourceChecksumSha256, job.sourceChecksumSha256),
      )).limit(1);
      if (sourceAnalysis) {
        const dispatchKey = createHash("sha256")
          .update(`vocal-section:${job.id}:${job.sourceChecksumSha256}:${job.stemChecksumSha256}`)
          .digest("hex")
          .slice(0, 24);
        await provisionDesktopSectionAnalysis(sourceAnalysis, source, {
          database,
          dispatchKey,
          enqueue: deps.enqueueSectionAnalysis,
        });
      }
    } catch (sectionRefreshError) {
      // Keep the completed vocal evidence even if its optional structural
      // refresh cannot be queued. A later source analysis consumes it.
      console.warn("could not refresh Waveyard sections after vocal analysis", sectionRefreshError);
    }
  } catch (error) {
    await database.update(vocalAnalyses).set({ status: "failed", stage: "failed", errorCode: "analysis_failed",
      errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Local vocal analysis failed.", completedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(vocalAnalyses.id, job.id), eq(vocalAnalyses.status, "processing"), eq(vocalAnalyses.sourceChecksumSha256, job.sourceChecksumSha256)));
    throw error;
  } finally { if (inputPath) await removeStemFile(inputPath); }
}
