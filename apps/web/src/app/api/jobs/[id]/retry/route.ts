import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, processingJobs } from "@waveyard/database";
import { getSeparationQueue } from "@waveyard/queue";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params; const db = getDb();
    const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "editor");
    if (job.status !== "failed") return NextResponse.json({ error: "Only a failed job can be retried." }, { status: 409 });
    const queueJob = await getSeparationQueue().getJob(job.id);
    if (!queueJob) return NextResponse.json({ error: "Queue record is unavailable; create a new separation job instead." }, { status: 409 });
    await queueJob.retry();
    const [updated] = await db.update(processingJobs).set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() }).where(eq(processingJobs.id, id)).returning();
    return NextResponse.json({ job: updated });
  } catch (error) { if (error instanceof Response) return error; console.error("retry failed", error); return NextResponse.json({ error: "Retry could not be queued." }, { status: 503 }); }
}
