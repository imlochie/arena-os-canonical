import { db } from "@/db";
import {
  collegeFacultyContributions,
  collegeSessionEvents,
  collegeSessionFaculty,
  collegeSessions,
} from "@/db/college";
import { desc, eq } from "drizzle-orm";
import { deriveFacultyComposition, getSessionKind } from "@/lib/college/faculty";
import { computeCollegeState } from "@/lib/college/state";
import { brisbaneToday } from "@/lib/college/time";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

// GET → sessions, newest first. ?id= returns one with its full trail.
export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (id) {
      const [session] = await db
        .select()
        .from(collegeSessions)
        .where(eq(collegeSessions.id, id))
        .limit(1);
      if (!session) return Response.json({ error: "not found" }, { status: 404 });
      const [events, faculty, contributions] = await Promise.all([
        db
          .select()
          .from(collegeSessionEvents)
          .where(eq(collegeSessionEvents.sessionId, id))
          .orderBy(collegeSessionEvents.createdAt),
        db.select().from(collegeSessionFaculty).where(eq(collegeSessionFaculty.sessionId, id)),
        db
          .select()
          .from(collegeFacultyContributions)
          .where(eq(collegeFacultyContributions.sessionId, id))
          .orderBy(collegeFacultyContributions.createdAt),
      ]);
      return Response.json({ session, events, faculty, contributions });
    }
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
    const rows = await db
      .select()
      .from(collegeSessions)
      .orderBy(desc(collegeSessions.createdAt))
      .limit(limit);
    return Response.json({ sessions: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ sessions: [] });
  }
}

// POST → open a session. Faculty composition is DERIVED from the session kind
// and current circumstances, not hardcoded.
export async function POST(req: Request) {
  const _g = await guard(req, "run_session");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const sessionKind = String(body.sessionKind ?? "lesson");
    const kind = getSessionKind(sessionKind);
    const state = await computeCollegeState();

    const composition = deriveFacultyComposition(sessionKind, {
      hasOpenDeviation: state.deviations.count > 0,
      isRevisit: Boolean(body.isRevisit),
    });

    const [session] = await db
      .insert(collegeSessions)
      .values({
        termId: body.termId ?? null,
        weekIndex: body.weekIndex ?? state.position.effectiveWeek.value ?? null,
        courseId: body.courseId ?? null,
        slotId: body.slotId ?? null,
        title: String(body.title ?? `${kind.emoji} ${kind.name}`).slice(0, 200),
        sessionKind,
        scheduledDate: body.scheduledDate ?? null,
        scheduledTime: body.scheduledTime ?? "",
        observedDate: brisbaneToday(),
        stage: kind.stages[0] ?? "orientation",
        status: "running",
        objective: String(body.objective ?? "").slice(0, 2000),
        facultyPlan: JSON.stringify(composition.map((c) => c.positionKey)),
        cognitiveSessionId: body.cognitiveSessionId ?? null,
        councilRunId: body.councilRunId ?? null,
        projectId: body.projectId ?? null,
      })
      .returning();

    for (const c of composition) {
      await db.insert(collegeSessionFaculty).values({
        sessionId: session.id,
        positionKey: c.positionKey,
        reason: c.reason,
      });
    }

    await db.insert(collegeSessionEvents).values({
      sessionId: session.id,
      stage: session.stage,
      note: `Session opened. Faculty required: ${composition.map((c) => c.positionKey).join(", ")}.`,
      actor: "system",
    });

    return Response.json({ session, composition, stages: kind.stages }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "session create failed" }, { status: 500 });
  }
}

// PATCH → advance the lifecycle or close the session. Appends to the trail.
export async function PATCH(req: Request) {
  const _g = await guard(req, "run_session");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const id = String(body.id ?? "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const [existing] = await db
      .select()
      .from(collegeSessions)
      .where(eq(collegeSessions.id, id))
      .limit(1);
    if (!existing) return Response.json({ error: "not found" }, { status: 404 });
    if (existing.filedAt) {
      return Response.json(
        { error: "session is filed; filed sessions are immutable — issue a correction record instead" },
        { status: 400 }
      );
    }

    const stage = body.stage ? String(body.stage) : existing.stage;
    const status = body.status ? String(body.status) : existing.status;

    const [updated] = await db
      .update(collegeSessions)
      .set({
        stage,
        status,
        summary: body.summary !== undefined ? String(body.summary).slice(0, 8000) : existing.summary,
        objective:
          body.objective !== undefined ? String(body.objective).slice(0, 2000) : existing.objective,
        updatedAt: new Date(),
      })
      .where(eq(collegeSessions.id, id))
      .returning();

    await db.insert(collegeSessionEvents).values({
      sessionId: id,
      stage,
      note: String(body.note ?? `Stage → ${stage}`).slice(0, 1000),
      actor: String(body.actor ?? "system").slice(0, 60),
    });

    return Response.json({ session: updated });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "session update failed" }, { status: 500 });
  }
}
