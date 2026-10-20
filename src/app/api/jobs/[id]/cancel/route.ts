import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { processingJobs } from "@/db/waveyardSchema";
import { requireUser, requireProjectRole } from "@/lib/waveyard/local-context";
import { SEPARATION_QUEUE } from "@/lib/waveyard/queue";
import { getLocalJobBroker, localWorkerActive } from "@/lib/waveyard/worker-local/broker";
import { requestSeparationCancellation } from "@/lib/waveyard/separation/cancel";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
    if (!job || job.type !== "separation") return NextResponse.json({ error: "Separation job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "editor");
    if (!localWorkerActive()) return NextResponse.json({ error: "Cancellation requires the native executor. Remote worker cancellation is not supported." }, { status: 503 });
    if (!["queued", "complete", "failed", "cancelled"].includes(job.status) && !getLocalJobBroker().hasHandler(SEPARATION_QUEUE)) return NextResponse.json({ error: "The native separation executor is not registered; stopping this running job cannot be acknowledged." }, { status: 503 });
    const updated = await requestSeparationCancellation(db, id);
    return NextResponse.json({ job: updated }, { status: updated?.status === "cancelling" ? 202 : 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("separation cancellation failed", error);
    return NextResponse.json({ error: "Cancellation could not be recorded; the job may still be running." }, { status: 503 });
  }
}
