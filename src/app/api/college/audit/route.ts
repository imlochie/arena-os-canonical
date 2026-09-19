import {
  auditCourse,
  auditHistory,
  auditSlot,
  comparePeriods,
  getIntent,
  getThresholds,
  isSettled,
  recordAudit,
  setIntent,
  type AuditDecision,
} from "@/lib/college/audit";
import { db } from "@/db";
import { collegeAuditThresholds, collegeIntents } from "@/db/college";
import { desc } from "drizzle-orm";
import { addDays, brisbaneToday } from "@/lib/college/time";

export const dynamic = "force-dynamic";

// GET → run an audit, compare periods, or read history.
//   ?scopeType=slot&scopeId=...&from=&to=
//   ?compare=1&aStart=&aEnd=&bStart=&bEnd=
//   ?view=history
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const view = url.searchParams.get("view");

    if (view === "history") {
      const rows = await auditHistory(
        url.searchParams.get("scopeType") ?? undefined,
        url.searchParams.get("scopeId") ?? undefined
      );
      return Response.json({ audits: rows });
    }

    if (view === "intents") {
      const rows = await db.select().from(collegeIntents).orderBy(desc(collegeIntents.createdAt));
      const thresholds = await db.select().from(collegeAuditThresholds);
      return Response.json({ intents: rows, thresholds });
    }

    const scopeType = url.searchParams.get("scopeType") ?? "slot";
    const scopeId = url.searchParams.get("scopeId");
    if (!scopeId) return Response.json({ error: "scopeId required" }, { status: 400 });

    const to = url.searchParams.get("to") ?? brisbaneToday();
    const from = url.searchParams.get("from") ?? addDays(to, -70);

    if (url.searchParams.get("compare") === "1") {
      const comparison = await comparePeriods({
        scopeType: scopeType === "course" ? "course" : "slot",
        scopeId,
        aStart: url.searchParams.get("aStart") ?? addDays(to, -70),
        aEnd: url.searchParams.get("aEnd") ?? addDays(to, -35),
        bStart: url.searchParams.get("bStart") ?? addDays(to, -35),
        bEnd: url.searchParams.get("bEnd") ?? to,
      });
      return Response.json({ comparison });
    }

    const report =
      scopeType === "course" ? await auditCourse(scopeId, from, to) : await auditSlot(scopeId, from, to);
    const settled = await isSettled(scopeType, scopeId);
    const thresholds = await getThresholds(scopeType, scopeId);

    return Response.json({
      report,
      settled,
      thresholds,
      note: settled.settled
        ? `This question was settled as KEEP AS IS and is not due for review until ${settled.until}. The audit is shown for information only.`
        : "An audit describes what happened. It does not create an obligation to change anything.",
    });
  } catch (e) {
    console.error("audit read error", e);
    return Response.json(
      { error: "audit failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// POST → record an audit decision, set an intent, or configure thresholds.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body.action ?? "decide");

    if (action === "set_intent") {
      const statement = String(body.statement ?? "").trim();
      if (!statement) return Response.json({ error: "statement required" }, { status: 400 });
      const row = await setIntent({
        subjectType: String(body.subjectType ?? "slot"),
        subjectId: body.subjectId ? String(body.subjectId) : null,
        subjectKey: String(body.subjectKey ?? ""),
        statement,
        intentKind: body.intentKind,
        reviewAfterDays: body.reviewAfterDays ?? null,
        reason: String(body.reason ?? ""),
      });
      return Response.json(
        {
          intent: row,
          note: "Intent recorded. Previous intent superseded, not erased — historical audits are never re-judged against a goal that did not exist at the time.",
        },
        { status: 201 }
      );
    }

    if (action === "set_thresholds") {
      const [row] = await db
        .insert(collegeAuditThresholds)
        .values({
          scopeType: String(body.scopeType ?? "slot"),
          scopeId: body.scopeId ? String(body.scopeId) : null,
          minObservations: Number(body.minObservations ?? 4),
          minWeeks: Number(body.minWeeks ?? 3),
          deviationsBeforeReview: Number(body.deviationsBeforeReview ?? 3),
          reviewIntervalDays: Number(body.reviewIntervalDays ?? 28),
          reason: String(body.reason ?? ""),
        })
        .returning();
      return Response.json(
        {
          thresholds: row,
          note: "Thresholds are institutional configuration. Arena does not assume what counts as meaningful evidence.",
        },
        { status: 201 }
      );
    }

    // default: record a decision
    const scopeType = String(body.scopeType ?? "slot");
    const scopeId = String(body.scopeId ?? "");
    const decision = String(body.decision ?? "no_decision") as AuditDecision;
    const decisionReason = String(body.decisionReason ?? "").trim();

    if (!scopeId) return Response.json({ error: "scopeId required" }, { status: 400 });
    if (!decisionReason) {
      return Response.json(
        { error: "decisionReason required — an audit conclusion is an institutional decision" },
        { status: 400 }
      );
    }

    const to = String(body.to ?? brisbaneToday());
    const from = String(body.from ?? addDays(to, -70));
    const report =
      scopeType === "course" ? await auditCourse(scopeId, from, to) : await auditSlot(scopeId, from, to);

    // Guard: a change proposal on insufficient evidence is refused outright.
    if (decision === "propose_change" && report.auditStatus === "insufficient_evidence") {
      return Response.json(
        {
          error:
            "Cannot propose a change on insufficient evidence. " + report.sufficiency,
          report,
        },
        { status: 400 }
      );
    }

    const result = await recordAudit({
      report,
      decision,
      decisionReason,
      decidedBy: String(body.decidedBy ?? "founder"),
      reviewIntervalDays: body.reviewIntervalDays ? Number(body.reviewIntervalDays) : undefined,
    });

    return Response.json({ ...result, report }, { status: 201 });
  } catch (e) {
    console.error("audit write error", e);
    return Response.json(
      { error: "audit write failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
