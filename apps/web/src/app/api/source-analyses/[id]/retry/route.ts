import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, sourceAnalyses } from "@waveyard/database";
import { enqueueSourceAnalysis, getSourceAnalysisQueue } from "@waveyard/queue";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const [analysis] = await db
      .select()
      .from(sourceAnalyses)
      .where(eq(sourceAnalyses.id, id))
      .limit(1);
    if (!analysis)
      return NextResponse.json({ error: "Analysis job not found." }, { status: 404 });
    await requireProjectRole(user.id, analysis.projectId, "editor");
    if (analysis.status !== "failed")
      return NextResponse.json(
        { error: "Only a failed analysis job can be retried." },
        { status: 409 },
      );

    const queue = getSourceAnalysisQueue();
    const queueJob = await queue.getJob(analysis.id);
    if (queueJob) await queueJob.retry();
    else
      await enqueueSourceAnalysis({
        sourceAnalysisId: analysis.id,
        projectId: analysis.projectId,
        sourceAssetId: analysis.sourceAssetId,
        analysisEngine: analysis.analysisEngine,
        analysisEngineVersion: analysis.analysisEngineVersion,
      });
    const [updated] = await db
      .update(sourceAnalyses)
      .set({
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
        analyzedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(sourceAnalyses.id, analysis.id))
      .returning();
    return NextResponse.json({ analysis: updated });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("analysis retry failed", error);
    return NextResponse.json(
      { error: "Analysis retry could not be queued." },
      { status: 503 },
    );
  }
}
