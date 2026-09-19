import {
  ATTENTION_POLICIES,
  ATTENTION_STATES,
  PRIORITY_RULE,
  SESSION_EVENT_TYPES,
  SESSION_PHASES,
  checkRemit,
  mayConsult,
  mayHandOff,
  mayInterrupt,
  type AttentionPriority,
} from "@/lib/college/attention";
import { getFacultyPosition } from "@/lib/college/faculty";
import {
  attemptInterruption,
  coordinationTrace,
  currentAttention,
  emitEvent,
  enterPhase,
} from "@/lib/college/orchestrator";
import { resolveProtocol } from "@/lib/college/protocol";

export const dynamic = "force-dynamic";

// GET → the attention model itself, or a session's live attention state.
//
//   /api/college/attention                 → policies, phases, events, states
//   /api/college/attention?sessionId=...   → who is attending, and why
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");

    if (sessionId) {
      const [attention, trace] = await Promise.all([
        currentAttention(sessionId),
        coordinationTrace(sessionId),
      ]);
      return Response.json({
        sessionId,
        attention,
        trace,
        note: "A position in WATCHING is attending without speaking. Dormant positions consume no context at all.",
      });
    }

    return Response.json({
      policies: ATTENTION_POLICIES.map((p) => ({
        ...p,
        name: getFacultyPosition(p.positionKey)?.name ?? p.positionKey,
        branch: getFacultyPosition(p.positionKey)?.branch ?? "faculty",
      })),
      phases: SESSION_PHASES,
      eventTypes: SESSION_EVENT_TYPES,
      states: ATTENTION_STATES,
      priorityRules: PRIORITY_RULE,
      note: "Attention is declarative policy, evaluated by the orchestrator. No model decides when it is important enough to speak.",
    });
  } catch (e) {
    console.error("attention error", e);
    return Response.json(
      { error: "attention read failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// POST → drive the orchestrator.
//   action=emit        emit a session event and see who it routes to
//   action=phase       enter a session phase
//   action=interrupt   attempt an interruption (refusals are recorded)
//   action=check       ask whether a matter is within a position's remit
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body.action ?? "emit");

    if (action === "check") {
      const positionKey = String(body.positionKey ?? "");
      const matter = String(body.matter ?? "");
      if (!positionKey || !matter) {
        return Response.json({ error: "positionKey and matter required" }, { status: 400 });
      }
      const remit = checkRemit(positionKey, matter);
      const consult = body.consult ? mayConsult(positionKey, String(body.consult)) : null;
      const handoff = body.handoffTo ? mayHandOff(positionKey, String(body.handoffTo)) : null;
      const interrupt = mayInterrupt(
        positionKey,
        (body.urgency as AttentionPriority) ?? "normal",
        {
          materiallyAffectsLesson: body.materiallyAffectsLesson === true,
          institutionalIntegrity: body.institutionalIntegrity === true,
        }
      );
      return Response.json({ remit, consult, handoff, interrupt });
    }

    const sessionId = String(body.sessionId ?? "");
    if (!sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });
    const protocol = await resolveProtocol(
      body.courseId ? String(body.courseId) : null,
      String(body.sessionKind ?? "lesson")
    );

    if (action === "phase") {
      const phaseKey = String(body.phaseKey ?? "");
      if (!SESSION_PHASES.some((p) => p.key === phaseKey)) {
        return Response.json(
          { error: `unknown phase "${phaseKey}"`, known: SESSION_PHASES.map((p) => p.key) },
          { status: 400 }
        );
      }
      const result = await enterPhase({
        sessionId,
        phaseKey,
        protocol,
        note: String(body.note ?? ""),
      });
      return Response.json({ phase: result, attention: await currentAttention(sessionId) });
    }

    if (action === "interrupt") {
      const positionKey = String(body.positionKey ?? "");
      const reason = String(body.reason ?? "");
      if (!positionKey || !reason) {
        return Response.json(
          {
            error:
              "positionKey and reason required — every interruption must carry a reason. Arbitrary model confidence is not a reason.",
          },
          { status: 400 }
        );
      }
      const result = await attemptInterruption({
        sessionId,
        positionKey,
        interruptedPosition: body.interruptedPosition ? String(body.interruptedPosition) : undefined,
        reason,
        urgency: (body.urgency as AttentionPriority) ?? "normal",
        materiallyAffectsLesson: body.materiallyAffectsLesson === true,
        institutionalIntegrity: body.institutionalIntegrity === true,
      });
      return Response.json(result, { status: result.allowed ? 200 : 403 });
    }

    // default: emit
    const eventType = String(body.eventType ?? "");
    if (!SESSION_EVENT_TYPES.includes(eventType as (typeof SESSION_EVENT_TYPES)[number])) {
      return Response.json(
        { error: `unknown event type "${eventType}"`, known: SESSION_EVENT_TYPES },
        { status: 400 }
      );
    }
    const result = await emitEvent({
      sessionId,
      eventType,
      payload: String(body.payload ?? ""),
      emittedBy: String(body.emittedBy ?? "system"),
      protocol,
    });
    return Response.json({
      ...result,
      attention: await currentAttention(sessionId),
      note: "Positions listed in ignoredBy did not wake. Silence is a recorded decision, not an omission.",
    });
  } catch (e) {
    console.error("attention post error", e);
    return Response.json(
      { error: "attention action failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
