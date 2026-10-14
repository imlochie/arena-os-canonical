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
 */

import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

import { processingJobIsActive, processingJobs } from "@/db/waveyardSchema";

export type ProcessingJobRow = typeof processingJobs.$inferSelect;
export type ProcessingJobInsert = typeof processingJobs.$inferInsert;

/** The database the claim runs against — the app's pool, or an injected
 *  (PGlite / embedded) instance in tests, same seam as the job handlers. */
export type ClaimDb = Pick<ReturnType<typeof drizzle>, "insert" | "select">;

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
