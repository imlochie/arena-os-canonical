/**
 * Separation retry — the durable-row half of the retry story.
 *
 * The retry ROUTE decides how the job reaches an executor again — the
 * server-mode BullMQ hand-off below (an existing record's retry(), or a
 * FRESH submission when there is no record) or a fresh local-broker payload
 * (desktop) — and hands that step in as `handOff`. Everything around it is
 * here, in one order for both modes: validate → claim the row → hand off →
 * restore the row if the hand-off fails. The post-seeding sweep rides the
 * same function: once a model is seeded, every separation job that failed
 * honestly because the model was absent gets re-enqueued — the zero-thought
 * path from "model missing" back to "stems playing".
 *
 * Retrying resurrects the SAME row. Since a target's idempotency key is
 * unique among ACTIVE jobs only (processing_jobs_active_idempotency_unique),
 * a failed row can only come back to life while no newer attempt at its
 * target is queued or running: the row reset IS the atomic claim — the
 * database refuses it when a fresh attempt slipped in — and the executor is
 * asked only after the claim succeeded. Asking first and claiming second
 * would let a retry be triggered for a target another request just took.
 */

import { and, eq, sql } from "drizzle-orm";

import type { drizzle } from "drizzle-orm/node-postgres";

import { executionHistory } from "./recovery";
import { processingJobs } from "@/db/waveyardSchema";
import { enqueueSeparation, type QueueLike } from "@/lib/waveyard/queue";
import { findActiveProcessingJob, type ProcessingJobRow } from "./claim";

export type SeparationDb = ReturnType<typeof drizzle>;

export type RetryOutcome =
  | { queued: true }
  | {
      queued: false;
      /** Why not — the route maps it: a conflict (409) or an executor that
       *  refused (503). */
      kind: "not-found" | "not-retryable" | "newer-attempt" | "queue-refused";
      reason: string;
    };

export type RetryOptions = {
  /** How the claimed row reaches an executor. Default: a fresh local-broker /
   *  queue payload rebuilt from the row. Server mode passes BullMQ's
   *  `queueJob.retry()`. Invoked ONLY after the row is claimed; a throw
   *  restores the row to exactly its failed state. */
  handOff?: (job: ProcessingJobRow) => Promise<unknown>;
};

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

/** The default hand-off: a payload rebuilt from the durable row (every
 *  field the handler checks is on it — no queue record needed). In server
 *  mode this is a BullMQ `add` keyed by the row id; locally, the broker. */
export async function enqueueFromRow(job: ProcessingJobRow): Promise<void> {
  if (!job.sourceAssetId) throw new Error("Separation requires a verified source asset; acquisition is not separation.");
  const parentStemAssetId = parentStemAssetIdOf(job);
  await enqueueSeparation({
    processingJobId: job.id,
    projectId: job.projectId,
    sourceAssetId: job.sourceAssetId,
    model: job.model,
    requestedDevice: requestedDeviceOf(job.requestedDevice),
    ...(parentStemAssetId !== undefined ? { parentStemAssetId } : {}),
  });
}

export type ServerHandOffResult = "retried" | "already-queued" | "enqueued";

/** A Redis that does not answer must not hold a claimed row hostage: every
 *  queue call in the server hand-off is bounded, and a timeout is a refusal
 *  (the caller restores the row and reports it). */
export const SERVER_QUEUE_HANDOFF_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not answer within ${Math.round(timeoutMs / 1000)}s — the queue (Redis) is not reachable.`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Server mode (BullMQ): how a claimed row reaches an executor again.
 *  - an existing record that is FINISHED (failed / completed) → `retry(state)`;
 *  - an existing record BullMQ still holds (waiting, delayed, active, …) →
 *    nothing to do: it will run, the row is honestly `queued`;
 *  - NO record — the original enqueue never reached Redis (the row says
 *    `queue_unavailable`), or the record aged out of the queue — → a FRESH
 *    submission rebuilt from the row, exactly as the local path does it.
 * So a `queue_unavailable` row is as retryable as any other failed row, and
 * the retry button never answers "create a new job instead".
 */
export function serverQueueHandOff(
  queue: Pick<QueueLike, "getJob">,
  options: { enqueue?: (job: ProcessingJobRow) => Promise<unknown>; timeoutMs?: number } = {},
): (job: ProcessingJobRow) => Promise<ServerHandOffResult> {
  const timeoutMs = options.timeoutMs ?? SERVER_QUEUE_HANDOFF_TIMEOUT_MS;
  const enqueue = options.enqueue ?? enqueueFromRow;
  return async (job) => {
    const existing = await withTimeout(queue.getJob(job.id), timeoutMs, "The queue record lookup");
    if (existing) {
      const state = String(await withTimeout(existing.getState(), timeoutMs, "The queue record state"));
      if (state === "failed" || state === "completed") {
        await withTimeout(existing.retry(state), timeoutMs, "The queue retry");
        return "retried";
      }
      if (state !== "unknown") return "already-queued";
      // "unknown": the record vanished between lookup and state — treat as absent.
    }
    await withTimeout(enqueue(job), timeoutMs, "The queue submission");
    return "enqueued";
  };
}

/**
 * Retry ONE failed separation job on its own row. Returns whether an
 * executor took it, or the honest reason it did not: the job is not in a
 * retryable state, a newer attempt at the same target is already active,
 * or the hand-off refused (the row is then restored exactly as it was, so
 * the original failure stays visible and retryable).
 */
export async function retrySeparationJob(db: SeparationDb, jobId: string, options: RetryOptions = {}): Promise<RetryOutcome> {
  const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId)).limit(1);
  if (!job) return { queued: false, kind: "not-found", reason: "Job not found." };
  if (job.type !== "separation") return { queued: false, kind: "not-retryable", reason: "Not a separation job." };
  if (job.status !== "failed") return { queued: false, kind: "not-retryable", reason: "Only a failed job can be retried." };

  // Friendly fast path; the claim below is what actually decides.
  const newer = await findActiveProcessingJob(db, job.idempotencyKey);
  if (newer !== null && newer.id !== job.id) return { queued: false, kind: "newer-attempt", reason: newerAttemptReason(newer.status) };

  // The claim: under the active-only unique index this UPDATE is refused
  // (unique_violation) if a fresh attempt took the key in the meantime.
  let claimed: Array<{ id: string }>;
  try {
    claimed = await db
      .update(processingJobs)
      .set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date(), metadata: sql`(${processingJobs.metadata}::jsonb || ${JSON.stringify({ executionHistory: executionHistory(job) })}::jsonb)::text` })
      .where(and(eq(processingJobs.id, job.id), eq(processingJobs.status, "failed")))
      .returning({ id: processingJobs.id });
  } catch (error) {
    if (isUniqueViolation(error)) return { queued: false, kind: "newer-attempt", reason: newerAttemptReason("queued") };
    throw error;
  }
  if (claimed.length === 0) return { queued: false, kind: "not-retryable", reason: "Only a failed job can be retried." };

  try {
    await (options.handOff ?? enqueueFromRow)(job);
  } catch (error) {
    // The executor did not take it: the row goes back to exactly the failed
    // state it was in, so nothing is left "queued" that no executor holds.
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        stage: job.stage,
        metadata: sql`case when ${processingJobs.metadata}::jsonb ? 'recoveryHistory' then (${job.metadata}::jsonb || jsonb_build_object('recoveryHistory', ${processingJobs.metadata}::jsonb->'recoveryHistory'))::text else ${job.metadata} end`,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        completedAt: job.completedAt,
        updatedAt: new Date(),
      })
      .where(eq(processingJobs.id, job.id));
    return {
      queued: false,
      kind: "queue-refused",
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
