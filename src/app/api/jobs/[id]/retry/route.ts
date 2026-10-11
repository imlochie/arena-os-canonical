import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  processingJobs,
} from "@/db/waveyardSchema";
import { getSeparationQueue } from "@/lib/waveyard/queue";
import { localWorkerActive } from "@/lib/waveyard/worker-local/broker";
import { retrySeparationJob } from "@/lib/waveyard/separation/retry";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "editor");
    if (job.status !== "failed") return NextResponse.json({ error: "Only a failed job can be retried." }, { status: 409 });

    if (localWorkerActive()) {
      // Desktop: there is no BullMQ record to .retry() — the local broker
      // takes a fresh payload rebuilt from the durable row (every field the
      // handler checks is on it). The row is reset only after the queue
      // accepted the job.
      const result = await retrySeparationJob(db, job.id);
      if (!result.queued) return NextResponse.json({ error: result.reason }, { status: 409 });
      const [updated] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
      return NextResponse.json({ job: updated });
    }

    const queueJob = await (await getSeparationQueue()).getJob(job.id);
    if (!queueJob) return NextResponse.json({ error: "Queue record is unavailable; create a new separation job instead." }, { status: 409 });
    await queueJob.retry();
    const [updated] = await db.update(processingJobs).set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() }).where(eq(processingJobs.id, id)).returning();
    return NextResponse.json({ job: updated });
  } catch (error) { if (error instanceof Response) return error; console.error("retry failed", error); return NextResponse.json({ error: "Retry could not be queued." }, { status: 503 }); }
}
