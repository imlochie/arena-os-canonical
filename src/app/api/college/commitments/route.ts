// ============================================================================
// LAYER 8 — commitments and bounded accountability.
// ============================================================================
// GET    → accountability state (counts, rhythm, overdue, patterns).
// POST   → make a commitment, or close one with what actually happened.
// PATCH  → review a commitment and agree a response, without changing the goal.
//
// The College may PROPOSE a commitment. Only the student may MAKE one:
// college-proposed commitments arrive with `accepted:false` and do nothing
// until accepted. A proposal that self-activates is an obligation the student
// never agreed to, which is precisely the failure mode this layer exists to
// avoid.
// ============================================================================

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { collegeAccountabilitySettings, collegeCommitments } from "@/db/college";
import {
  accountabilityState,
  renderAccountability,
  type Intensity,
} from "@/lib/college/accountability";
import * as ledger from "@/lib/college/ledger";
import { brisbaneToday } from "@/lib/college/time";

const TYPES = ["study_session", "task", "habit", "attendance", "submission", "preparation"];
const CLOSE_STATUSES = ["completed", "missed", "deferred", "cancelled", "partial"];
const REASON_KINDS = ["forgot", "chose_not_to", "circumstance", "unclear_task", "no_reason_given"];

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const at = url.searchParams.get("at");
    const asOf = at ? new Date(at) : new Date();
    if (at && Number.isNaN(asOf.getTime())) {
      return Response.json({ error: `unparseable "at": ${at}` }, { status: 400 });
    }

    const state = await accountabilityState(asOf);

    if (url.searchParams.get("format") === "text") {
      return new Response(renderAccountability(state), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return Response.json({ accountability: state });
  } catch (e) {
    return Response.json(
      { error: "accountability read failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "make");

    // ---- CLOSE: what actually happened ------------------------------------
    // The INTENDED → ATTEMPTED → ACTUAL loop closes here. The College records
    // the outcome the student reports; it never decides the outcome itself.
    if (action === "close") {
      const id = String(body.id ?? "");
      const status = String(body.status ?? "");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      if (!CLOSE_STATUSES.includes(status)) {
        return Response.json(
          { error: `status must be one of ${CLOSE_STATUSES.join(", ")}` },
          { status: 400 }
        );
      }

      const reasonKind = String(body.missedReasonKind ?? "");
      if (status === "missed" && reasonKind && !REASON_KINDS.includes(reasonKind)) {
        return Response.json(
          { error: `missedReasonKind must be one of ${REASON_KINDS.join(", ")}` },
          { status: 400 }
        );
      }

      const [row] = await db
        .update(collegeCommitments)
        .set({
          status,
          actualMinutes:
            body.actualMinutes !== undefined ? Number(body.actualMinutes) : undefined,
          missedReasonKind: status === "missed" ? reasonKind || "no_reason_given" : "",
          missedReason: status === "missed" ? String(body.missedReason ?? "") : "",
          sessionId: body.sessionId ? String(body.sessionId) : undefined,
          completedAt: status === "completed" || status === "partial" ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(collegeCommitments.id, id))
        .returning();

      if (!row) return Response.json({ error: "commitment not found" }, { status: 404 });

      await ledger.record({
        eventType: "commitment_closed",
        summary: `Commitment "${row.statement}" recorded as ${status}.`,
        detail: {
          commitmentId: row.id,
          status,
          plannedMinutes: row.plannedMinutes,
          actualMinutes: row.actualMinutes,
          missedReasonKind: row.missedReasonKind,
        },
        sessionId: row.sessionId ?? undefined,
        actor: "founder",
      });

      return Response.json({
        commitment: row,
        note:
          status === "missed"
            ? "Recorded as missed. That is a fact about the commitment, not a conclusion about the student, and the goal is unchanged."
            : "Recorded as it happened.",
      });
    }

    // ---- MAKE: a new commitment -------------------------------------------
    const statement = String(body.statement ?? "").trim();
    if (!statement) {
      return Response.json({ error: "statement required" }, { status: 400 });
    }
    const commitmentType = String(body.commitmentType ?? "study_session");
    if (!TYPES.includes(commitmentType)) {
      return Response.json(
        { error: `commitmentType must be one of ${TYPES.join(", ")}` },
        { status: 400 }
      );
    }

    const origin = body.origin === "college_proposed" ? "college_proposed" : "student";

    const [row] = await db
      .insert(collegeCommitments)
      .values({
        statement,
        commitmentType,
        goalId: body.goalId ? String(body.goalId) : null,
        courseId: body.courseId ? String(body.courseId) : null,
        externalCommitmentId: body.externalCommitmentId
          ? String(body.externalCommitmentId)
          : null,
        dueDate: body.dueDate ? String(body.dueDate) : null,
        plannedMinutes:
          body.plannedMinutes !== undefined && body.plannedMinutes !== null
            ? Number(body.plannedMinutes)
            : null,
        origin,
        // A College proposal is inert until the student accepts it.
        accepted: origin === "student",
        status: "open",
        notes: String(body.notes ?? ""),
      })
      .returning();

    await ledger.record({
      eventType: "commitment_made",
      summary:
        origin === "student"
          ? `Committed: "${statement}".`
          : `The College proposed a commitment: "${statement}". It is inert until accepted.`,
      detail: {
        commitmentId: row.id,
        dueDate: row.dueDate,
        plannedMinutes: row.plannedMinutes,
        origin,
        accepted: row.accepted,
      },
      date: brisbaneToday(),
      actor: origin === "student" ? "founder" : "system",
    });

    return Response.json(
      {
        commitment: row,
        note:
          origin === "student"
            ? "Recorded as a commitment the student made. The College will report on it without moving it."
            : "Recorded as a PROPOSAL. It creates no obligation until explicitly accepted — the College may suggest, never impose.",
      },
      { status: 201 }
    );
  } catch (e) {
    return Response.json(
      { error: "commitment write failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    // ---- accountability intensity -----------------------------------------
    // Wording only. This cannot create an obligation or grant any authority.
    if (body.action === "set_intensity") {
      const intensity = String(body.intensity ?? "") as Intensity;
      if (!["gentle", "direct", "firm"].includes(intensity)) {
        return Response.json(
          { error: "intensity must be gentle, direct or firm" },
          { status: 400 }
        );
      }
      const [existing] = await db.select().from(collegeAccountabilitySettings).limit(1);
      const values = {
        intensity,
        patternWindowDays:
          body.patternWindowDays !== undefined
            ? Number(body.patternWindowDays)
            : (existing?.patternWindowDays ?? 14),
        patternThreshold:
          body.patternThreshold !== undefined
            ? Number(body.patternThreshold)
            : (existing?.patternThreshold ?? 3),
        reason: String(body.reason ?? ""),
        updatedAt: new Date(),
      };
      const [row] = existing
        ? await db
            .update(collegeAccountabilitySettings)
            .set(values)
            .where(eq(collegeAccountabilitySettings.id, existing.id))
            .returning()
        : await db.insert(collegeAccountabilitySettings).values(values).returning();

      return Response.json({
        settings: row,
        note:
          "Intensity changes how accountability is worded. It does not change what is true, cannot create an obligation, and grants no faculty member any authority it did not already hold.",
      });
    }

    // ---- accept a College-proposed commitment ------------------------------
    if (body.action === "accept") {
      const id = String(body.id ?? "");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const [row] = await db
        .update(collegeCommitments)
        .set({ accepted: true, updatedAt: new Date() })
        .where(eq(collegeCommitments.id, id))
        .returning();
      if (!row) return Response.json({ error: "commitment not found" }, { status: 404 });
      return Response.json({
        commitment: row,
        note: "Accepted by the student. Only now is it a commitment the College may report against.",
      });
    }

    // ---- review: agree a response, settle it, DON'T move the goal ----------
    const id = String(body.id ?? "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });

    const agreedResponse = String(body.agreedResponse ?? "").trim();
    if (!agreedResponse) {
      return Response.json(
        {
          error: "agreedResponse required",
          note:
            "Reviewing a commitment means deciding what to do about it. 'Leave it exactly as it is' is a legitimate response — but it has to be said.",
        },
        { status: 400 }
      );
    }

    const [row] = await db
      .update(collegeCommitments)
      .set({
        lastReviewedAt: new Date(),
        agreedResponse,
        reviewAfter: body.reviewAfter ? String(body.reviewAfter) : null,
        updatedAt: new Date(),
      })
      .where(eq(collegeCommitments.id, id))
      .returning();

    if (!row) return Response.json({ error: "commitment not found" }, { status: 404 });

    await ledger.record({
      eventType: "commitment_reviewed",
      summary: `Commitment "${row.statement}" reviewed: ${agreedResponse}`,
      detail: { commitmentId: row.id, agreedResponse, reviewAfter: row.reviewAfter },
      actor: "founder",
    });

    return Response.json({
      commitment: row,
      note:
        "Reviewed. The goal is untouched — changing an objective is a separate institutional decision, never a side effect of a missed session.",
    });
  } catch (e) {
    return Response.json(
      { error: "commitment update failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
