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

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET → orientation only. The College orients itself before any teaching.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orientation = await buildOrientation({
      courseId: url.searchParams.get("courseId"),
      sessionKind: url.searchParams.get("sessionKind") ?? "lesson",
      weekIndex: url.searchParams.get("weekIndex")
        ? Number(url.searchParams.get("weekIndex"))
        : null,
    });
    return Response.json({ orientation });
  } catch (e) {
    console.error("orientation error", e);
    return Response.json(
      { error: "orientation failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// POST → run one complete class:
//   orient → open session (pinned to curriculum version) → run faculty in their
//   own bounded contexts → coordinate without erasing dissent → registrar
//   worthiness check (handoff, not filing) → session left ready for review.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const sessionKind = String(body.sessionKind ?? "lesson");
    const kind = getSessionKind(sessionKind);
    const courseId = body.courseId ? String(body.courseId) : null;
    const localOnly = body.localOnly === true;

    const state = await computeCollegeState();
    const weekIndex =
      body.weekIndex !== undefined && body.weekIndex !== null
        ? Number(body.weekIndex)
        : (state.position.effectiveWeek.value as number | null);

    // 1) ORIENT
    const orientation = await buildOrientation({ courseId, sessionKind, weekIndex, state });

    // 2) OPEN SESSION — pinned to the curriculum context that exists NOW
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
        facultyPlan: JSON.stringify(orientation.whoShouldAct.map((c) => c.positionKey)),
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

    // 3) TEACH — each position in its own bounded context
    const runs: FacultyRun[] = [];
    const errors: string[] = [];
    for (const c of orientation.whoShouldAct) {
      const r = await runFacultyPosition({
        positionKey: c.positionKey,
        sessionId: session.id,
        courseId,
        weekIndex,
        objective: session.objective,
        orientationBriefing: orientation.briefing,
        priorContributions: runs.map((x) => ({ positionKey: x.positionKey, content: x.content })),
        localOnly,
      });
      if ("error" in r) errors.push(r.error);
      else runs.push(r);
    }

    // 4) COORDINATE — preserve the individual positions
    const coordination = coordinateFaculty(runs);

    await db.insert(collegeSessionEvents).values({
      sessionId: session.id,
      stage: "understanding",
      note: coordination.summary,
      actor: "system",
    });

    // 5) REGISTRAR HANDOFF — Administration is invoked only now, and only
    // evaluates worthiness. It does not attend the class and does not file.
    const worthiness = assessRecordWorthiness({
      subject: session.title,
      content: coordination.summary,
      sessionCompleted: true,
    });

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

    await db.insert(collegeSessionEvents).values({
      sessionId: session.id,
      stage: "faculty_record",
      note: `Faculty handed off to Administration. Record-worthy: ${worthiness.recordWorthy} (${worthiness.reason})`,
      actor: "faculty",
    });

    return Response.json(
      {
        session: updated,
        orientation,
        faculty: runs,
        coordination,
        registrarHandoff: {
          ...worthiness,
          note: "Administration evaluates worthiness. Filing remains a separate explicit act — POST /api/college/records then PATCH action=file.",
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
