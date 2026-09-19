import { db } from "@/db";
import { collegeSessionEvents, collegeSessions } from "@/db/college";
import { eq } from "drizzle-orm";
import { buildOrientation } from "@/lib/college/orientation";
import { coordinateFaculty, runFacultyPosition, type FacultyRun } from "@/lib/college/teaching";
import { getSessionKind } from "@/lib/college/faculty";
import { assessRecordWorthiness } from "@/lib/college/registrar";
import { computeCollegeState } from "@/lib/college/state";
import { getActiveVersion, snapshotCourse } from "@/lib/college/curriculum";
import { brisbaneToday } from "@/lib/college/time";
import { resolveProtocol, initialRoster } from "@/lib/college/protocol";
import { validateRoster, resolveFacultyForContext, recordSessionMembers } from "@/lib/college/members";
import {
  coordinationTrace,
  currentAttention,
  emitEvent,
  enterPhase,
  handOff,
  setAttention,
  settleHandoff,
} from "@/lib/college/orchestrator";
import { runCoordinationWindow } from "@/lib/college/coordination";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET → orientation only. The College orients itself before any teaching.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const courseId = url.searchParams.get("courseId");
    const sessionKind = url.searchParams.get("sessionKind") ?? "lesson";
    const orientation = await buildOrientation({
      courseId,
      sessionKind,
      weekIndex: url.searchParams.get("weekIndex")
        ? Number(url.searchParams.get("weekIndex"))
        : null,
    });
    const protocol = await resolveProtocol(courseId, sessionKind);
    return Response.json({
      orientation,
      protocol,
      plannedRoster: initialRoster(protocol),
      note: "Faculty are not all activated. The protocol declares who is primary, who watches continuously, and who stays dormant until a declared condition occurs.",
    });
  } catch (e) {
    console.error("orientation error", e);
    return Response.json(
      { error: "orientation failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// POST → run one complete class under faculty orchestration.
//
//   orient → resolve the course's faculty protocol → open session (pinned to
//   the curriculum) → set initial attention → move through phases → route
//   events to the positions whose remit they fall in → optional coordination
//   window over a student response → close → registrar handoff.
//
// Positions that are not relevant stay dormant. Attending is not speaking.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const sessionKind = String(body.sessionKind ?? "lesson");
    const kind = getSessionKind(sessionKind);
    const courseId = body.courseId ? String(body.courseId) : null;
    const localOnly = body.localOnly === true;
    const studentResponse = body.studentResponse ? String(body.studentResponse) : null;
    const declaredEvents: string[] = Array.isArray(body.events) ? body.events.map(String) : [];

    const state = await computeCollegeState();
    const weekIndex =
      body.weekIndex !== undefined && body.weekIndex !== null
        ? Number(body.weekIndex)
        : (state.position.effectiveWeek.value as number | null);

    // 1) ORIENT
    const orientation = await buildOrientation({ courseId, sessionKind, weekIndex, state });

    // 2) PROTOCOL — the course decides which faculty are relevant to it
    const protocol = await resolveProtocol(courseId, sessionKind);

    // 2b) REQUIRED-FACULTY VALIDATION — before anything begins.
    // A mandatory responsibility that cannot be instantiated is surfaced, and
    // never silently substituted with an unrelated faculty member.
    const rosterCheck = await validateRoster({
      courseId,
      sessionKind,
      requiredPositions: kind.requiredPositions,
    });
    if (!rosterCheck.canInitialise && body.force !== true) {
      return Response.json(
        {
          error: "SESSION CANNOT FULLY INITIALISE",
          roster: rosterCheck.roster,
          problems: rosterCheck.problems,
          severity: rosterCheck.severity,
          note: "A mandatory faculty responsibility has no active configuration. Configure it, or pass force:true to proceed deliberately with the gap recorded.",
        },
        { status: 409 }
      );
    }

    // 3) OPEN SESSION — pinned to the curriculum context that exists NOW
    const version = await getActiveVersion();
    const snapshot = courseId
      ? await snapshotCourse(courseId, version?.id ?? null, "session opened")
      : null;

    const [session] = await db
      .insert(collegeSessions)
      .values({
        weekIndex,
        courseId,
        title: String(body.title ?? `${kind.emoji} ${kind.name}`).slice(0, 200),
        sessionKind,
        observedDate: brisbaneToday(),
        stage: "orientation",
        status: "running",
        objective: String(
          body.objective ?? orientation.whatShouldBeHappening.objective ?? ""
        ).slice(0, 2000),
        facultyPlan: JSON.stringify(protocol.positions.map((p) => p.positionKey)),
        curriculumVersionId: version?.id ?? null,
        courseSnapshotId: snapshot?.id ?? null,
      })
      .returning();

    await db.insert(collegeSessionEvents).values({
      sessionId: session.id,
      stage: "orientation",
      note: `Oriented. ${orientation.whereAreWe.summary}`,
      actor: "system",
    });

    // 4) INITIAL ATTENTION — most of the faculty is deliberately dormant
    for (const r of initialRoster(protocol)) {
      await setAttention({
        sessionId: session.id,
        positionKey: r.positionKey,
        state: r.state,
        reason: r.reason,
        phaseKey: "orientation",
      });
    }

    // Record WHICH MEMBER occupied each position, at which version, so the
    // historical record knows who actually taught this class.
    const servingMembers = await resolveFacultyForContext({ courseId, sessionKind });
    if (servingMembers.length) {
      await recordSessionMembers(
        session.id,
        servingMembers.map((m) => ({
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
      note: "Session opened.",
    });

    await emitEvent({
      sessionId: session.id,
      eventType: "lesson_started",
      payload: session.objective || "(no objective recorded)",
      emittedBy: "system",
      protocol,
    });

    // Context that genuinely changes attention is an event, not decoration.
    if (state.attention?.items?.some((i) => /deviation/i.test(i.title ?? ""))) {
      await emitEvent({
        sessionId: session.id,
        eventType: "timetable_deviation_detected",
        payload: "An open deviation exists in College State.",
        emittedBy: "system",
        protocol,
      });
    }

    // 5) TEACHING PHASE — only positions the phase makes primary actually run
    await enterPhase({ sessionId: session.id, phaseKey: "teaching", protocol });

    const runs: FacultyRun[] = [];
    const errors: string[] = [];
    const attentionAfterPhase = await currentAttention(session.id);
    const speaking = attentionAfterPhase.filter((a) => a.state === "engaged");

    for (const a of speaking) {
      // When the student has said something, the Instructor speaks ONCE — at the
      // end of the coordination window, after the other positions have fed in.
      // Running it here as well would produce two student-facing answers.
      if (studentResponse && a.positionKey === "instructor") {
        await setAttention({
          sessionId: session.id,
          positionKey: "instructor",
          state: "engaged",
          reason: "Holding the response until faculty coordination has completed.",
          spoke: false,
        });
        continue;
      }

      const r = await runFacultyPosition({
        positionKey: a.positionKey,
        sessionId: session.id,
        courseId,
        weekIndex,
        objective: session.objective,
        orientationBriefing: orientation.briefing,
        priorContributions: runs.map((x) => ({ positionKey: x.positionKey, content: x.content })),
        localOnly,
        sessionKind,
      });
      if ("error" in r) errors.push(r.error);
      else {
        runs.push(r);
        await setAttention({
          sessionId: session.id,
          positionKey: a.positionKey,
          state: "engaged",
          reason: "Contributed to the teaching phase.",
          spoke: true,
        });
      }
    }

    // 6) COORDINATION WINDOW — only when the student actually said something
    let window = null;
    if (studentResponse) {
      window = await runCoordinationWindow({
        sessionId: session.id,
        protocol,
        studentResponse,
        courseId,
        weekIndex,
        objective: session.objective,
        orientationBriefing: orientation.briefing,
        declaredEvents,
        localOnly,
      });
      for (const c of window.internalContributions) {
        if (!runs.some((r) => r.positionKey === c.positionKey && r.content === c.content)) {
          runs.push(c);
        }
      }
    }

    // 7) REFLECTION
    await enterPhase({ sessionId: session.id, phaseKey: "reflection", protocol });

    const coordination = coordinateFaculty(runs);
    await db.insert(collegeSessionEvents).values({
      sessionId: session.id,
      stage: "understanding",
      note: coordination.summary,
      actor: "system",
    });

    // 8) SESSION NEARING COMPLETION — this is what wakes Administration
    await emitEvent({
      sessionId: session.id,
      eventType: "session_nearing_completion",
      payload: "Teaching complete; evaluating record-worthiness.",
      emittedBy: "system",
      protocol,
    });

    // 9) HANDOFF ACROSS THE BRANCH BOUNDARY — explicit and auditable
    const worthiness = assessRecordWorthiness({
      subject: session.title,
      content: coordination.summary,
      sessionCompleted: true,
    });

    let registrarHandoff = null;
    if (worthiness.recordWorthy) {
      await enterPhase({ sessionId: session.id, phaseKey: "institutional_record", protocol });
      const ho = await handOff({
        sessionId: session.id,
        fromPosition: "instructor",
        toPosition: "registrar",
        reason: worthiness.reason,
        payload: coordination.summary,
      });
      if (ho.ok) {
        await settleHandoff({
          id: ho.handoff.id,
          disposition: "accepted",
          dispositionReason:
            "Administration accepts the handoff and will evaluate record-worthiness. Filing remains a separate act.",
        });
        registrarHandoff = ho.handoff;
      }
    } else {
      await setAttention({
        sessionId: session.id,
        positionKey: "registrar",
        state: "dormant",
        reason: "Nothing record-worthy occurred. No record required.",
      });
    }

    const [updated] = await db
      .update(collegeSessions)
      .set({
        stage: "faculty_record",
        status: "completed",
        summary: coordination.summary,
        updatedAt: new Date(),
      })
      .where(eq(collegeSessions.id, session.id))
      .returning();

    const trace = await coordinationTrace(session.id);
    const finalAttention = await currentAttention(session.id);

    return Response.json(
      {
        session: updated,
        protocol: { label: protocol.label, isDefault: protocol.isDefault },
        rosterValidation: rosterCheck,
        servingMembers: servingMembers.map((m) => ({
          positionKey: m.member.positionKey,
          memberName: m.member.name,
          version: m.member.version,
          scope: m.scope,
          participation: m.participation,
        })),
        orientation,
        faculty: runs,
        coordination,
        coordinationWindow: window,
        attention: finalAttention,
        trace,
        registrarHandoff: {
          ...worthiness,
          handoff: registrarHandoff,
          note: worthiness.recordWorthy
            ? "Administration evaluates worthiness. Filing remains a separate explicit act — POST /api/college/records then PATCH action=file."
            : "NO RECORD REQUIRED. The Registrar stayed dormant.",
        },
        facultyErrors: errors,
        curriculumPinned: {
          versionId: version?.id ?? null,
          versionLabel: version?.label ?? null,
          courseSnapshotId: snapshot?.id ?? null,
          note: "This session is pinned to the curriculum as it existed today. Later curriculum edits will not rewrite it.",
        },
      },
      { status: 201 }
    );
  } catch (e) {
    console.error("class run error", e);
    return Response.json(
      { error: "class failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
