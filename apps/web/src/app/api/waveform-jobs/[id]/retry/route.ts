import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, waveformJobs } from "@waveyard/database";
import { enqueueWaveform, getWaveformQueue } from "@waveyard/queue";
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
    const [job] = await db
      .select()
      .from(waveformJobs)
      .where(eq(waveformJobs.id, id))
      .limit(1);
    if (!job)
      return NextResponse.json(
        { error: "Waveform job not found." },
        { status: 404 },
      );
    await requireProjectRole(user.id, job.projectId, "editor");
    if (job.status !== "failed")
      return NextResponse.json(
        { error: "Only a failed waveform job can be retried." },
        { status: 409 },
      );
    if ((job.sourceAssetId ? 1 : 0) + (job.stemAssetId ? 1 : 0) !== 1)
      return NextResponse.json(
        { error: "Waveform job target is invalid." },
        { status: 422 },
      );

    const queue = getWaveformQueue();
    const queueJob = await queue.getJob(job.id);
    if (queueJob) await queueJob.retry();
    else
      await enqueueWaveform({
        waveformJobId: job.id,
        projectId: job.projectId,
        sourceAssetId: job.sourceAssetId ?? undefined,
        stemAssetId: job.stemAssetId ?? undefined,
      });

    const [updated] = await db
      .update(waveformJobs)
      .set({
        status: "queued",
        stage: "queued",
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(waveformJobs.id, id))
      .returning();
    return NextResponse.json({ job: updated });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("waveform retry failed", error);
    return NextResponse.json(
      { error: "Waveform retry could not be queued." },
      { status: 503 },
    );
  }
}
