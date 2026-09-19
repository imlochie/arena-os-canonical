// ============================================================================
// POST /api/college/class-runtime — the Layer 6 member-driven class
// ============================================================================
// The existing /api/college/class remains exactly as it was. This is a second
// entry point rather than a rewrite, because the Layer 2–5 loop is working and
// verified, and replacing it in place would make any regression impossible to
// attribute.
//
// The difference is what drives the sequence. In /api/college/class the
// coordination window is protocol-level: the code knows that factual
// uncertainty means "run the researcher". Here, member configuration and the
// coordination graph decide who wakes, who may be asked, who defers, and who
// speaks — and the runtime validates every proposed action against authority
// before carrying it out.
// ============================================================================

import { db } from "@/db";
import { collegeFacultyMembers, collegeSessionEvents, collegeSessions } from "@/db/college";
import { eq, inArray } from "drizzle-orm";
import { brisbaneToday } from "@/lib/college/time";
import { preflightClass, renderPreflight } from "@/lib/college/class-runtime";
import { executeClass } from "@/lib/college/class-execution";
import { effectivePolicies } from "@/lib/college/attention-resolver";
import { buildOrientation } from "@/lib/college/orientation";
import { detectSignals } from "@/lib/college/coordination";
import { getActiveVersion, snapshotCourse } from "@/lib/college/curriculum";
import { resolveProtocol } from "@/lib/college/protocol";
import { getSessionKind } from "@/lib/college/faculty";
import { assessRecordWorthiness } from "@/lib/college/registrar";
import { recordSessionMembers, resolveFacultyForContext } from "@/lib/college/members";
import { enterPhase } from "@/lib/college/orchestrator";
import * as ledger from "@/lib/college/ledger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const sessionKind = String(body.sessionKind ?? "lesson");
    const kind = getSessionKind(sessionKind);
    const courseId = body.courseId ? String(body.courseId) : null;
    const slotId = body.slotId ? String(body.slotId) : null;
    const studentResponse = body.studentResponse ? String(body.studentResponse) : null;
    const localOnly = body.localOnly === true;
    const declaredEvents: string[] = Array.isArray(body.events) ? body.events.map(String) : [];

    // ---- 1. PREFLIGHT (§2) — before anything is created --------------------
    const preflight = await preflightClass({
      courseId,
      slotId,
      sessionKind,
      weekIndex: body.weekIndex ?? null,
    });

    if (!preflight.canBegin && body.force !== true) {
      return Response.json(
        {
          error: "SESSION CANNOT FULLY INITIALISE",
          preflight,
          rendered: renderPreflight(preflight),
          note: "Nothing has been created and nothing has been substituted. Resolve the blocking problems, or pass force:true to proceed deliberately with the gap recorded.",
        },
        { status: 409 }
      );
    }

    // Preflight-only mode: check the footing without teaching.
    if (body.preflightOnly === true) {
      return Response.json({ preflight, rendered: renderPreflight(preflight) });
    }

    const weekIndex = preflight.objective.weekIndex;
    const objective = String(body.objective ?? preflight.objective.text ?? "");

    // ---- 2. OPEN THE SESSION, pinned to what is true NOW -------------------
    const version = await getActiveVersion();
    const snapshot = courseId
      ? await snapshotCourse(courseId, version?.id ?? null, "session opened (member-driven runtime)")
      : null;

    const protocol = await resolveProtocol(courseId, sessionKind);
    const [session] = await db
      .insert(collegeSessions)
      .values({
        weekIndex,
        courseId,
        slotId,
        // "(unscheduled)" is the preflight's honest label for "no timetable
        // slot is active", but it is a poor session TITLE. Prefer the course,
        // then the session kind, and keep the unscheduled fact in the ledger
        // detail where it belongs.
        title: String(
          body.title ??
            (preflight.slot.source === "none"
              ? preflight.course
                ? `${preflight.course.code} — ${kind.name}`
                : `${kind.emoji} ${kind.name}`
              : preflight.slot.title)
        ).slice(0, 200),
        sessionKind,
        scheduledTime: preflight.slot.startTime,
        observedDate: brisbaneToday(),
        stage: "orientation",
        status: "running",
        objective: objective.slice(0, 2000),
        facultyPlan: JSON.stringify(preflight.faculty.map((f) => f.positionKey)),
        curriculumVersionId: version?.id ?? null,
        courseSnapshotId: snapshot?.id ?? null,
      })
      .returning();

    await ledger.record({
      eventType: "class_opened",
      summary: `Class opened: ${session.title}`,
      detail: {
        runtime: "member_driven",
        sessionKind,
        weekIndex,
        scheduled: preflight.slot.source !== "none",
        preflightSeverity: preflight.severity,
        degradedSubsystems: preflight.diagnostics
          .filter((d) => d.state !== "valid" && d.state !== "not_applicable")
          .map((d) => d.subsystem),
      },
      sessionId: session.id,
      courseId,
      slotId,
      curriculumVersionId: version?.id ?? null,
      actor: "founder",
    });

    // Who actually served, at which version — the historical record.
    const serving = await resolveFacultyForContext({ courseId, sessionKind, slotId });
    if (serving.length) {
      await recordSessionMembers(
        session.id,
        serving.map((m) => ({
          positionKey: m.member.positionKey,
          memberId: m.member.id,
          memberName: m.member.name,
          participation: m.participation,
        }))
      );
    }

    await enterPhase({
      sessionId: session.id,
      phaseKey: "orientation",
      protocol,
      note: "Session opened under the member-driven runtime.",
    }).catch(() => {});

    // ---- 3. RESOLVE POLICIES + MEMBER ROWS ---------------------------------
    const relevantPositions = [
      ...new Set([...kind.requiredPositions, ...protocol.positions.map((p) => p.positionKey)]),
    ];
    const policies = await effectivePolicies({
      courseId,
      sessionKind,
      slotId,
      positions: relevantPositions,
    });

    const memberIds = [...policies.values()].map((p) => p.memberId).filter(Boolean) as string[];
    const memberRows = new Map<string, typeof collegeFacultyMembers.$inferSelect>();
    if (memberIds.length) {
      const rows = await db
        .select()
        .from(collegeFacultyMembers)
        .where(inArray(collegeFacultyMembers.id, memberIds));
      for (const r of rows) memberRows.set(r.positionKey, r);
    }

    // ---- 4. THE EVENTS DRIVING THIS EXCHANGE -------------------------------
    const orientation = await buildOrientation({ courseId, sessionKind, weekIndex });
    const events: Array<{ eventType: string; payload?: string; phaseKey?: string }> = [
      { eventType: "lesson_started", payload: objective, phaseKey: "teaching" },
    ];
    if (studentResponse) {
      events.push({
        eventType: "student_response_received",
        payload: studentResponse,
        phaseKey: "teaching",
      });
      // Heuristic signals are CANDIDATES, never conclusions.
      for (const s of detectSignals(studentResponse)) {
        events.push({ eventType: s.eventType, payload: s.because, phaseKey: "teaching" });
      }
    }
    for (const e of declaredEvents) {
      events.push({ eventType: e, payload: "Declared explicitly by the caller.", phaseKey: "teaching" });
    }

    await enterPhase({ sessionId: session.id, phaseKey: "teaching", protocol }).catch(() => {});

    // ---- 5. EXECUTE --------------------------------------------------------
    const execution = await executeClass({
      sessionId: session.id,
      courseId,
      weekIndex,
      objective,
      orientationBriefing: orientation.briefing,
      policies,
      memberRows,
      events,
      studentResponse,
      phaseKey: "teaching",
      localOnly,
    });

    // ---- 6. CLOSURE (§21) --------------------------------------------------
    await enterPhase({ sessionId: session.id, phaseKey: "reflection", protocol }).catch(() => {});

    const spoke = execution.members.filter((m) => m.output?.permitted);
    const summary = [
      `${execution.members.length} member execution(s); ${execution.silent.length} attended without speaking.`,
      execution.consultations.filter((c) => c.permitted).length
        ? `${execution.consultations.filter((c) => c.permitted).length} consultation(s).`
        : "",
      execution.deferrals.length ? `${execution.deferrals.length} deferral(s).` : "",
      execution.studentFacingResponse
        ? "One student-facing response was produced."
        : "No student-facing response was produced.",
      execution.failures.length ? `${execution.failures.length} failure(s) recorded.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const worthiness = assessRecordWorthiness({
      subject: session.title,
      content: summary,
      sessionCompleted: true,
    });

    const [updated] = await db
      .update(collegeSessions)
      .set({
        stage: "faculty_record",
        status: execution.failures.length ? "interrupted" : "completed",
        summary,
        updatedAt: new Date(),
      })
      .where(eq(collegeSessions.id, session.id))
      .returning();

    await db
      .insert(collegeSessionEvents)
      .values({
        sessionId: session.id,
        stage: "close",
        note: summary,
        actor: "system",
      })
      .catch(() => {});

    await ledger.record({
      eventType: "session_closed",
      summary: `Session closed: ${session.title}`,
      detail: {
        runtime: "member_driven",
        executed: spoke.map((m) => m.positionKey),
        silent: execution.silent.map((s) => s.positionKey),
        consultations: execution.consultations.filter((c) => c.permitted).length,
        deferrals: execution.deferrals.length,
        candidateMemories: execution.candidateMemories.filter((c) => c.stored).length,
        failures: execution.failures.length,
        usedFallback: execution.usedFallback,
      },
      sessionId: session.id,
      courseId,
      curriculumVersionId: version?.id ?? null,
      actor: "system",
    });

    return Response.json(
      {
        session: updated,
        preflight: {
          severity: preflight.severity,
          diagnostics: preflight.diagnostics,
          problems: preflight.problems,
        },
        execution: {
          studentFacingResponse: execution.studentFacingResponse,
          respondingPosition: execution.respondingPosition,
          members: execution.members.map((m) => ({
            positionKey: m.positionKey,
            memberName: m.memberName,
            memberVersion: m.memberVersion,
            attentionState: m.attention.state,
            attentionAction: m.attention.action,
            decidedBy: m.attention.decidedBy,
            reason: m.attention.reason,
            proposedAction: m.output?.proposal.action ?? null,
            executedAction: m.output?.executedAction ?? null,
            permitted: m.output?.permitted ?? false,
            refusal: m.output?.refusal ?? null,
            confidence: m.output?.proposal.confidence ?? null,
            visibleToStudent: m.visibleToStudent,
            fallback: m.output?.fallback ?? null,
            via: m.output?.via ?? null,
            ms: m.ms,
            failure: m.failure,
            context: m.contextSummary,
          })),
          silent: execution.silent,
          consultations: execution.consultations,
          deferrals: execution.deferrals,
          escalations: execution.escalations,
          interruptions: execution.interruptions,
          candidateMemories: execution.candidateMemories,
          failures: execution.failures,
          coordinationGraph: execution.graph,
          usedFallback: execution.usedFallback,
        },
        registrar: {
          ...worthiness,
          note: worthiness.recordWorthy
            ? "Administration evaluates worthiness. Filing remains a separate explicit act."
            : "NO RECORD REQUIRED.",
        },
        curriculumPinned: {
          versionId: version?.id ?? null,
          versionLabel: version?.label ?? null,
          courseSnapshotId: snapshot?.id ?? null,
        },
        note: execution.usedFallback
          ? "FALLBACK EXECUTION was used for at least one member. This demonstrates routing, authority, memory and coordination — it says nothing about the quality of teaching."
          : "All executions reached a live model.",
      },
      { status: 201 }
    );
  } catch (e) {
    console.error("class-runtime error", e);
    return Response.json(
      { error: "class runtime failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
