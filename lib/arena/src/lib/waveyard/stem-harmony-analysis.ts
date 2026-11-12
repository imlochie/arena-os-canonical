import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

import { stemHarmonyAnalyses, stemHarmonyEvents } from "@workspace/db/waveyardSchema";
import { enqueueStemHarmonyAnalysis } from "./queue";
import { localWorkerActive } from "./worker-local/broker";
import {
  LOCAL_STEM_HARMONY_ANALYSIS_ENGINE,
  LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION,
  stemHarmonyAnalysisIdempotencyKey,
  stemHarmonyAnalysisProvenanceReason,
  STEM_HARMONY_STEM_TYPES,
} from "./types/stem-harmony-analysis";

type AnalysisDb = ReturnType<typeof drizzle>;
type SourceIdentity = { id: string; projectId: string; checksumSha256: string };
type StemIdentity = {
  id: string;
  projectId: string;
  sourceAssetId: string;
  stemType: string;
  checksumSha256: string;
};

/** Prefer a purpose-made instrumental, then the general harmonic remainder. */
export function chooseStemForHarmony<T extends Pick<StemIdentity, "stemType">>(stems: readonly T[]): T | null {
  const priorities = ["instrumental", "other", "piano", "guitar"] as const;
  for (const type of priorities) {
    if (!STEM_HARMONY_STEM_TYPES.includes(type)) continue;
    const stem = stems.find((candidate) => candidate.stemType === type);
    if (stem) return stem;
  }
  return null;
}

/**
 * Create or refresh chord analysis for one exact separated non-vocal stem.
 * Missing local execution is reported instead of routing this CPU DSP job to
 * a provider that cannot run it.
 */
export async function ensureStemHarmonyAnalysis(
  database: AnalysisDb,
  source: SourceIdentity,
  stem: StemIdentity,
  enqueue: typeof enqueueStemHarmonyAnalysis = enqueueStemHarmonyAnalysis,
) {
  if (!localWorkerActive() && enqueue === enqueueStemHarmonyAnalysis) {
    return { analysis: null, queued: false, workerUnavailable: true };
  }
  if (stem.projectId !== source.projectId || stem.sourceAssetId !== source.id
    || !STEM_HARMONY_STEM_TYPES.includes(stem.stemType as (typeof STEM_HARMONY_STEM_TYPES)[number])) {
    return { analysis: null, queued: false, workerUnavailable: false, stale: true };
  }

  const key = stemHarmonyAnalysisIdempotencyKey(stem.id);
  const [created] = await database.insert(stemHarmonyAnalyses).values({
    projectId: source.projectId,
    sourceAssetId: source.id,
    stemAssetId: stem.id,
    status: "queued",
    stage: "queued",
    idempotencyKey: key,
    analysisEngine: LOCAL_STEM_HARMONY_ANALYSIS_ENGINE,
    analysisEngineVersion: LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION,
    sourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: stem.checksumSha256,
  }).onConflictDoNothing({ target: stemHarmonyAnalyses.stemAssetId }).returning();

  let analysis = created ?? (await database.select().from(stemHarmonyAnalyses)
    .where(eq(stemHarmonyAnalyses.stemAssetId, stem.id)).limit(1))[0];
  if (!analysis) throw new Error("Could not resolve durable stem-harmony analysis.");

  const staleReason = stemHarmonyAnalysisProvenanceReason({
    sourceAssetId: analysis.sourceAssetId,
    expectedSourceAssetId: source.id,
    stemAssetId: analysis.stemAssetId,
    expectedStemAssetId: stem.id,
    stemType: stem.stemType,
    sourceChecksumSha256: analysis.sourceChecksumSha256,
    expectedSourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: analysis.stemChecksumSha256,
    expectedStemChecksumSha256: stem.checksumSha256,
    analysisEngine: analysis.analysisEngine,
    analysisEngineVersion: analysis.analysisEngineVersion,
  });

  let shouldQueue = Boolean(created);
  if (!created && staleReason && staleReason !== "source_stem_mismatch" && staleReason !== "stem_type_mismatch") {
    const previous = analysis;
    const [refreshed] = await database.transaction(async (tx) => {
      const [row] = await tx.update(stemHarmonyAnalyses).set({
        status: "queued",
        stage: "queued",
        attempts: 0,
        idempotencyKey: key,
        analysisEngine: LOCAL_STEM_HARMONY_ANALYSIS_ENGINE,
        analysisEngineVersion: LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION,
        sourceChecksumSha256: source.checksumSha256,
        stemChecksumSha256: stem.checksumSha256,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        analyzedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(stemHarmonyAnalyses.id, previous.id),
        eq(stemHarmonyAnalyses.sourceChecksumSha256, previous.sourceChecksumSha256),
        eq(stemHarmonyAnalyses.stemChecksumSha256, previous.stemChecksumSha256),
        eq(stemHarmonyAnalyses.analysisEngine, previous.analysisEngine),
        eq(stemHarmonyAnalyses.analysisEngineVersion, previous.analysisEngineVersion),
      )).returning();
      if (row) await tx.delete(stemHarmonyEvents).where(eq(stemHarmonyEvents.stemHarmonyAnalysisId, previous.id));
      return [row];
    });
    if (refreshed) {
      analysis = refreshed;
      shouldQueue = true;
    } else {
      analysis = (await database.select().from(stemHarmonyAnalyses)
        .where(eq(stemHarmonyAnalyses.stemAssetId, stem.id)).limit(1))[0]!;
    }
  }

  if (staleReason && !shouldQueue) return { analysis, queued: false, workerUnavailable: false, stale: true };
  if (!created && analysis.status === "failed" && !shouldQueue) {
    const [retried] = await database.update(stemHarmonyAnalyses).set({
      status: "queued",
      stage: "queued",
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(stemHarmonyAnalyses.id, analysis.id),
      eq(stemHarmonyAnalyses.status, "failed"),
      eq(stemHarmonyAnalyses.sourceChecksumSha256, source.checksumSha256),
      eq(stemHarmonyAnalyses.stemChecksumSha256, stem.checksumSha256),
      eq(stemHarmonyAnalyses.analysisEngine, LOCAL_STEM_HARMONY_ANALYSIS_ENGINE),
      eq(stemHarmonyAnalyses.analysisEngineVersion, LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION),
    )).returning();
    shouldQueue = Boolean(retried);
    if (retried) analysis = retried;
  }

  if (shouldQueue) {
    try {
      await enqueue({
        stemHarmonyAnalysisId: analysis.id,
        projectId: analysis.projectId,
        sourceAssetId: analysis.sourceAssetId,
        stemAssetId: analysis.stemAssetId,
        analysisEngine: analysis.analysisEngine,
        analysisEngineVersion: analysis.analysisEngineVersion,
      });
    } catch (error) {
      await database.update(stemHarmonyAnalyses).set({
        status: "failed",
        stage: "queue-unavailable",
        errorCode: "queue_unavailable",
        errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.",
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(stemHarmonyAnalyses.id, analysis.id),
        eq(stemHarmonyAnalyses.status, "queued"),
        eq(stemHarmonyAnalyses.sourceChecksumSha256, source.checksumSha256),
        eq(stemHarmonyAnalyses.stemChecksumSha256, stem.checksumSha256),
      ));
      throw error;
    }
  }

  const [current] = await database.select().from(stemHarmonyAnalyses)
    .where(eq(stemHarmonyAnalyses.id, analysis.id)).limit(1);
  return { analysis: current ?? analysis, queued: shouldQueue, workerUnavailable: false, stale: false };
}
