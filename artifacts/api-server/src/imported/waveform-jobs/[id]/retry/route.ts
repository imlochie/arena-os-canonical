
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  waveformJobs,
} from "@workspace/db/waveyardSchema";
import { enqueueWaveform, getWaveformQueue } from "@workspace/arena/lib/waveyard/queue";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    
    const [job] = await db
      .select()
      .from(waveformJobs)
      .where(eq(waveformJobs.id, id))
      .limit(1);
    if (!job)
      return Response.json(
        { error: "Waveform job not found." },
        { status: 404 },
      );
    await requireProjectRole(user.id, job.projectId, "editor");
    if (job.status !== "failed")
      return Response.json(
        { error: "Only a failed waveform job can be retried." },
        { status: 409 },
      );
    if ((job.sourceAssetId ? 1 : 0) + (job.stemAssetId ? 1 : 0) !== 1)
      return Response.json(
        { error: "Waveform job target is invalid." },
        { status: 422 },
      );

    const [queued] = await db
      .update(waveformJobs)
      .set({
        status: "queued",
        stage: "queued",
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        attempts: 0,
        updatedAt: new Date(),
      })
      .where(and(eq(waveformJobs.id, id), eq(waveformJobs.status, "failed")))
      .returning();
    if (!queued)
      return Response.json(
        { error: "Waveform job is no longer failed and cannot be retried." },
        { status: 409 },
      );

    try {
      const queue = await getWaveformQueue();
      const queueJob = await queue.getJob(job.id);
      if (queueJob) await queueJob.retry();
      else
        await enqueueWaveform({
          waveformJobId: job.id,
          projectId: job.projectId,
          sourceAssetId: job.sourceAssetId ?? undefined,
          stemAssetId: job.stemAssetId ?? undefined,
        });
    } catch (error) {
      await db
        .update(waveformJobs)
        .set({
          status: "failed",
          stage: "queue-unavailable",
          attempts: job.attempts,
          errorCode: "queue_unavailable",
          errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(waveformJobs.id, id), eq(waveformJobs.status, "queued")));
      return Response.json(
        { error: "Waveform retry could not be queued." },
        { status: 503 },
      );
    }
    return Response.json({ job: queued });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("waveform retry failed", error);
    return Response.json(
      { error: "Waveform retry could not be queued." },
      { status: 503 },
    );
  }
}
