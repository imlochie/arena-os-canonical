// ============================================================================
// Lochie Life College — institutional reconciliation (SERVER ONLY)
// ============================================================================
// A conflict between authoritative sources is INSTITUTIONAL STATE, not an
// error to be cleaned up. This module persists detected conflicts so they
// survive across requests, accumulate provenance, and can only leave the
// system through an explicit institutional act.
//
// Hard rules:
//   • Never choose a winner automatically.
//   • Never overwrite either source.
//   • Never "fix" a conflict because the current date suggests a reading.
//   • UNKNOWN stays UNKNOWN while authoritative information is missing.
// ============================================================================

import { db } from "@/db";
import { collegeReconciliations } from "@/db/college";
import { and, desc, eq, sql } from "drizzle-orm";

export interface DetectedConflict {
  conflictKey: string;
  conflictType: string;
  subject: string;
  sourceAKey: string;
  sourceAClaim: string;
  sourceBKey: string;
  sourceBClaim: string;
  detail: string;
  requiredAuthority: string;
  requiredAction: string;
  provenance?: string;
}

/**
 * Record a detected conflict, or refresh the sighting of one already open.
 *
 * Idempotent by `conflictKey`: re-detecting the same live disagreement updates
 * `lastSeenAt` rather than spawning duplicates. A conflict the founder has
 * already resolved is NOT reopened — resolution is durable until the
 * underlying claims actually change.
 */
export async function registerConflict(c: DetectedConflict): Promise<{
  created: boolean;
  reopened: boolean;
  id: string;
}> {
  const [existing] = await db
    .select()
    .from(collegeReconciliations)
    .where(eq(collegeReconciliations.conflictKey, c.conflictKey))
    .orderBy(desc(collegeReconciliations.createdAt))
    .limit(1);

  if (existing) {
    const claimsChanged =
      existing.sourceAClaim !== c.sourceAClaim || existing.sourceBClaim !== c.sourceBClaim;

    // Resolved conflicts stay resolved unless the underlying claims moved.
    if (
      (existing.status === "resolved" || existing.status === "accepted_as_permanent") &&
      !claimsChanged
    ) {
      return { created: false, reopened: false, id: existing.id };
    }

    if (
      (existing.status === "resolved" || existing.status === "accepted_as_permanent") &&
      claimsChanged
    ) {
      // The sources changed after resolution — this is a NEW disagreement.
      const [row] = await db
        .insert(collegeReconciliations)
        .values({
          conflictKey: c.conflictKey,
          conflictType: c.conflictType,
          subject: c.subject,
          sourceAKey: c.sourceAKey,
          sourceAClaim: c.sourceAClaim,
          sourceBKey: c.sourceBKey,
          sourceBClaim: c.sourceBClaim,
          detail: c.detail,
          provenance: c.provenance ?? "",
          requiredAuthority: c.requiredAuthority,
          requiredAction: c.requiredAction,
          status: "open",
        })
        .returning();
      return { created: true, reopened: true, id: row.id };
    }

    await db
      .update(collegeReconciliations)
      .set({
        lastSeenAt: new Date(),
        sourceAClaim: c.sourceAClaim,
        sourceBClaim: c.sourceBClaim,
        detail: c.detail,
      })
      .where(eq(collegeReconciliations.id, existing.id));
    return { created: false, reopened: false, id: existing.id };
  }

  const [row] = await db
    .insert(collegeReconciliations)
    .values({
      conflictKey: c.conflictKey,
      conflictType: c.conflictType,
      subject: c.subject,
      sourceAKey: c.sourceAKey,
      sourceAClaim: c.sourceAClaim,
      sourceBKey: c.sourceBKey,
      sourceBClaim: c.sourceBClaim,
      detail: c.detail,
      provenance: c.provenance ?? "",
      requiredAuthority: c.requiredAuthority,
      requiredAction: c.requiredAction,
      status: "open",
    })
    .returning();
  return { created: true, reopened: false, id: row.id };
}

export async function listConflicts(status?: string) {
  const base = db.select().from(collegeReconciliations);
  const rows = status
    ? await base
        .where(eq(collegeReconciliations.status, status))
        .orderBy(desc(collegeReconciliations.detectedAt))
        .limit(100)
    : await base.orderBy(desc(collegeReconciliations.detectedAt)).limit(100);
  return rows;
}

export async function openConflicts() {
  return db
    .select()
    .from(collegeReconciliations)
    .where(sql`${collegeReconciliations.status} in ('open','acknowledged','awaiting_authority')`)
    .orderBy(desc(collegeReconciliations.detectedAt));
}

/**
 * Resolve a conflict. This is an institutional act and requires a stated
 * resolution plus its provenance — the system will not accept a bare
 * "it's fine now".
 */
export async function resolveConflict(input: {
  id: string;
  resolution: string;
  resolutionProvenance: string;
  resolvedBy: string;
  status?: "resolved" | "accepted_as_permanent" | "acknowledged" | "awaiting_authority";
}) {
  const [existing] = await db
    .select()
    .from(collegeReconciliations)
    .where(eq(collegeReconciliations.id, input.id))
    .limit(1);
  if (!existing) return { ok: false as const, error: "conflict not found" };

  const status = input.status ?? "resolved";
  const terminal = status === "resolved" || status === "accepted_as_permanent";

  if (terminal && (!input.resolution.trim() || !input.resolutionProvenance.trim())) {
    return {
      ok: false as const,
      error:
        "resolution and resolutionProvenance are required — a conflict is closed by an institutional act, not by assertion",
    };
  }

  const [row] = await db
    .update(collegeReconciliations)
    .set({
      resolution: input.resolution.slice(0, 4000),
      resolutionProvenance: input.resolutionProvenance.slice(0, 1000),
      resolvedBy: input.resolvedBy.slice(0, 120),
      status,
      resolvedAt: terminal ? new Date() : null,
    })
    .where(eq(collegeReconciliations.id, input.id))
    .returning();
  return { ok: true as const, conflict: row };
}
