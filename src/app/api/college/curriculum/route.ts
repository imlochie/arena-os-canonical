import { db } from "@/db";
import {
  collegeCourseWeeks,
  collegeCourses,
  collegeCurriculumChanges,
  collegeCurriculumEntries,
  collegeCurriculumVersions,
} from "@/db/college";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  addCourseToCurriculum,
  createVersion,
  ensureInitialVersion,
  getActiveVersion,
  getCurrentCurriculum,
  getCurriculumHealth,
  logChange,
  removeCourseFromCurriculum,
  snapshotCourse,
} from "@/lib/college/curriculum";
import { detectTimetableConflicts } from "@/lib/college/timetable";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

// GET → current curriculum, all known courses, health, versions, change log.
// "Known" and "active" are deliberately separate lists.
export async function GET(req: Request) {
  const _g = await guard(req, "read_state");
  if (!_g.ok) return refuse(_g);

  try {
    const current = await getCurrentCurriculum();
    const health = await getCurriculumHealth();
    const allCourses = await db.select().from(collegeCourses).orderBy(asc(collegeCourses.code));
    const versions = await db
      .select()
      .from(collegeCurriculumVersions)
      .orderBy(desc(collegeCurriculumVersions.versionNumber))
      .limit(25);
    const changes = await db
      .select()
      .from(collegeCurriculumChanges)
      .orderBy(desc(collegeCurriculumChanges.createdAt))
      .limit(40);
    const activeIds = new Set(current.courses.map((c) => String(c.id)));
    return Response.json({
      version: current.version,
      activeCourses: current.courses,
      availableCourses: allCourses.filter((c) => !activeIds.has(c.id)),
      allCourses,
      health: health.conditions,
      versions,
      changes,
      note: "A course being known to the College does not mean it is in the active curriculum. Membership is an explicit choice.",
    });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "curriculum read failed" }, { status: 500 });
  }
}

// POST → curriculum actions. Every mutation is an explicit institutional act.
export async function POST(req: Request) {
  const _g = await guard(req, "edit_curriculum");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const action = String(body.action ?? "");

    if (action === "init") {
      const v = await ensureInitialVersion(body.termId ?? null);
      return Response.json({ version: v }, { status: 201 });
    }

    if (action === "new_version") {
      const reason = String(body.reason ?? "").trim();
      if (!reason) {
        return Response.json(
          { error: "reason required — a curriculum version is an institutional decision" },
          { status: 400 }
        );
      }
      const v = await createVersion({
        reason,
        label: body.label,
        initiatedBy: body.initiatedBy,
        termId: body.termId ?? null,
      });
      return Response.json({ version: v }, { status: 201 });
    }

    if (action === "add_course") {
      const reason = String(body.reason ?? "").trim();
      if (!reason) return Response.json({ error: "reason required" }, { status: 400 });
      const r = await addCourseToCurriculum({
        courseId: String(body.courseId),
        reason,
        initiatedBy: body.initiatedBy,
      });
      if (!r.ok) return Response.json({ error: r.error }, { status: 400 });
      return Response.json(r, { status: 201 });
    }

    if (action === "remove_course") {
      const reason = String(body.reason ?? "").trim();
      if (!reason) return Response.json({ error: "reason required" }, { status: 400 });
      const r = await removeCourseFromCurriculum({
        courseId: String(body.courseId),
        reason,
        newStatus: body.newStatus,
        initiatedBy: body.initiatedBy,
      });
      if (!r.ok) return Response.json({ error: r.error }, { status: 400 });
      return Response.json(r);
    }

    if (action === "create_course") {
      const code = String(body.code ?? "").trim();
      const title = String(body.title ?? "").trim();
      if (!code || !title) {
        return Response.json({ error: "code and title required" }, { status: 400 });
      }
      const [course] = await db
        .insert(collegeCourses)
        .values({
          code: code.slice(0, 20),
          title: title.slice(0, 200),
          summary: String(body.summary ?? "").slice(0, 4000),
          schoolKey: String(body.schoolKey ?? "").slice(0, 60),
          level: Number(body.level ?? 100),
          courseType: String(body.courseType ?? "core").slice(0, 40),
          // New courses start as drafts. Entering the curriculum is separate.
          status: String(body.status ?? "draft").slice(0, 40),
          sourceKey: String(body.sourceKey ?? "founder").slice(0, 80),
          notes: String(body.notes ?? "").slice(0, 2000),
        })
        .returning();
      await logChange({
        courseId: course.id,
        changeType: "course_created",
        significance: "institutional_decision",
        newValue: `${course.code} — ${course.title}`,
        reason: String(body.reason ?? "New course created."),
        initiatedBy: body.initiatedBy,
      });
      return Response.json({ course }, { status: 201 });
    }

    // ---- LAYER 5: archive / reactivate / reorder / adopt a version --------
    if (action === "set_course_status") {
      const courseId = String(body.courseId ?? "");
      const status = String(body.status ?? "");
      const reason = String(body.reason ?? "").trim();
      if (!courseId || !status) {
        return Response.json({ error: "courseId and status required" }, { status: 400 });
      }
      if (!reason) {
        return Response.json(
          { error: "reason required — a course status change is a curriculum decision" },
          { status: 400 }
        );
      }
      const [before] = await db
        .select()
        .from(collegeCourses)
        .where(eq(collegeCourses.id, courseId))
        .limit(1);
      if (!before) return Response.json({ error: "course not found" }, { status: 404 });

      // Snapshot BEFORE the change so historical sessions keep what existed.
      await snapshotCourse(courseId, null, reason);
      const [row] = await db
        .update(collegeCourses)
        .set({ status })
        .where(eq(collegeCourses.id, courseId))
        .returning();

      await logChange({
        courseId,
        changeType: status === "archived" ? "course_archived" : "course_status_changed",
        significance: "institutional_decision",
        field: "status",
        previousValue: before.status,
        newValue: status,
        reason,
        initiatedBy: body.initiatedBy ?? "founder",
      });

      // Surface, never repair: a timetable slot still pointing here is a
      // conflict for the founder to resolve, not something to silently delete.
      //
      // Note the filter on course STATUS. Curriculum membership and course
      // status are different things — a course can still be listed in the
      // active version while being archived, and it is precisely that gap the
      // founder needs to see.
      const current = await getCurrentCurriculum();
      const stillActive = current.courses
        .filter((c) => String((c as { status?: string }).status ?? "active") === "active")
        .map((c) => String((c as { id: string }).id));
      const conflicts = await detectTimetableConflicts(stillActive);

      return Response.json({
        course: row,
        timetableConflicts: conflicts,
        note:
          status === "archived"
            ? "Course archived. Past sessions keep the course as it existed then. Any timetable slot still referencing it is reported above, not deleted."
            : "Course status updated.",
      });
    }

    if (action === "reorder") {
      const order: string[] = Array.isArray(body.order) ? body.order.map(String) : [];
      const reason = String(body.reason ?? "").trim();
      if (!order.length) return Response.json({ error: "order required" }, { status: 400 });
      if (!reason) return Response.json({ error: "reason required" }, { status: 400 });

      const version = await getActiveVersion();
      if (!version) return Response.json({ error: "no active curriculum version" }, { status: 400 });

      for (let i = 0; i < order.length; i++) {
        await db
          .update(collegeCurriculumEntries)
          .set({ position: i + 1 })
          .where(
            and(
              eq(collegeCurriculumEntries.versionId, version.id),
              eq(collegeCurriculumEntries.courseId, order[i])
            )
          );
      }
      await logChange({
        courseId: null,
        changeType: "curriculum_reordered",
        significance: "metadata_edit",
        field: "sequence",
        previousValue: "",
        newValue: order.join(","),
        reason,
        initiatedBy: body.initiatedBy ?? "founder",
      });
      return Response.json({ ok: true, order, note: "Order updated for the active version." });
    }

    if (action === "adopt_version") {
      const versionId = String(body.versionId ?? "");
      const reason = String(body.reason ?? "").trim();
      if (!versionId || !reason) {
        return Response.json({ error: "versionId and reason required" }, { status: 400 });
      }
      await db
        .update(collegeCurriculumVersions)
        .set({ status: "superseded" })
        .where(eq(collegeCurriculumVersions.status, "active"));
      const [row] = await db
        .update(collegeCurriculumVersions)
        .set({ status: "active" })
        .where(eq(collegeCurriculumVersions.id, versionId))
        .returning();
      if (!row) return Response.json({ error: "version not found" }, { status: 404 });

      return Response.json({
        version: row,
        note: "Adopted as the current curriculum. Previous versions are superseded, not deleted — historical sessions remain pinned to the version that applied when they ran.",
      });
    }

    if (action === "duplicate_course") {
      const [src] = await db
        .select()
        .from(collegeCourses)
        .where(eq(collegeCourses.id, String(body.courseId)))
        .limit(1);
      if (!src) return Response.json({ error: "source course not found" }, { status: 404 });
      const [course] = await db
        .insert(collegeCourses)
        .values({
          code: String(body.code ?? `${src.code}-COPY`).slice(0, 20),
          title: String(body.title ?? `${src.title} (copy)`).slice(0, 200),
          summary: src.summary,
          schoolKey: src.schoolKey,
          level: src.level,
          courseType: src.courseType,
          status: "draft",
          primaryCapabilities: src.primaryCapabilities,
          secondaryCapabilities: src.secondaryCapabilities,
          sourceKey: "duplicated",
          notes: `Duplicated from ${src.code}.`,
        })
        .returning();
      const weeks = await db
        .select()
        .from(collegeCourseWeeks)
        .where(eq(collegeCourseWeeks.courseId, src.id));
      for (const w of weeks) {
        await db.insert(collegeCourseWeeks).values({
          courseId: course.id,
          weekIndex: w.weekIndex,
          objective: w.objective,
          questionOfWeek: w.questionOfWeek,
          sourceKey: "duplicated",
        });
      }
      return Response.json({ course }, { status: 201 });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "curriculum action failed" }, { status: 500 });
  }
}

// PATCH → edit a course or its weekly structure.
// Snapshots first, so history keeps what the course meant before the edit.
export async function PATCH(req: Request) {
  const _g = await guard(req, "edit_curriculum");
  if (!_g.ok) return refuse(_g);

  try {
    const body = await req.json();
    const courseId = String(body.courseId ?? "");
    if (!courseId) return Response.json({ error: "courseId required" }, { status: 400 });
    const [existing] = await db
      .select()
      .from(collegeCourses)
      .where(eq(collegeCourses.id, courseId))
      .limit(1);
    if (!existing) return Response.json({ error: "course not found" }, { status: 404 });

    await snapshotCourse(courseId, null, String(body.reason ?? "course edited"));

    if (body.week !== undefined) {
      const weekIndex = Number(body.week.weekIndex);
      const [wk] = await db
        .select()
        .from(collegeCourseWeeks)
        .where(eq(collegeCourseWeeks.courseId, courseId));
      const rows = await db
        .select()
        .from(collegeCourseWeeks)
        .where(eq(collegeCourseWeeks.courseId, courseId));
      const match = rows.find((r) => r.weekIndex === weekIndex);
      if (match) {
        await db
          .update(collegeCourseWeeks)
          .set({
            objective: String(body.week.objective ?? match.objective).slice(0, 4000),
            questionOfWeek: String(body.week.questionOfWeek ?? match.questionOfWeek).slice(0, 1000),
          })
          .where(eq(collegeCourseWeeks.id, match.id));
        await logChange({
          courseId,
          changeType: "week_edited",
          significance: body.significance ?? "metadata_edit",
          field: `week ${weekIndex}`,
          previousValue: match.objective,
          newValue: String(body.week.objective ?? ""),
          reason: String(body.reason ?? ""),
          initiatedBy: body.initiatedBy,
        });
      } else {
        await db.insert(collegeCourseWeeks).values({
          courseId,
          weekIndex,
          objective: String(body.week.objective ?? "").slice(0, 4000),
          questionOfWeek: String(body.week.questionOfWeek ?? "").slice(0, 1000),
          sourceKey: "founder",
        });
        await logChange({
          courseId,
          changeType: "week_added",
          significance: body.significance ?? "metadata_edit",
          field: `week ${weekIndex}`,
          newValue: String(body.week.objective ?? ""),
          reason: String(body.reason ?? ""),
          initiatedBy: body.initiatedBy,
        });
      }
      const weeks = await db
        .select()
        .from(collegeCourseWeeks)
        .where(eq(collegeCourseWeeks.courseId, courseId))
        .orderBy(asc(collegeCourseWeeks.weekIndex));
      return Response.json({ weeks });
    }

    const fields: Record<string, string> = {};
    for (const f of ["title", "summary", "status", "schoolKey", "courseType", "notes"]) {
      if (body[f] !== undefined) fields[f] = String(body[f]);
    }
    if (!Object.keys(fields).length) {
      return Response.json({ error: "nothing to update" }, { status: 400 });
    }
    const [updated] = await db
      .update(collegeCourses)
      .set(fields)
      .where(eq(collegeCourses.id, courseId))
      .returning();

    for (const [k, v] of Object.entries(fields)) {
      await logChange({
        courseId,
        changeType: k === "status" ? "status_changed" : "course_edited",
        significance:
          k === "status" ? "institutional_decision" : (body.significance ?? "metadata_edit"),
        field: k,
        previousValue: String((existing as unknown as Record<string, unknown>)[k] ?? ""),
        newValue: v,
        reason: String(body.reason ?? ""),
        initiatedBy: body.initiatedBy,
      });
    }
    return Response.json({ course: updated });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "course update failed" }, { status: 500 });
  }
}
