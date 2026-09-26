import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { exportJobs, getDb } from "@waveyard/database";
import { enqueueExport, getExportQueue } from "@waveyard/queue";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

// Automatic export retries use a 10-second backoff. A failed durable row can
// briefly precede BullMQ's active/delayed → failed transition, so wait only for
// that bounded queue transition rather than treating it as a queue outage.
const QUEUE_SETTLE_TIMEOUT_MS = 15_000;
const QUEUE_SETTLE_POLL_MS = 100;

async function waitForFailedQueueJob(exportJobId: string) {
  const queue = getExportQueue();
  const deadline = Date.now() + QUEUE_SETTLE_TIMEOUT_MS;
  let queueJob = await queue.getJob(exportJobId);
  if (!queueJob) return undefined;

  while (await queueJob.getState() !== "failed") {
    if (Date.now() >= deadline)
      throw new Response(
        "Export queue job did not reach its terminal failed state in time.",
        { status: 409 },
      );
    await new Promise((resolve) => setTimeout(resolve, QUEUE_SETTLE_POLL_MS));
    queueJob = await queue.getJob(exportJobId);
    if (!queueJob) return undefined;
  }
  return queueJob;
}

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
      .from(exportJobs)
      .where(eq(exportJobs.id, id))
      .limit(1);
    if (!job)
      return NextResponse.json({ error: "Export job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "editor");
    if (job.status !== "failed")
      return NextResponse.json(
        { error: "Only a failed export can be retried." },
        { status: 409 },
      );

    const queueJob = await waitForFailedQueueJob(job.id);
    // Transition durable state before placing work back in BullMQ so a fast
    // worker can never overwrite its own processing state with stale "queued".
    // The failed predicate also serializes duplicate manual retry requests.
    const [updated] = await db
      .update(exportJobs)
      .set({
        status: "queued",
        stage: "queued",
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(exportJobs.id, job.id), eq(exportJobs.status, "failed")))
      .returning();
    if (!updated)
      return NextResponse.json(
        { error: "Export retry is already in progress." },
        { status: 409 },
      );

    try {
      if (queueJob)
        await queueJob.retry("failed", {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
      else
        await enqueueExport({
          exportJobId: job.id,
          projectId: job.projectId,
          remixSessionId: job.remixSessionId,
          remixVersionId: job.remixVersionId,
          format: "wav",
        });
    } catch (queueError) {
      await db
        .update(exportJobs)
        .set({
          status: "failed",
          stage: "queue-retry-failed",
          errorCode: "queue_retry_failed",
          errorMessage:
            queueError instanceof Error
              ? queueError.message.slice(0, 1000)
              : "Export retry could not be queued.",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(exportJobs.id, job.id), eq(exportJobs.status, "queued")));
      throw queueError;
    }
    return NextResponse.json({ job: updated });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("export retry failed", error);
    return NextResponse.json(
      { error: "Export retry could not be queued." },
      { status: 503 },
    );
  }
}
