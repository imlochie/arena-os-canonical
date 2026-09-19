import { db } from "@/db";
import { collegeTimetableTemplateSlots } from "@/db/college";
import { eq } from "drizzle-orm";
import {
  ACTIVITY_TYPES,
  EXCEPTION_TYPES,
  RUNTIME_STATUSES,
  SLOT_BEHAVIOURS,
  createOverride,
  createTimetableVersion,
  detectTimetableConflicts,
  getActiveTimetableVersion,
  getDayThemes,
  getPeriods,
  livePosition,
  resolveDay,
  setInstanceStatus,
} from "@/lib/college/timetable";
import { importReferenceTimetable, timetableConfigured } from "@/lib/college/timetable-import";
import { getCurrentCurriculum } from "@/lib/college/curriculum";
import { addDays, brisbaneToday } from "@/lib/college/time";

export const dynamic = "force-dynamic";

// GET → the live timetable.
//   (default)        today's position: current / next / later
//   ?view=week       the full weekly grid
//   ?date=YYYY-MM-DD a specific day
//   ?view=conflicts  curriculum ↔ timetable mismatches
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const view = url.searchParams.get("view") ?? "day";
    const version = await getActiveTimetableVersion();

    if (view === "conflicts") {
      const curriculum = await getCurrentCurriculum();
      // Curriculum membership is not the same as course status. A course that
      // is still a member of the active version but has been archived must
      // count as NOT active, otherwise an orphaned slot goes unreported.
      const activeIds = curriculum.courses
        .filter((c) => String((c as { status?: string }).status ?? "active") === "active")
        .map((c) => String((c as { id: string }).id));
      const conflicts = await detectTimetableConflicts(activeIds);
      return Response.json({
        conflicts,
        note: "Mismatches are surfaced, never auto-repaired. Removing a course from the curriculum does not delete its timetable placement.",
      });
    }

    if (view === "week") {
      const anchor = url.searchParams.get("date") ?? brisbaneToday();
      // Walk back to Monday.
      const [y, m, d] = anchor.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      const js = dt.getUTCDay();
      const dow = js === 0 ? 7 : js;
      const monday = addDays(anchor, -(dow - 1));

      const days = [];
      for (let i = 0; i < 7; i++) {
        days.push(await resolveDay(addDays(monday, i)));
      }
      const [periods, themes] = version
        ? await Promise.all([getPeriods(version.id), getDayThemes(version.id)])
        : [[], []];

      return Response.json({
        weekStart: monday,
        days,
        periods,
        themes,
        version: version ? { id: version.id, label: version.label, number: version.versionNumber } : null,
        configured: await timetableConfigured(),
      });
    }

    const date = url.searchParams.get("date") ?? undefined;
    const [live, day] = await Promise.all([
      livePosition(date),
      resolveDay(date ?? brisbaneToday()),
    ]);
    const periods = version ? await getPeriods(version.id) : [];

    return Response.json({
      live,
      day,
      periods,
      version: version ? { id: version.id, label: version.label, number: version.versionNumber } : null,
      configured: await timetableConfigured(),
      vocabulary: {
        activityTypes: ACTIVITY_TYPES,
        slotBehaviours: SLOT_BEHAVIOURS,
        exceptionTypes: EXCEPTION_TYPES,
        runtimeStatuses: RUNTIME_STATUSES,
      },
      note: "The timetable states what SHOULD be happening. Whether it happened comes from session evidence, never from the clock passing.",
    });
  } catch (e) {
    console.error("timetable read error", e);
    return Response.json(
      { error: "timetable read failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// POST → import | new_version | slot | override | status
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body.action ?? "");
    const reason = String(body.reason ?? "").trim();

    if (action === "import_reference") {
      if (!reason) {
        return Response.json(
          { error: "reason required — importing creates a new timetable version" },
          { status: 400 }
        );
      }
      const result = await importReferenceTimetable({
        label: body.label ? String(body.label) : undefined,
        reason,
      });
      return Response.json(result, { status: 201 });
    }

    if (action === "new_version") {
      if (!reason) {
        return Response.json(
          { error: "reason required — a timetable version is an institutional decision" },
          { status: 400 }
        );
      }
      const version = await createTimetableVersion({
        label: String(body.label ?? "New timetable version"),
        reason,
      });
      return Response.json(
        {
          version,
          note: "Structure carried forward. Historical instances remain associated with the previous version.",
        },
        { status: 201 }
      );
    }

    if (action === "override") {
      const result = await createOverride({
        slotId: body.slotId ? String(body.slotId) : null,
        date: String(body.date ?? brisbaneToday()),
        exceptionType: String(body.exceptionType ?? "cancelled"),
        newStartTime: body.newStartTime ? String(body.newStartTime) : undefined,
        newEndTime: body.newEndTime ? String(body.newEndTime) : undefined,
        newTitle: body.newTitle ? String(body.newTitle) : undefined,
        newCourseId: body.newCourseId ? String(body.newCourseId) : null,
        reason,
        provenance: body.provenance ? String(body.provenance) : "founder",
      });
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
      return Response.json(
        {
          override: result.override,
          note: "Date-specific override recorded. The recurring timetable is unchanged and resumes automatically.",
        },
        { status: 201 }
      );
    }

    if (action === "status") {
      const result = await setInstanceStatus({
        slotId: String(body.slotId ?? ""),
        date: String(body.date ?? brisbaneToday()),
        status: String(body.status ?? ""),
        evidence: String(body.evidence ?? ""),
        sessionId: body.sessionId ? String(body.sessionId) : null,
      });
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
      return Response.json({ instance: result.instance });
    }

    if (action === "slot") {
      const version = await getActiveTimetableVersion();
      if (!version) return Response.json({ error: "no active timetable version" }, { status: 400 });
      if (!reason) return Response.json({ error: "reason required" }, { status: 400 });
      const [row] = await db
        .insert(collegeTimetableTemplateSlots)
        .values({
          versionId: version.id,
          periodId: body.periodId ? String(body.periodId) : null,
          dayOfWeek: Number(body.dayOfWeek ?? 1),
          startTime: String(body.startTime ?? ""),
          endTime: String(body.endTime ?? ""),
          sequence: Number(body.sequence ?? 0),
          title: String(body.title ?? "Untitled slot"),
          description: String(body.description ?? ""),
          slotBehaviour: String(body.slotBehaviour ?? "scheduled"),
          activityType: String(body.activityType ?? "routine"),
          courseId: body.courseId ? String(body.courseId) : null,
          sessionKind: String(body.sessionKind ?? ""),
          generatesSession: body.generatesSession === true,
          icon: String(body.icon ?? ""),
          items: JSON.stringify(body.items ?? []),
          notes: reason,
        })
        .returning();
      return Response.json({ slot: row }, { status: 201 });
    }

    return Response.json({ error: `unknown action "${action}"` }, { status: 400 });
  } catch (e) {
    console.error("timetable write error", e);
    return Response.json(
      { error: "timetable write failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

// PATCH → edit a template slot (the recurring default, not one date).
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const id = String(body.id ?? "");
    const reason = String(body.reason ?? "").trim();
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    if (!reason) {
      return Response.json(
        {
          error:
            "reason required — editing the template changes every future occurrence. To change one date only, create an override instead.",
        },
        { status: 400 }
      );
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of [
      "title",
      "description",
      "startTime",
      "endTime",
      "slotBehaviour",
      "activityType",
      "sessionKind",
      "icon",
      "configurationNote",
    ]) {
      if (body[k] !== undefined) patch[k] = String(body[k]);
    }
    if (body.dayOfWeek !== undefined) patch.dayOfWeek = Number(body.dayOfWeek);
    if (body.courseId !== undefined) patch.courseId = body.courseId ? String(body.courseId) : null;
    if (body.generatesSession !== undefined) patch.generatesSession = body.generatesSession === true;
    if (body.items !== undefined) patch.items = JSON.stringify(body.items);
    if (body.needsConfiguration !== undefined) {
      patch.needsConfiguration = body.needsConfiguration === true;
    }
    if (body.active !== undefined) patch.active = body.active === true;

    const [row] = await db
      .update(collegeTimetableTemplateSlots)
      .set(patch)
      .where(eq(collegeTimetableTemplateSlots.id, id))
      .returning();
    if (!row) return Response.json({ error: "slot not found" }, { status: 404 });

    return Response.json({
      slot: row,
      note: "Template updated. Past instances keep the timetable version that applied when they occurred.",
    });
  } catch (e) {
    console.error("timetable patch error", e);
    return Response.json(
      { error: "timetable patch failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
