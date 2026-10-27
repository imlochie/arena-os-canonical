import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  sourceAnalyses,
  sourceAssets,
  sourceSectionAnalyses,
  sourceSections,
} from "@/db/waveyardSchema";
import { enqueueSourceSectionAnalysis, getSourceSectionAnalysisQueue } from "@/lib/waveyard/queue";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    
    const [sectionAnalysis] = await db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.id, id)).limit(1);
    if (!sectionAnalysis) return NextResponse.json({ error: "Source section analysis not found." }, { status: 404 });
    await requireProjectRole(user.id, sectionAnalysis.projectId, "editor");
    if (["queued", "preparing", "processing"].includes(sectionAnalysis.status))
      return NextResponse.json({ error: "Structural analysis is already active." }, { status: 409 });
    const [[analysis], [source]] = await Promise.all([
      db.select().from(sourceAnalyses).where(and(eq(sourceAnalyses.id, sectionAnalysis.sourceAnalysisId), eq(sourceAnalyses.projectId, sectionAnalysis.projectId))).limit(1),
      db.select().from(sourceAssets).where(and(eq(sourceAssets.id, sectionAnalysis.sourceAssetId), eq(sourceAssets.projectId, sectionAnalysis.projectId))).limit(1),
    ]);
    if (!analysis || analysis.status !== "complete" || !analysis.beatGrid || !source || source.checksumSha256 !== sectionAnalysis.sourceChecksumSha256)
      return NextResponse.json({ errorCode: "insufficient_analysis", error: "A complete matching source beat analysis is required before structural analysis can retry." }, { status: 422 });
    const [updated] = await db.update(sourceSectionAnalyses).set({
      status: "queued", stage: "queued", errorCode: null, errorMessage: null,
      startedAt: null, analyzedAt: null, completedAt: null, updatedAt: new Date(),
    }).where(eq(sourceSectionAnalyses.id, sectionAnalysis.id)).returning();
    await db.delete(sourceSections).where(eq(sourceSections.sourceAssetId, updated.sourceAssetId));
    try {
      const queue = await getSourceSectionAnalysisQueue();
      const queueJob = await queue.getJob(updated.id);
      if (queueJob) await queueJob.remove();
      await enqueueSourceSectionAnalysis({
        sourceSectionAnalysisId: updated.id,
        projectId: updated.projectId,
        sourceAssetId: updated.sourceAssetId,
        sourceAnalysisId: updated.sourceAnalysisId,
        analysisEngine: updated.analysisEngine,
        analysisEngineVersion: updated.analysisEngineVersion,
      });
    } catch (error) {
      await db.update(sourceSectionAnalyses).set({ status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable", errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Section queue is unavailable.", completedAt: new Date(), updatedAt: new Date() }).where(eq(sourceSectionAnalyses.id, updated.id));
      return NextResponse.json({ error: "The section analysis was reset but the worker queue is unavailable." }, { status: 503 });
    }
    return NextResponse.json({ sectionAnalysis: updated });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("source section analysis retry failed", error);
    return NextResponse.json({ error: "Could not retry source section analysis." }, { status: 500 });
  }
}
