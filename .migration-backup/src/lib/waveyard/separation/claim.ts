/**
 * Claiming a processing job — "one ACTIVE attempt per target".
 *
 * The second-pass separation routes (stem-layers, deep-stems) key a job by
 * its target and must guarantee two things at once:
 *  - while an attempt is queued or running, a repeat request is refused
 *    (an honest 409 — the lanes are already on their way);
 *  - once that attempt is over (complete, failed, cancelled) the SAME target
 *    can be run again, as a fresh row — a completed target can be
 *    re-separated, a failed one retried — and the old row stays as history.
 *
 * Both come from one database fact, not from application-level checks: the
 * idempotency key is unique among active jobs only (the partial index
 * `processing_jobs_active_idempotency_unique`, src/db/waveyardSchema.ts).
 * The insert below carries the index's own predicate in its ON CONFLICT
 * clause, so PostgreSQL arbitrates concurrent requests itself — two
 * simultaneous claims can never both insert, with no lock, transaction or
 * retry loop in the caller.
 *
 * A claimed row is only honest once an executor holds it. `startSeparationJob`
 * is the whole lifecycle the routes use: claim → hand the payload to the
 * queue → and, if the queue refuses (no local executor, no broker, a
 * runtime that processes elsewhere), RELEASE the claim by recording the
 * row as failed with `queue_unavailable` — a retryable, visible failure
 * that frees the target's key. Nothing here leaves a `queued` row that no
 * executor will ever run: there is no background sweep that would rescue
 * it, and an abandoned active row would hold the target's key forever.
 */

import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

import { processingJobIsActive, processingJobs } from "@/db/waveyardSchema";
import { enqueueSeparation } from "@/lib/waveyard/queue";
import type { SeparationJobPayload } from "@/lib/waveyard/types";

export type ProcessingJobRow = typeof processingJobs.$inferSelect;
export type ProcessingJobInsert = typeof processingJobs.$inferInsert;

/** The database the claim runs against — the app's pool, or an injected
 *  (PGlite / embedded) instance in tests, same seam as the job handlers. */
export type ClaimDb = Pick<ReturnType<typeof drizzle>, "insert" | "select" | "update">;

export type ClaimOutcome =
  /** A fresh attempt: this request owns the new row. */
  | { created: true; job: ProcessingJobRow }
  /** Refused: `active` is the queued/running attempt that holds the target
   *  (null only in the vanishing window where the holder finished between
   *  the refused insert, one immediate re-claim, and the lookup). */
  | { created: false; active: ProcessingJobRow | null };

/**
 * Insert the job unless an ACTIVE job already holds its idempotency key.
 * Never throws on the duplicate — that is the expected, reported outcome.
 */
export async function claimProcessingJob(database: ClaimDb, values: ProcessingJobInsert): Promise<ClaimOutcome> {
  // Two passes: if the first insert is refused but no active holder can be
  // found, the holder reached a terminal state in between — the key is free
  // again and this request may take it.
  for (let pass = 0; pass < 2; pass += 1) {
    const [job] = await database
      .insert(processingJobs)
      .values(values)
      .onConflictDoNothing({
        target: processingJobs.idempotencyKey,
        where: processingJobIsActive(processingJobs.status),
      })
      .returning();
    if (job !== undefined) return { created: true, job };

    const [active] = await database
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.idempotencyKey, values.idempotencyKey), processingJobIsActive(processingJobs.status)))
      .limit(1);
    if (active !== undefined) return { created: false, active };
  }
  return { created: false, active: null };
}

/** The active attempt holding a key, if any — for callers that must refuse
 *  to resurrect an old row while a newer attempt is in flight (retry.ts). */
export async function findActiveProcessingJob(
  database: ClaimDb,
  idempotencyKey: string,
): Promise<ProcessingJobRow | null> {
  const [active] = await database
    .select()
    .from(processingJobs)
    .where(and(eq(processingJobs.idempotencyKey, idempotencyKey), processingJobIsActive(processingJobs.status)))
    .limit(1);
  return active ?? null;
}

// ------------------------------------------------- claim → queue → release

export type StartOutcome =
  /** The attempt exists AND the queue holds it: the honest 202. */
  | { outcome: "queued"; job: ProcessingJobRow }
  /** Refused: an attempt at this target is already queued or running (409). */
  | { outcome: "active"; active: ProcessingJobRow | null }
  /** The claim was taken but the queue refused it; the row is a failed,
   *  retryable `queue_unavailable` attempt and the target is free again
   *  (503 — nothing is pretending to run). */
  | { outcome: "not-queued"; job: ProcessingJobRow; reason: string };

export type StartSeparationDeps = {
  /** Test seam; production uses the app's queue (local broker or BullMQ). */
  enqueue?: (payload: SeparationJobPayload) => Promise<unknown>;
};

/**
 * Release a claim the queue did not take. The row becomes a failed attempt
 * with `queue_unavailable` (one of RETRYABLE_ERROR_CODES, so the retry
 * button and the post-seed sweep can bring it back once an executor
 * exists), which also frees the target's idempotency key. Guarded on the
 * row still being `queued`: if an executor did pick it up after all, its
 * own state wins and nothing is clobbered.
 */
export async function releaseUnqueuedClaim(
  database: ClaimDb,
  jobId: string,
  reason: string,
): Promise<ProcessingJobRow | null> {
  const now = new Date();
  const [released] = await database
    .update(processingJobs)
    .set({
      status: "failed",
      stage: "queue-unavailable",
      errorCode: "queue_unavailable",
      errorMessage: reason.slice(0, 1000),
      completedAt: now,
      updatedAt: now,
    })
    .where(and(eq(processingJobs.id, jobId), eq(processingJobs.status, "queued")))
    .returning();
  return released ?? null;
}

/**
 * The routes' whole start step: claim the target, hand the payload to the
 * queue, and never leave a claimed row behind that nothing will run.
 */
export async function startSeparationJob(
  database: ClaimDb,
  values: ProcessingJobInsert,
  payloadFor: (job: ProcessingJobRow) => SeparationJobPayload,
  deps: StartSeparationDeps = {},
): Promise<StartOutcome> {
  const claim = await claimProcessingJob(database, values);
  if (!claim.created) return { outcome: "active", active: claim.active };
  const enqueue = deps.enqueue ?? enqueueSeparation;
  try {
    await enqueue(payloadFor(claim.job));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The queue did not accept the job.";
    const released = await releaseUnqueuedClaim(database, claim.job.id, reason);
    // Nothing to release = an executor took the row after all; it is running.
    if (released === null) return { outcome: "queued", job: claim.job };
    return { outcome: "not-queued", job: released, reason };
  }
  return { outcome: "queued", job: claim.job };
}
