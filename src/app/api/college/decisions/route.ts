import { db } from "@/db";
import { collegeInstitutionalDecisions, collegeReconciliations } from "@/db/college";
import { desc, eq } from "drizzle-orm";
import { brisbaneToday } from "@/lib/college/time";
import * as ledger from "@/lib/college/ledger";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

/**
 * INSTITUTIONAL DECISIONS
 *
 * Uncertainty must not paralyse the College. A conflict between two sources is
 * not an error to be silently normalised — it is a place where an institutional
 * decision is needed.
 *
 * Making that decision does NOT delete the disagreement. The conflict stays in
 * college_reconciliations exactly as it was found. What changes is that the
 * College now has a stated position, and the operational state follows the
 * position rather than sitting frozen.
 */
export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const [conflicts, decisions] = await Promise.all([
      db.select().from(collegeReconciliations).orderBy(desc(collegeReconciliations.lastSeenAt)),
      db
        .select()
        .from(collegeInstitutionalDecisions)
        .orderBy(desc(collegeInstitutionalDecisions.createdAt)),
    ]);

    const decisionByConflict = new Map(
      decisions.filter((d) => d.status === "active" && d.conflictKey).map((d) => [d.conflictKey, d])
    );

    return Response.json({
      conflicts: conflicts.map((c) => {
        const decision = decisionByConflict.get(c.conflictKey) ?? null;
        return {
          ...c,
          // The operational position, where one has been taken.
          institutionalDecision: decision,
          // The original disagreement is always still here.
          sourceConflictPreserved: true,
          status: decision ? "decided" : c.status,
          options: decision
            ? null
            : [
                { action: "adopt_a", label: `Adopt: ${c.sourceAKey || "Source A"}`, claim: c.sourceAClaim },
                { action: "adopt_b", label: `Adopt: ${c.sourceBKey || "Source B"}`, claim: c.sourceBClaim },
                { action: "new_position", label: "Create a new institutional position" },
                { action: "leave_unresolved", label: "Leave unresolved for now" },
              ],
        };
      }),
      decisions,
      note: "A decision settles what the College operates on. It never edits or deletes the conflicting sources.",
    });
  } catch (e) {
    console.error("decisions read error", e);
    return Response.json(
      { error: "decisions read failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const _g = await guard(req, "institutional_decision");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const decisionType = String(body.decisionType ?? "");
    const rationale = String(body.rationale ?? "").trim();
    const conflictKey = String(body.conflictKey ?? "");

    if (!["adopt_a", "adopt_b", "new_position", "leave_unresolved"].includes(decisionType)) {
      return Response.json({ error: "unknown decisionType" }, { status: 400 });
    }
    if (!rationale) {
      return Response.json(
        { error: "rationale required — an institutional decision must record why" },
        { status: 400 }
      );
    }

    const [conflict] = conflictKey
      ? await db
          .select()
          .from(collegeReconciliations)
          .where(eq(collegeReconciliations.conflictKey, conflictKey))
          .limit(1)
      : [null];

    // Work out what was chosen and — just as importantly — what was not.
    let statement = String(body.statement ?? "");
    let notChosen = "";
    if (conflict) {
      if (decisionType === "adopt_a") {
        statement = statement || conflict.sourceAClaim;
        notChosen = `${conflict.sourceBKey}: ${conflict.sourceBClaim}`;
      } else if (decisionType === "adopt_b") {
        statement = statement || conflict.sourceBClaim;
        notChosen = `${conflict.sourceAKey}: ${conflict.sourceAClaim}`;
      } else if (decisionType === "new_position") {
        notChosen = `${conflict.sourceAKey}: ${conflict.sourceAClaim} | ${conflict.sourceBKey}: ${conflict.sourceBClaim}`;
      }
    }

    if (decisionType === "leave_unresolved") {
      return Response.json({
        decision: null,
        note: "Left unresolved deliberately. The conflict stays visible and the College continues to operate with the ambiguity acknowledged. This is a legitimate choice, not a failure to decide.",
      });
    }

    if (!statement) {
      return Response.json(
        { error: "statement required for this decision type" },
        { status: 400 }
      );
    }

    // Supersede any prior active decision on the same subject. Superseding is
    // not erasing — the old decision stays readable.
    if (conflictKey) {
      await db
        .update(collegeInstitutionalDecisions)
        .set({ status: "superseded" })
        .where(eq(collegeInstitutionalDecisions.conflictKey, conflictKey));
    }

    const [row] = await db
      .insert(collegeInstitutionalDecisions)
      .values({
        subject: String(body.subject ?? conflict?.subject ?? "Institutional decision"),
        subjectKey: String(body.subjectKey ?? ""),
        conflictKey,
        decisionType,
        statement,
        notChosen,
        rationale,
        decidedBy: String(body.decidedBy ?? "founder"),
        effectiveFrom: String(body.effectiveFrom ?? brisbaneToday()),
        status: "active",
      })
      .returning();

    // The conflict record is marked as having an institutional position — but
    // its sourceAClaim / sourceBClaim are left exactly as they were.
    if (conflict) {
      await db
        .update(collegeReconciliations)
        .set({
          status: "resolved",
          resolution: statement.slice(0, 2000),
          resolutionProvenance: "institutional_decision",
          resolvedBy: String(body.decidedBy ?? "founder"),
          resolvedAt: new Date(),
        })
        .where(eq(collegeReconciliations.id, conflict.id));
    }

    await ledger.record({
      eventType: "decision_recorded",
      summary: `Institutional decision: ${statement.slice(0, 160)}`,
      detail: { decisionType, conflictKey, notChosen },
      actor: "founder",
      severity: "low",
    });

    return Response.json(
      {
        decision: row,
        note: "Recorded as the College's operational position. The original sources are unchanged and the disagreement remains visible in the reconciliation record.",
      },
      { status: 201 }
    );
  } catch (e) {
    console.error("decisions write error", e);
    return Response.json(
      { error: "decision failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
