import { db } from "@/db";
import { collegeConsultations, collegeHandoffs } from "@/db/college";
import { desc, eq } from "drizzle-orm";
import {
  answerConsultation,
  coordinationTrace,
  handOff,
  requestConsultation,
  settleHandoff,
} from "@/lib/college/orchestrator";
import { deferIfOutOfRemit } from "@/lib/college/coordination";
import type { AttentionPriority } from "@/lib/college/attention";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

// GET → consultations, handoffs and the full coordination trace for a session.
export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });

    const [consultations, handoffs, trace] = await Promise.all([
      db
        .select()
        .from(collegeConsultations)
        .where(eq(collegeConsultations.sessionId, sessionId))
        .orderBy(desc(collegeConsultations.createdAt)),
      db
        .select()
        .from(collegeHandoffs)
        .where(eq(collegeHandoffs.sessionId, sessionId))
        .orderBy(desc(collegeHandoffs.createdAt)),
      coordinationTrace(sessionId),
    ]);

    return Response.json({
      consultations,
      handoffs,
      trace,
      note: "Structured actions, reasons, evidence references and outcomes. Internal reasoning is deliberately not stored or exposed.",
    });
  } catch (e) {
    console.error("coordination read error", e);
    return Response.json(
      { error: "coordination read failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// POST → coordination acts.
//   action=consult   one position formally requests another
//   action=answer    the consulted position responds
//   action=handoff   deliberate transfer of responsibility
//   action=settle    the receiving position accepts / defers / refuses
export async function POST(req: Request) {
  const _g = await guard(req, "run_session");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const action = String(body.action ?? "consult");

    if (action === "consult") {
      const sessionId = String(body.sessionId ?? "");
      const from = String(body.requestingPosition ?? "");
      const to = String(body.requestedPosition ?? "");
      const question = String(body.question ?? "");
      const reason = String(body.reason ?? "");
      if (!sessionId || !from || !to || !question) {
        return Response.json(
          { error: "sessionId, requestingPosition, requestedPosition and question are required" },
          { status: 400 }
        );
      }

      // Role-creep guard: a position must not consult its way into another's job.
      const defer = deferIfOutOfRemit(to, question);
      if (defer.defer) {
        return Response.json(
          {
            error: defer.message,
            deferTo: defer.to,
            note: "The consulted position would be answering outside its remit. Ask the position that owns the matter.",
          },
          { status: 403 }
        );
      }

      const result = await requestConsultation({
        sessionId,
        requestingPosition: from,
        requestedPosition: to,
        reason,
        question,
        evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs.map(String) : [],
        urgency: (body.urgency as AttentionPriority) ?? "normal",
        scope: String(body.scope ?? ""),
        responseRequired: body.responseRequired !== false,
      });
      if (!result.ok) return Response.json({ error: result.error }, { status: 403 });
      return Response.json({ consultation: result.consultation }, { status: 201 });
    }

    if (action === "answer") {
      const id = String(body.id ?? "");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const row = await answerConsultation({
        id,
        response: String(body.response ?? ""),
        outcome: String(body.outcome ?? ""),
        contributionId: body.contributionId ? String(body.contributionId) : null,
        status: body.status as "answered" | "declined" | "out_of_remit" | undefined,
      });
      if (!row) return Response.json({ error: "consultation not found" }, { status: 404 });
      return Response.json({ consultation: row });
    }

    if (action === "handoff") {
      const sessionId = String(body.sessionId ?? "");
      const from = String(body.fromPosition ?? "");
      const to = String(body.toPosition ?? "");
      const reason = String(body.reason ?? "");
      if (!sessionId || !from || !to || !reason) {
        return Response.json(
          {
            error:
              "sessionId, fromPosition, toPosition and reason are required — a handoff is explicit and auditable",
          },
          { status: 400 }
        );
      }
      const result = await handOff({
        sessionId,
        fromPosition: from,
        toPosition: to,
        reason,
        payload: String(body.payload ?? ""),
      });
      if (!result.ok) return Response.json({ error: result.error }, { status: 403 });
      return Response.json({ handoff: result.handoff }, { status: 201 });
    }

    if (action === "settle") {
      const id = String(body.id ?? "");
      const disposition = String(body.disposition ?? "");
      if (!id || !["accepted", "deferred", "refused"].includes(disposition)) {
        return Response.json(
          { error: "id and disposition (accepted|deferred|refused) required" },
          { status: 400 }
        );
      }
      const row = await settleHandoff({
        id,
        disposition: disposition as "accepted" | "deferred" | "refused",
        dispositionReason: String(body.dispositionReason ?? ""),
      });
      if (!row) return Response.json({ error: "handoff not found" }, { status: 404 });
      return Response.json({ handoff: row });
    }

    return Response.json({ error: `unknown action "${action}"` }, { status: 400 });
  } catch (e) {
    console.error("coordination error", e);
    return Response.json(
      { error: "coordination action failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
