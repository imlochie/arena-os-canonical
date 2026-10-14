import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  processingJobs,
} from "@/db/waveyardSchema";
import { getSeparationQueue, type QueueLike } from "@/lib/waveyard/queue";
import { localWorkerActive } from "@/lib/waveyard/worker-local/broker";
import { retrySeparationJob, serverQueueHandOff, type RetryOptions } from "@/lib/waveyard/separation/retry";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

/**
 * Retry a failed separation job on its own row. Both runtimes go through
 * retrySeparationJob (separation/retry.ts) in ONE order — claim the failed
 * row first (the active-only unique index refuses it if a newer attempt
 * holds the target), hand the job to an executor second, restore the row
 * if that fails. Only the hand-off differs:
 *  - desktop/local: a fresh local-broker payload rebuilt from the row;
 *  - server: serverQueueHandOff — the existing BullMQ record's retry()
 *    when it is finished, nothing when BullMQ still holds it, and a FRESH
 *    submission when there is no record at all (the original enqueue never
 *    reached Redis — a `queue_unavailable` row — or the record aged out).
 *    Every queue call is bounded, so an unreachable Redis is a 503 with the
 *    row restored, never a request that hangs on a claimed row.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let queue: QueueLike | null = null;
  try {
    const user = await requireUser(); const { id } = await params;
    const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "editor");
    if (job.status !== "failed") return NextResponse.json({ error: "Only a failed job can be retried." }, { status: 409 });

    let options: RetryOptions = {};
    if (!localWorkerActive()) {
      queue = await getSeparationQueue(); // throws when no worker is configured → 503 below
      options = { handOff: serverQueueHandOff(queue) };
    }

    const result = await retrySeparationJob(db, job.id, options);
    if (!result.queued) {
      return NextResponse.json({ error: result.reason }, { status: result.kind === "queue-refused" ? 503 : 409 });
    }
    const [updated] = await db.select().from(processingJobs).where(eq(processingJobs.id, id)).limit(1);
    return NextResponse.json({ job: updated });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("retry failed", error);
    return NextResponse.json({ error: "Retry could not be queued." }, { status: 503 });
  } finally {
    await queue?.close().catch(() => undefined);
  }
}
