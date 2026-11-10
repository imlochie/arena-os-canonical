import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

import { sourceAnalyses } from "@workspace/db/waveyardSchema";
import { enqueueSourceAnalysis } from "./queue";
import type { SourceAnalysisJobPayload } from "./types";

export type SourceAnalysisDb = ReturnType<typeof drizzle>;
type AnalysisRow = typeof sourceAnalyses.$inferSelect;

export type SourceAnalysisRetryResult =
  | { kind: "queued"; analysis: AnalysisRow }
  | { kind: "not-found" }
  | { kind: "not-retryable"; analysis: AnalysisRow }
  | { kind: "queue-refused"; analysis: AnalysisRow; reason: string };

export type SourceAnalysisRetryOptions = {
  /** Test seam and server queue hand-off. Called only after the row is queued. */
  handOff?: (analysis: AnalysisRow) => Promise<void>;
};

async function enqueueFromRow(analysis: AnalysisRow): Promise<void> {
  const payload: SourceAnalysisJobPayload = {
    sourceAnalysisId: analysis.id,
    projectId: analysis.projectId,
    sourceAssetId: analysis.sourceAssetId,
    analysisEngine: analysis.analysisEngine,
    analysisEngineVersion: analysis.analysisEngineVersion,
  };
  await enqueueSourceAnalysis(payload);
}

/** Claim the failed row before asking a worker to retry it. */
export async function retryFailedSourceAnalysis(
  db: SourceAnalysisDb,
  analysisId: string,
  options: SourceAnalysisRetryOptions = {},
): Promise<SourceAnalysisRetryResult> {
  const [failed] = await db.select().from(sourceAnalyses)
    .where(eq(sourceAnalyses.id, analysisId)).limit(1);
  if (!failed) return { kind: "not-found" };
  if (failed.status !== "failed") return { kind: "not-retryable", analysis: failed };

  const [claimed] = await db.update(sourceAnalyses).set({
    status: "queued",
    stage: "queued",
    errorCode: null,
    analysisError: null,
    bpm: null,
    bpmConfidence: null,
    musicalKey: null,
    keyConfidence: null,
    beatGrid: null,
    beatConfidence: null,
    startedAt: null,
    analyzedAt: null,
    completedAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(sourceAnalyses.id, failed.id),
    eq(sourceAnalyses.status, "failed"),
  )).returning();

  if (!claimed) {
    const [current] = await db.select().from(sourceAnalyses)
      .where(eq(sourceAnalyses.id, analysisId)).limit(1);
    return current
      ? { kind: "not-retryable", analysis: current }
      : { kind: "not-found" };
  }

  try {
    await (options.handOff ?? enqueueFromRow)(claimed);
    return { kind: "queued", analysis: claimed };
  } catch (error) {
    // If the worker already advanced the row, preserve its live status. Only
    // restore the original failure when the row is still waiting for a worker.
    const [restored] = await db.update(sourceAnalyses).set({
      status: failed.status,
      stage: failed.stage,
      errorCode: failed.errorCode,
      analysisError: failed.analysisError,
      bpm: failed.bpm,
      bpmConfidence: failed.bpmConfidence,
      musicalKey: failed.musicalKey,
      keyConfidence: failed.keyConfidence,
      beatGrid: failed.beatGrid,
      beatConfidence: failed.beatConfidence,
      startedAt: failed.startedAt,
      analyzedAt: failed.analyzedAt,
      completedAt: failed.completedAt,
      updatedAt: new Date(),
    }).where(and(
      eq(sourceAnalyses.id, failed.id),
      eq(sourceAnalyses.status, "queued"),
    )).returning();

    if (restored) {
      return {
        kind: "queue-refused",
        analysis: restored,
        reason: error instanceof Error ? error.message : "The analysis could not be re-queued.",
      };
    }
    const [current] = await db.select().from(sourceAnalyses)
      .where(eq(sourceAnalyses.id, analysisId)).limit(1);
    return current
      ? { kind: "queued", analysis: current }
      : { kind: "not-found" };
  }
}
