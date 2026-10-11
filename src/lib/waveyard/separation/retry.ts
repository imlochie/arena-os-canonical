/**
 * Separation retry — the durable-row half of the retry story.
 *
 * The retry ROUTE decides between BullMQ's queueJob.retry() (server mode)
 * and the local broker (desktop). This module is the local half plus the
 * post-seeding sweep: once a model is seeded, every separation job that
 * failed honestly because the model was absent gets re-enqueued — the
 * zero-thought path from "model missing" back to "stems playing".
 */

import { and, eq } from "drizzle-orm";

import type { drizzle } from "drizzle-orm/node-postgres";

import { processingJobs } from "@/db/waveyardSchema";
import { enqueueSeparation } from "@/lib/waveyard/queue";

export type SeparationDb = ReturnType<typeof drizzle>;

/** Job error codes that a retry can honestly fix (vs. a bad source file). */
export const RETRYABLE_ERROR_CODES = ["separation_unavailable", "queue_unavailable", "dependency_missing"] as const;

function requestedDeviceOf(value: string): "auto" | "cpu" | "cuda" {
  return value === "cpu" || value === "cuda" ? value : "auto";
}

/**
 * Re-enqueue ONE failed separation job (desktop/local path: the payload is
 * fully derivable from the durable row — no BullMQ record is needed).
 * Resets the row only after the queue accepted the job. Returns the new
 * row, or null when the job is not in a retryable state.
 */
export async function retrySeparationJob(
  db: SeparationDb,
  jobId: string,
): Promise<{ queued: true } | { queued: false; reason: string }> {
  const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId)).limit(1);
  if (!job) return { queued: false, reason: "Job not found." };
  if (job.type !== "separation") return { queued: false, reason: "Not a separation job." };
  if (job.status !== "failed") return { queued: false, reason: "Only a failed job can be retried." };

  try {
    await enqueueSeparation({
      processingJobId: job.id,
      projectId: job.projectId,
      sourceAssetId: job.sourceAssetId,
      model: job.model,
      requestedDevice: requestedDeviceOf(job.requestedDevice),
    });
  } catch (error) {
    return {
      queued: false,
      reason: error instanceof Error ? error.message : "The separation could not be re-queued.",
    };
  }
  await db
    .update(processingJobs)
    .set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() })
    .where(eq(processingJobs.id, job.id));
  return { queued: true };
}

/**
 * After a successful seed: re-enqueue every separation job that failed for
 * want of this model. Bounded to this model's jobs in retryable states —
 * a failed analysis or a corrupt source is not touched.
 */
export async function requeueFailedSeparationsForModel(
  db: SeparationDb,
  modelId: string,
): Promise<{ considered: number; requeued: number; failures: string[] }> {
  const failed = await db
    .select()
    .from(processingJobs)
    .where(and(eq(processingJobs.type, "separation"), eq(processingJobs.model, modelId), eq(processingJobs.status, "failed")));
  const eligible = failed.filter((job) => (RETRYABLE_ERROR_CODES as readonly string[]).includes(job.errorCode ?? ""));
  const failures: string[] = [];
  let requeued = 0;
  for (const job of eligible) {
    const result = await retrySeparationJob(db, job.id);
    if (result.queued) requeued += 1;
    else failures.push(result.reason);
  }
  return { considered: eligible.length, requeued, failures };
}
