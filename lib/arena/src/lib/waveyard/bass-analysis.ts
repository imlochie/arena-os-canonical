import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

import { bassAnalyses } from "@workspace/db/waveyardSchema";
import { enqueueBassAnalysis } from "./queue";
import { localWorkerActive } from "./worker-local/broker";
import {
  bassAnalysisIdempotencyKey,
  bassAnalysisProvenanceReason,
  LOCAL_BASS_ANALYSIS_ENGINE,
  LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
} from "./types/bass-analysis";

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
 * Create or retry the durable local analysis for one exact bass stem.
 * Returns no row when this runtime cannot execute the local DSP job.
 */
export async function ensureBassAnalysis(
  db: AnalysisDb,
  source: SourceIdentity,
  stem: StemIdentity,
  enqueue: typeof enqueueBassAnalysis = enqueueBassAnalysis,
) {
  if (!localWorkerActive()) return { analysis: null, queued: false, workerUnavailable: true };
  if (stem.stemType !== "bass" || stem.projectId !== source.projectId || stem.sourceAssetId !== source.id) {
    return { analysis: null, queued: false, workerUnavailable: false, stale: true };
  }

  const [created] = await db.insert(bassAnalyses).values({
    projectId: source.projectId,
    sourceAssetId: source.id,
    stemAssetId: stem.id,
    status: "queued",
    stage: "queued",
    idempotencyKey: bassAnalysisIdempotencyKey(stem.id),
    analysisEngine: LOCAL_BASS_ANALYSIS_ENGINE,
    analysisEngineVersion: LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
    sourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: stem.checksumSha256,
  }).onConflictDoNothing({ target: bassAnalyses.stemAssetId }).returning();
  let analysis = created ?? (await db.select().from(bassAnalyses).where(eq(bassAnalyses.stemAssetId, stem.id)).limit(1))[0];
  if (!analysis) throw new Error("Could not resolve durable bass analysis.");

  const stale = bassAnalysisProvenanceReason({
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
  });
  if (stale) return { analysis, queued: false, workerUnavailable: false, stale: true };

  let shouldQueue = Boolean(created);
  if (!created && analysis.status === "failed") {
    const [retried] = await db.update(bassAnalyses).set({
      status: "queued",
      stage: "queued",
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(bassAnalyses.id, analysis.id),
      eq(bassAnalyses.status, "failed"),
      eq(bassAnalyses.sourceChecksumSha256, source.checksumSha256),
      eq(bassAnalyses.stemChecksumSha256, stem.checksumSha256),
    )).returning();
    shouldQueue = Boolean(retried);
    if (retried) analysis = retried;
  }

  if (shouldQueue) {
    try {
      await enqueue({
        bassAnalysisId: analysis.id,
        projectId: analysis.projectId,
        sourceAssetId: analysis.sourceAssetId,
        stemAssetId: analysis.stemAssetId,
        analysisEngine: analysis.analysisEngine,
        analysisEngineVersion: analysis.analysisEngineVersion,
      });
    } catch (error) {
      await db.update(bassAnalyses).set({
        status: "failed",
        stage: "queue-unavailable",
        errorCode: "queue_unavailable",
        errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.",
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(bassAnalyses.id, analysis.id),
        eq(bassAnalyses.status, "queued"),
        eq(bassAnalyses.sourceChecksumSha256, source.checksumSha256),
        eq(bassAnalyses.stemChecksumSha256, stem.checksumSha256),
      ));
      throw error;
    }
  }

  const [current] = await db.select().from(bassAnalyses).where(eq(bassAnalyses.id, analysis.id)).limit(1);
  return { analysis: current ?? analysis, queued: shouldQueue, workerUnavailable: false, stale: false };
}
