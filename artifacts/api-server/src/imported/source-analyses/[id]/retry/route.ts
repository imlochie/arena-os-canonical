
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  sourceAnalyses,
  sourceAssets,
  sourceSectionAnalyses,
  sourceSections,
} from "@workspace/db/waveyardSchema";
import { enqueueSourceAnalysis, getSourceAnalysisQueue } from "@workspace/arena/lib/waveyard/queue";
import { retryFailedSourceAnalysis } from "@workspace/arena/lib/waveyard/source-analysis-retry";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";
import {
  DESKTOP_ANALYSIS_ENGINE,
  DESKTOP_ANALYSIS_ENGINE_VERSION,
  desktopAnalysisIdempotencyKey,
  isStaleDesktopAnalysis,
} from "@workspace/arena/lib/waveyard/types/analysis-provenance";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    
    const [analysis] = await db
      .select()
      .from(sourceAnalyses)
      .where(eq(sourceAnalyses.id, id))
      .limit(1);
    if (!analysis)
      return Response.json({ error: "Analysis job not found." }, { status: 404 });
    await requireProjectRole(user.id, analysis.projectId, "editor");
    const refreshDesktopResult = isStaleDesktopAnalysis(analysis);
    const canRefreshCompleted = analysis.status === "complete" && refreshDesktopResult;
    const canRetryFailure = analysis.status === "failed";
    if (!canRefreshCompleted && !canRetryFailure)
      return Response.json(
        { error: "Only failed analysis jobs or outdated local analyses can be refreshed." },
        { status: 409 },
      );

    if (refreshDesktopResult) {
      const [source] = await db
        .select()
        .from(sourceAssets)
        .where(and(eq(sourceAssets.id, analysis.sourceAssetId), eq(sourceAssets.projectId, analysis.projectId)))
        .limit(1);
      if (!source) return Response.json({ error: "The original source audio is unavailable." }, { status: 404 });

      const now = new Date();
      const [updated] = await db
        .update(sourceAnalyses)
        .set({
          status: "queued",
          stage: "queued",
          attempts: 0,
          analysisEngine: DESKTOP_ANALYSIS_ENGINE,
          analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
          idempotencyKey: desktopAnalysisIdempotencyKey(analysis.sourceAssetId),
          sourceChecksumSha256: source.checksumSha256,
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
          updatedAt: now,
        })
        .where(and(
          eq(sourceAnalyses.id, analysis.id),
          eq(sourceAnalyses.status, analysis.status),
          analysis.analysisEngineVersion === null
            ? isNull(sourceAnalyses.analysisEngineVersion)
            : eq(sourceAnalyses.analysisEngineVersion, analysis.analysisEngineVersion),
        ))
        .returning();
      if (!updated) {
        const [current] = await db.select().from(sourceAnalyses).where(eq(sourceAnalyses.id, analysis.id)).limit(1);
        return current
          ? Response.json({ analysis: current })
          : Response.json({ error: "Analysis job not found." }, { status: 404 });
      }

      await db.delete(sourceSections).where(eq(sourceSections.sourceAssetId, analysis.sourceAssetId));
      await db.update(sourceSectionAnalyses).set({
        sourceAnalysisId: updated.id,
        status: "unavailable",
        stage: "source-analysis-refresh",
        errorCode: "analysis_refresh_pending",
        errorMessage: "Beat and key analysis is being refreshed; structural alignment will return when it completes.",
        startedAt: null,
        analyzedAt: null,
        completedAt: now,
        updatedAt: now,
      }).where(eq(sourceSectionAnalyses.sourceAssetId, analysis.sourceAssetId));

      try {
        const queue = await getSourceAnalysisQueue();
        try {
          const queueJob = await queue.getJob(analysis.id);
          if (queueJob) await queueJob.remove();
        } finally {
          await queue.close();
        }
        await enqueueSourceAnalysis({
          sourceAnalysisId: updated.id,
          projectId: updated.projectId,
          sourceAssetId: updated.sourceAssetId,
          analysisEngine: DESKTOP_ANALYSIS_ENGINE,
          analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
        });
      } catch (error) {
        await db.update(sourceAnalyses).set({
          status: "failed",
          stage: "queue-unavailable",
          errorCode: "queue_unavailable",
          analysisError: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.",
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(and(
          eq(sourceAnalyses.id, updated.id),
          eq(sourceAnalyses.status, "queued"),
        ));
        return Response.json({ error: "The analysis was reset but the worker queue is unavailable." }, { status: 503 });
      }
      return Response.json({ analysis: updated });
    }

    const result = await retryFailedSourceAnalysis(db, analysis.id, {
      handOff: async (claimed) => {
        const queue = await getSourceAnalysisQueue();
        let queueJob;
        try {
          queueJob = await queue.getJob(claimed.id);
          if (queueJob) {
            const state = String(await queueJob.getState());
            if (state === "failed" || state === "completed") {
              await queueJob.retry(state);
              return;
            }
            if (state !== "unknown") return;
          }
        } finally {
          await queue.close();
        }
        await enqueueSourceAnalysis({
          sourceAnalysisId: claimed.id,
          projectId: claimed.projectId,
          sourceAssetId: claimed.sourceAssetId,
          analysisEngine: claimed.analysisEngine,
          analysisEngineVersion: claimed.analysisEngineVersion,
        });
      },
    });
    if (result.kind === "not-found")
      return Response.json({ error: "Analysis job not found." }, { status: 404 });
    if (result.kind === "not-retryable")
      return Response.json({ error: "Only failed analysis jobs can be retried." }, { status: 409 });
    if (result.kind === "queue-refused")
      return Response.json({ error: "Analysis retry could not be queued.", detail: result.reason }, { status: 503 });
    return Response.json({ analysis: result.analysis });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("analysis retry failed", error);
    return Response.json(
      { error: "Analysis retry could not be queued." },
      { status: 503 },
    );
  }
}
