import { and, eq, ne } from "drizzle-orm";

import { processingJobs } from "@workspace/db/waveyardSchema";
import type { LocalJobBroker } from "../worker-local/broker";
import { LOCAL_JOB_CANCEL_WAIT_MS } from "../worker-local/broker";
import type { ClaimDb, ProcessingJobRow } from "./claim";

export type SeparationCancelResult =
  | { kind: "cancelled"; job: ProcessingJobRow }
  | { kind: "stopping"; job: ProcessingJobRow }
  | { kind: "not-found" }
  | { kind: "not-separation"; job: ProcessingJobRow }
  | { kind: "not-active"; job: ProcessingJobRow }
  | { kind: "worker-unavailable"; job: ProcessingJobRow }
  | { kind: "worker-not-running"; job: ProcessingJobRow };

type CancellationDb = Pick<ClaimDb, "select" | "update">;

const ACTIVE_STATUSES = ["preparing", "running", "processing", "finalizing"] as const;

async function loadJob(database: CancellationDb, jobId: string): Promise<ProcessingJobRow | null> {
  const [job] = await database
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1);
  return job ?? null;
}

function terminalResult(job: ProcessingJobRow): SeparationCancelResult {
  return job.status === "cancelled"
    ? { kind: "cancelled", job }
    : { kind: "not-active", job };
}

/**
 * Cancel a local separation attempt without treating a database status change
 * as proof that its native ONNX worker stopped. Queued rows are safely marked
 * terminal; an active row is only terminal after its broker handler settles.
 */
export async function requestSeparationCancellation(
  database: CancellationDb,
  jobId: string,
  broker: LocalJobBroker,
  localWorkerAvailable: boolean,
): Promise<SeparationCancelResult> {
  let job = await loadJob(database, jobId);
  if (!job) return { kind: "not-found" };
  if (job.type !== "separation") return { kind: "not-separation", job };
  if (job.status === "cancelled" || job.status === "complete" || job.status === "failed") {
    return terminalResult(job);
  }
  if (!localWorkerAvailable) return { kind: "worker-unavailable", job };

  if (job.status === "queued") {
    const [cancelled] = await database
      .update(processingJobs)
      .set({
        status: "cancelled",
        stage: "cancelled",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(processingJobs.id, job.id), eq(processingJobs.status, "queued")))
      .returning();
    if (cancelled) return { kind: "cancelled", job: cancelled };
    // The local worker may have dequeued it between the read and update.
    job = await loadJob(database, jobId);
    if (!job) return { kind: "not-found" };
    if (job.status === "cancelled" || job.status === "complete" || job.status === "failed") {
      return terminalResult(job);
    }
  }

  if (!ACTIVE_STATUSES.includes(job.status as (typeof ACTIVE_STATUSES)[number])) {
    return { kind: "not-active", job };
  }
  if (!broker.isRunning(job.id)) return { kind: "worker-not-running", job };

  // Abort synchronously before yielding to the database. The stage prevents
  // queued progress/finalization writes from racing this request.
  const stopping = broker.cancelActive(job.id, LOCAL_JOB_CANCEL_WAIT_MS);
  await database
    .update(processingJobs)
    .set({ stage: "cancelling", updatedAt: new Date() })
    .where(and(
      eq(processingJobs.id, job.id),
      ne(processingJobs.status, "complete"),
      ne(processingJobs.status, "failed"),
      ne(processingJobs.status, "cancelled"),
    ));

  const stopResult = await stopping;
  job = await loadJob(database, jobId);
  if (!job) return { kind: "not-found" };
  if (job.status === "cancelled") return { kind: "cancelled", job };
  if (job.status === "complete" || job.status === "failed") return { kind: "not-active", job };
  if (stopResult === "stopped" || stopResult === "timeout") return { kind: "stopping", job };
  return { kind: "worker-not-running", job };
}
