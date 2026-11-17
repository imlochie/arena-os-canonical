import { and, asc, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { db } from "@workspace/db";
import {
  drumAnalyses,
  drumEvents,
} from "@workspace/db/waveyardSchema";
import { enqueueDrumAnalysis } from "./queue";
import { localWorkerActive } from "./worker-local/broker";
import {
  drumAnalysisIdempotencyKey,
  drumAnalysisProvenanceReason,
  isSupportedDrumStemType,
  LOCAL_DRUM_ANALYSIS_ENGINE,
  LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
} from "./types/drum-analysis";

type AnalysisDb = ReturnType<typeof drizzle>;
type SourceIdentity = { id: string; projectId: string; checksumSha256: string };
type StemIdentity = {
  id: string;
  projectId: string;
  sourceAssetId: string;
  stemType: string;
  checksumSha256: string;
};

/**
 * Ensure local tempo/beat analysis exists for one exact isolated drum stem.
 * Foreign-engine results are preserved; stale local results are invalidated
 * and retried through the local DSP queue.
 */
export async function ensureLocalDrumTempoAnalysis(
  source: SourceIdentity,
  stem: StemIdentity,
  options: {
    database?: AnalysisDb;
    enqueue?: typeof enqueueDrumAnalysis;
  } = {},
) {
  const database = options.database ?? db;
  const enqueue = options.enqueue ?? enqueueDrumAnalysis;
  if (
    source.id.length === 0
    || stem.projectId !== source.projectId
    || stem.sourceAssetId !== source.id
    || !isSupportedDrumStemType(stem.stemType)
  ) return { analysis: null, queued: false, workerUnavailable: false, stale: true };

  if (!localWorkerActive() && enqueue === enqueueDrumAnalysis) {
    return { analysis: null, queued: false, workerUnavailable: true };
  }

  const idempotencyKey = drumAnalysisIdempotencyKey(
    stem.id,
    LOCAL_DRUM_ANALYSIS_ENGINE,
    LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
  );
  const [created] = await database.insert(drumAnalyses).values({
    projectId: source.projectId,
    sourceAssetId: source.id,
    stemAssetId: stem.id,
    status: "queued",
    stage: "queued",
    idempotencyKey,
    analysisEngine: LOCAL_DRUM_ANALYSIS_ENGINE,
    analysisEngineVersion: LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
    sourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: stem.checksumSha256,
  }).onConflictDoNothing({ target: drumAnalyses.stemAssetId }).returning();

  let analysis = created ?? (await database.select().from(drumAnalyses)
    .where(eq(drumAnalyses.stemAssetId, stem.id)).limit(1))[0] ?? null;
  if (!analysis) throw new Error("Could not resolve durable drum tempo analysis.");
  if (analysis.analysisEngine !== LOCAL_DRUM_ANALYSIS_ENGINE) {
    return { analysis, queued: false, workerUnavailable: false, stale: true };
  }

  const staleReason = drumAnalysisProvenanceReason({
    sourceAssetId: analysis.sourceAssetId,
    expectedSourceAssetId: source.id,
    stemAssetId: analysis.stemAssetId,
    expectedStemAssetId: stem.id,
    sourceChecksumSha256: analysis.sourceChecksumSha256,
    expectedSourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: analysis.stemChecksumSha256,
    expectedStemChecksumSha256: stem.checksumSha256,
    analysisEngine: analysis.analysisEngine,
    analysisEngineVersion: analysis.analysisEngineVersion,
  }, { engine: LOCAL_DRUM_ANALYSIS_ENGINE, version: LOCAL_DRUM_ANALYSIS_ENGINE_VERSION });
  if (!created && analysis.status === "processing") {
    return { analysis, queued: false, workerUnavailable: false, ...(staleReason ? { stale: true } : {}) };
  }

  let shouldQueue = Boolean(created);
  if (!created && staleReason) {
    const previous = analysis;
    const [refreshed] = await database.transaction(async (tx) => {
      const [row] = await tx.update(drumAnalyses).set({
        status: "queued",
        stage: "queued",
        attempts: 0,
        idempotencyKey,
        analysisEngine: LOCAL_DRUM_ANALYSIS_ENGINE,
        analysisEngineVersion: LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
        sourceChecksumSha256: source.checksumSha256,
        stemChecksumSha256: stem.checksumSha256,
        bpm: null,
        bpmConfidence: null,
        beatGrid: null,
        beatConfidence: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        analyzedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(drumAnalyses.id, previous.id),
        eq(drumAnalyses.sourceChecksumSha256, previous.sourceChecksumSha256),
        eq(drumAnalyses.stemChecksumSha256, previous.stemChecksumSha256),
        eq(drumAnalyses.analysisEngine, previous.analysisEngine),
        eq(drumAnalyses.analysisEngineVersion, previous.analysisEngineVersion),
      )).returning();
      if (row) await tx.delete(drumEvents).where(eq(drumEvents.drumAnalysisId, previous.id));
      return [row];
    });
    if (refreshed) {
      analysis = refreshed;
      shouldQueue = true;
    } else {
      analysis = (await database.select().from(drumAnalyses)
        .where(eq(drumAnalyses.stemAssetId, stem.id)).limit(1))[0] ?? null;
      if (!analysis) throw new Error("Drum tempo analysis disappeared during refresh.");
    }
  }

  if (!created && !shouldQueue && analysis.status === "failed") {
    const [retried] = await database.update(drumAnalyses).set({
      status: "queued",
      stage: "queued",
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(drumAnalyses.id, analysis.id),
      eq(drumAnalyses.status, "failed"),
      eq(drumAnalyses.sourceChecksumSha256, source.checksumSha256),
      eq(drumAnalyses.stemChecksumSha256, stem.checksumSha256),
      eq(drumAnalyses.analysisEngine, LOCAL_DRUM_ANALYSIS_ENGINE),
      eq(drumAnalyses.analysisEngineVersion, LOCAL_DRUM_ANALYSIS_ENGINE_VERSION),
    )).returning();
    shouldQueue = Boolean(retried);
    if (retried) analysis = retried;
  }

  if (shouldQueue) {
    try {
      await enqueue({
        drumAnalysisId: analysis.id,
        projectId: analysis.projectId,
        sourceAssetId: analysis.sourceAssetId,
        stemAssetId: analysis.stemAssetId,
        analysisEngine: analysis.analysisEngine,
        analysisEngineVersion: analysis.analysisEngineVersion,
      });
    } catch (error) {
      const [failed] = await database.update(drumAnalyses).set({
        status: "failed",
        stage: "queue-unavailable",
        errorCode: "queue_unavailable",
        errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Local drum analysis queue unavailable.",
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(drumAnalyses.id, analysis.id),
        eq(drumAnalyses.status, "queued"),
        eq(drumAnalyses.sourceChecksumSha256, source.checksumSha256),
        eq(drumAnalyses.stemChecksumSha256, stem.checksumSha256),
      )).returning();
      analysis = failed ?? analysis;
      return { analysis, queued: false, workerUnavailable: true };
    }
  }

  return { analysis, queued: shouldQueue, workerUnavailable: false };
}

/** Auth-scoped callers get one isolated-stem rhythmic evidence document. */
export async function getDrumAnalysis(projectId: string, stemAssetId: string) {
  
  const [analysis] = await db.select().from(drumAnalyses).where(and(
    eq(drumAnalyses.projectId, projectId), eq(drumAnalyses.stemAssetId, stemAssetId),
  )).limit(1);
  if (!analysis) return { analysis: null, events: [] };
  const events = await db.select().from(drumEvents).where(eq(drumEvents.drumAnalysisId, analysis.id)).orderBy(asc(drumEvents.eventIndex));
  return { analysis, events };
}
