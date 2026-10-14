import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  processingJobs,
} from "@/db/waveyardSchema";
import { getSeparationQueue } from "@/lib/waveyard/queue";
import { localWorkerActive } from "@/lib/waveyard/worker-local/broker";
import { retrySeparationJob, type RetryOptions } from "@/lib/waveyard/separation/retry";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

/**
 * Retry a failed separation job on its own row. Both runtimes go through
 * retrySeparationJob (separation/retry.ts) in ONE order — claim the failed
 * row first (the active-only unique index refuses it if a newer attempt
 * holds the target), hand the job to an executor second, restore the row
 * if that fails. Only the hand-off differs:
 *  - desktop/local: a fresh local-broker payload rebuilt from the row;
 *  - server: BullMQ's queueJob.retry() on the existing queue record.
 * The queue record is looked up (read-only) BEFORE the claim, so a missing
 * record is a plain 409 and never touches the row.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "editor");
    if (job.status !== "failed") return NextResponse.json({ error: "Only a failed job can be retried." }, { status: 409 });

    let options: RetryOptions = {};
    if (!localWorkerActive()) {
      const queueJob = await (await getSeparationQueue()).getJob(job.id);
      if (!queueJob) return NextResponse.json({ error: "Queue record is unavailable; create a new separation job instead." }, { status: 409 });
      options = { handOff: () => queueJob.retry() };
    }

    const result = await retrySeparationJob(db, job.id, options);
    if (!result.queued) {
      return NextResponse.json({ error: result.reason }, { status: result.kind === "queue-refused" ? 503 : 409 });
    }
    const [updated] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
    return NextResponse.json({ job: updated });
  } catch (error) { if (error instanceof Response) return error; console.error("retry failed", error); return NextResponse.json({ error: "Retry could not be queued." }, { status: 503 }); }
}
