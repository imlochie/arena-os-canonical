/**
 * Separation retry — the durable-row half of the retry story.
 *
 * The retry ROUTE decides between BullMQ's queueJob.retry() (server mode)
 * and the local broker (desktop). This module is the local half plus the
 * post-seeding sweep: once a model is seeded, every separation job that
 * failed honestly because the model was absent gets re-enqueued — the
 * zero-thought path from "model missing" back to "stems playing".
 *
 * Retrying resurrects the SAME row. Since a target's idempotency key is
 * unique among ACTIVE jobs only (processing_jobs_active_idempotency_unique),
 * a failed row can only come back to life while no newer attempt at its
 * target is queued or running: the row reset is the atomic claim — the
 * database refuses it when a fresh attempt slipped in — and the queue is
 * handed the job only after the claim succeeded.
 */

import { and, eq } from "drizzle-orm";

import type { drizzle } from "drizzle-orm/node-postgres";

import { processingJobs } from "@/db/waveyardSchema";
import { enqueueSeparation } from "@/lib/waveyard/queue";
import { findActiveProcessingJob } from "./claim";

export type SeparationDb = ReturnType<typeof drizzle>;

/** Job error codes that a retry can honestly fix (vs. a bad source file). */
export const RETRYABLE_ERROR_CODES = ["separation_unavailable", "queue_unavailable", "dependency_missing"] as const;

function requestedDeviceOf(value: string): "auto" | "cpu" | "cuda" {
  return value === "cpu" || value === "cuda" ? value : "auto";
}

/** PostgreSQL unique_violation (23505), whether raised by pg, PGlite, or
 *  wrapped by drizzle's query error. */
export function isUniqueViolation(error: unknown): boolean {
  const code = (candidate: unknown) =>
    typeof candidate === "object" && candidate !== null && (candidate as { code?: unknown }).code === "23505";
  return code(error) || code((error as { cause?: unknown } | null)?.cause);
}

/** The layer target a second-pass job was created for lives in the row's
 *  metadata (the payload must carry it again, or the retry would separate
 *  the whole source and name the lanes wrong). */
export function parentStemAssetIdOf(job: { metadata: string | null }): string | undefined {
  try {
    const parsed = JSON.parse(job.metadata ?? "{}") as { parentStemAssetId?: unknown };
    return typeof parsed.parentStemAssetId === "string" && parsed.parentStemAssetId !== "" ? parsed.parentStemAssetId : undefined;
  } catch {
    return undefined;
  }
}

export function newerAttemptReason(status: string): string {
  return `A newer attempt at this target is already ${status === "queued" ? "queued" : "running"} — its lanes replace this one when it finishes.`;
}

/**
 * Re-enqueue ONE failed separation job (desktop/local path: the payload is
 * fully derivable from the durable row — no BullMQ record is needed).
 * Returns whether the queue took it, or the honest reason it did not: the
 * job is not in a retryable state, a newer attempt at the same target is
 * already active, or the queue refused (the row is then restored exactly
 * as it was, so the original failure stays visible and retryable).
 */
export async function retrySeparationJob(
  db: SeparationDb,
  jobId: string,
): Promise<{ queued: true } | { queued: false; reason: string }> {
  const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId)).limit(1);
  if (!job) return { queued: false, reason: "Job not found." };
  if (job.type !== "separation") return { queued: false, reason: "Not a separation job." };
  if (job.status !== "failed") return { queued: false, reason: "Only a failed job can be retried." };

  const newer = await findActiveProcessingJob(db, job.idempotencyKey);
  if (newer !== null && newer.id !== job.id) return { queued: false, reason: newerAttemptReason(newer.status) };

  // The claim: under the active-only unique index this UPDATE is refused
  // (unique_violation) if a fresh attempt took the key in the meantime.
  let claimed: Array<{ id: string }>;
  try {
    claimed = await db
      .update(processingJobs)
      .set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() })
      .where(and(eq(processingJobs.id, job.id), eq(processingJobs.status, "failed")))
      .returning({ id: processingJobs.id });
  } catch (error) {
    if (isUniqueViolation(error)) return { queued: false, reason: newerAttemptReason("queued") };
    throw error;
  }
  if (claimed.length === 0) return { queued: false, reason: "Only a failed job can be retried." };

  const parentStemAssetId = parentStemAssetIdOf(job);
  try {
    await enqueueSeparation({
      processingJobId: job.id,
      projectId: job.projectId,
      sourceAssetId: job.sourceAssetId,
      model: job.model,
      requestedDevice: requestedDeviceOf(job.requestedDevice),
      ...(parentStemAssetId !== undefined ? { parentStemAssetId } : {}),
    });
  } catch (error) {
    // The queue did not take it: the row goes back to exactly the failed
    // state it was in, so nothing is left "queued" that no executor holds.
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        stage: job.stage,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        completedAt: job.completedAt,
        updatedAt: new Date(),
      })
      .where(eq(processingJobs.id, job.id));
    return {
      queued: false,
      reason: error instanceof Error ? error.message : "The separation could not be re-queued.",
    };
  }
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
