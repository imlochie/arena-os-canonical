// ============================================================================
// Lochie Life College — Curriculum Management (SERVER ONLY)
// ============================================================================
// The handbook defines the institutional FRAMEWORK.
// The current curriculum is LIVING INSTITUTIONAL STATE owned by the founder.
//
// Hard rules:
//   • A course existing (in Notion or in college_courses) does NOT mean it is
//     in the active curriculum. Membership is an explicit, recorded choice.
//   • Changing the curriculum never rewrites history. Sessions pin the
//     curriculum version and course snapshot that existed at the time.
//   • Courses with historical sessions are never deleted — only archived,
//     paused or retired.
//   • Arena may propose. Only the founder decides.
// ============================================================================

import { db } from "@/db";
import {
  collegeCourseSnapshots,
  collegeCourseWeeks,
  collegeCourses,
  collegeCurriculumChanges,
  collegeCurriculumEntries,
  collegeCurriculumVersions,
  collegeSessions,
  collegeTimetableSlots,
} from "@/db/college";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { brisbaneToday } from "./time";

/** Explicit, auditable course lifecycle. Not every course uses every state. */
export const COURSE_LIFECYCLE = [
  "proposed",
  "draft",
  "approved",
  "active",
  "paused",
  "completed",
  "archived",
  "retired",
  // legacy value from Layer 1 bootstrap, retained so existing rows stay valid
  "blueprint",
] as const;

export type CourseStatus = (typeof COURSE_LIFECYCLE)[number];

/** Statuses that mean "currently being taught or teachable". */
export const LIVE_STATUSES: string[] = ["active", "approved", "delivering"];

export async function getActiveVersion() {
  const [v] = await db
    .select()
    .from(collegeCurriculumVersions)
    .where(eq(collegeCurriculumVersions.status, "active"))
    .orderBy(desc(collegeCurriculumVersions.versionNumber))
    .limit(1);
  return v ?? null;
}

/**
 * Ensure a curriculum version exists. The first version is created EMPTY:
 * the College must not infer curriculum membership from the mere existence of
 * a course record.
 */
export async function ensureInitialVersion(termId?: string | null) {
  const existing = await getActiveVersion();
  if (existing) return existing;
  const [v] = await db
    .insert(collegeCurriculumVersions)
    .values({
      termId: termId ?? null,
      versionNumber: 1,
      label: "Initial curriculum",
      status: "active",
      reason:
        "Created empty. Course membership is an explicit institutional choice, never inferred from the existence of a course record or a Notion page.",
      initiatedBy: "system",
      effectiveFrom: brisbaneToday(),
    })
    .returning();
  return v;
}

/**
 * Create a new curriculum version by copying the current membership.
 * The previous version is preserved and marked superseded — historical
 * sessions continue to reference it.
 */
export async function createVersion(input: {
  reason: string;
  label?: string;
  initiatedBy?: string;
  termId?: string | null;
}) {
  const current = await getActiveVersion();
  const nextNumber = (current?.versionNumber ?? 0) + 1;

  const [v] = await db
    .insert(collegeCurriculumVersions)
    .values({
      termId: input.termId ?? current?.termId ?? null,
      versionNumber: nextNumber,
      label: input.label ?? `Curriculum Version ${String(nextNumber).padStart(2, "0")}`,
      status: "active",
      reason: input.reason.slice(0, 2000),
      initiatedBy: input.initiatedBy ?? "founder",
      effectiveFrom: brisbaneToday(),
      supersedesId: current?.id ?? null,
    })
    .returning();

  if (current) {
    // Copy membership forward so a version change is not a silent wipe.
    const entries = await db
      .select()
      .from(collegeCurriculumEntries)
      .where(eq(collegeCurriculumEntries.versionId, current.id));
    for (const e of entries) {
      await db.insert(collegeCurriculumEntries).values({
        versionId: v.id,
        courseId: e.courseId,
        position: e.position,
        entryStatus: e.entryStatus,
        note: e.note,
      });
    }
    await db
      .update(collegeCurriculumVersions)
      .set({ status: "superseded" })
      .where(eq(collegeCurriculumVersions.id, current.id));
  }
  return v;
}

/** Capture what a course MEANS right now, so history can point at it. */
export async function snapshotCourse(courseId: string, versionId: string | null, reason: string) {
  const [c] = await db.select().from(collegeCourses).where(eq(collegeCourses.id, courseId)).limit(1);
  if (!c) return null;
  const weeks = await db
    .select()
    .from(collegeCourseWeeks)
    .where(eq(collegeCourseWeeks.courseId, courseId))
    .orderBy(asc(collegeCourseWeeks.weekIndex));
  const [snap] = await db
    .insert(collegeCourseSnapshots)
    .values({
      courseId,
      versionId,
      code: c.code,
      title: c.title,
      summary: c.summary,
      status: c.status,
      weeklyStructure: JSON.stringify(
        weeks.map((w) => ({
          weekIndex: w.weekIndex,
          objective: w.objective,
          questionOfWeek: w.questionOfWeek,
        }))
      ),
      reason: reason.slice(0, 500),
    })
    .returning();
  return snap;
}

export async function logChange(input: {
  versionId?: string | null;
  courseId?: string | null;
  changeType: string;
  significance?: "metadata_edit" | "institutional_decision";
  field?: string;
  previousValue?: string;
  newValue?: string;
  reason?: string;
  initiatedBy?: string;
}) {
  const [row] = await db
    .insert(collegeCurriculumChanges)
    .values({
      versionId: input.versionId ?? null,
      courseId: input.courseId ?? null,
      changeType: input.changeType.slice(0, 40),
      significance: input.significance ?? "metadata_edit",
      field: (input.field ?? "").slice(0, 80),
      previousValue: (input.previousValue ?? "").slice(0, 4000),
      newValue: (input.newValue ?? "").slice(0, 4000),
      reason: (input.reason ?? "").slice(0, 2000),
      initiatedBy: input.initiatedBy ?? "founder",
      effectiveDate: brisbaneToday(),
    })
    .returning();
  return row;
}

/** Add a course to the ACTIVE curriculum — an explicit institutional choice. */
export async function addCourseToCurriculum(input: {
  courseId: string;
  reason: string;
  initiatedBy?: string;
  position?: number;
}) {
  const version = (await getActiveVersion()) ?? (await ensureInitialVersion());
  const existing = await db
    .select()
    .from(collegeCurriculumEntries)
    .where(
      and(
        eq(collegeCurriculumEntries.versionId, version.id),
        eq(collegeCurriculumEntries.courseId, input.courseId)
      )
    )
    .limit(1);
  if (existing.length) {
    return { ok: false as const, error: "course is already in the active curriculum" };
  }
  const [course] = await db
    .select()
    .from(collegeCourses)
    .where(eq(collegeCourses.id, input.courseId))
    .limit(1);
  if (!course) return { ok: false as const, error: "course not found" };

  const count = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(collegeCurriculumEntries)
    .where(eq(collegeCurriculumEntries.versionId, version.id));

  const [entry] = await db
    .insert(collegeCurriculumEntries)
    .values({
      versionId: version.id,
      courseId: input.courseId,
      position: input.position ?? count[0]?.n ?? 0,
      entryStatus: "active",
      note: input.reason.slice(0, 500),
    })
    .returning();

  await logChange({
    versionId: version.id,
    courseId: input.courseId,
    changeType: "course_added",
    significance: "institutional_decision",
    newValue: `${course.code} — ${course.title}`,
    reason: input.reason,
    initiatedBy: input.initiatedBy,
  });
  return { ok: true as const, entry, version };
}

/**
 * Remove a course from the ACTIVE curriculum.
 * The course object is never deleted; historical sessions remain attached.
 */
export async function removeCourseFromCurriculum(input: {
  courseId: string;
  reason: string;
  newStatus?: "paused" | "archived" | "retired" | "completed";
  initiatedBy?: string;
}) {
  const version = await getActiveVersion();
  if (!version) return { ok: false as const, error: "no active curriculum version" };

  const [course] = await db
    .select()
    .from(collegeCourses)
    .where(eq(collegeCourses.id, input.courseId))
    .limit(1);
  if (!course) return { ok: false as const, error: "course not found" };

  // Preserve what the course meant before it left the curriculum.
  await snapshotCourse(input.courseId, version.id, "removed from active curriculum");

  await db
    .delete(collegeCurriculumEntries)
    .where(
      and(
        eq(collegeCurriculumEntries.versionId, version.id),
        eq(collegeCurriculumEntries.courseId, input.courseId)
      )
    );

  const newStatus = input.newStatus ?? "archived";
  await db
    .update(collegeCourses)
    .set({ status: newStatus })
    .where(eq(collegeCourses.id, input.courseId));

  await logChange({
    versionId: version.id,
    courseId: input.courseId,
    changeType: "course_removed",
    significance: "institutional_decision",
    field: "status",
    previousValue: course.status,
    newValue: newStatus,
    reason: input.reason,
    initiatedBy: input.initiatedBy,
  });

  const sessionCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(collegeSessions)
    .where(eq(collegeSessions.courseId, input.courseId));

  return {
    ok: true as const,
    course: { ...course, status: newStatus },
    historicalSessions: sessionCount[0]?.n ?? 0,
    note: "Course removed from the active curriculum but preserved. Historical sessions remain attached and still reference the curriculum context that existed at the time.",
  };
}

/** The current curriculum: active version + its member courses, in order. */
export async function getCurrentCurriculum() {
  const version = await getActiveVersion();
  if (!version) {
    return { version: null, courses: [], entries: [] };
  }
  const entries = await db
    .select()
    .from(collegeCurriculumEntries)
    .where(eq(collegeCurriculumEntries.versionId, version.id))
    .orderBy(asc(collegeCurriculumEntries.position));
  if (!entries.length) return { version, courses: [], entries };

  const ids = entries.map((e) => e.courseId);
  const courses = await db.select().from(collegeCourses).where(inArray(collegeCourses.id, ids));
  const byId = new Map(courses.map((c) => [c.id, c]));
  const ordered = entries
    .map((e) => {
      const c = byId.get(e.courseId);
      return c ? { ...c, entryStatus: e.entryStatus, position: e.position, entryId: e.id } : null;
    })
    .filter(Boolean);
  return { version, courses: ordered as Array<Record<string, unknown>>, entries };
}

/**
 * Curriculum health: surface ACTUAL conditions, never a numeric score.
 */
export async function getCurriculumHealth() {
  const { version, courses } = await getCurrentCurriculum();
  const conditions: Array<{ condition: string; detail: string; severity: string }> = [];

  if (!version) {
    return {
      conditions: [
        {
          condition: "No curriculum version",
          detail: "The College has no active curriculum. Nothing is currently being taught.",
          severity: "high",
        },
      ],
      activeCourseCount: 0,
    };
  }

  const slots = await db
    .select()
    .from(collegeTimetableSlots)
    .where(eq(collegeTimetableSlots.active, true));
  const slotCourseIds = new Set(slots.map((s) => s.courseId).filter(Boolean));

  for (const c of courses) {
    const id = String(c.id);
    const code = String(c.code);

    const weeks = await db
      .select()
      .from(collegeCourseWeeks)
      .where(eq(collegeCourseWeeks.courseId, id));
    if (!weeks.length) {
      conditions.push({
        condition: "Course has no weekly structure",
        detail: `${code} is in the active curriculum but has no weekly objectives.`,
        severity: "medium",
      });
    } else if (weeks.every((w) => !w.objective.trim())) {
      conditions.push({
        condition: "Course has no objectives",
        detail: `${code} has weeks defined but every objective is empty.`,
        severity: "medium",
      });
    }

    if (!slotCourseIds.has(id)) {
      conditions.push({
        condition: "Active course with no timetable placement",
        detail: `${code} is in the curriculum but appears nowhere on the timetable.`,
        severity: "medium",
      });
    }

    const taught = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(collegeSessions)
      .where(eq(collegeSessions.courseId, id));
    if ((taught[0]?.n ?? 0) === 0) {
      conditions.push({
        condition: "Course never taught",
        detail: `${code} is active but has no recorded sessions.`,
        severity: "low",
      });
    }
  }

  // Timetable entries pointing at courses outside the active curriculum.
  const activeIds = new Set(courses.map((c) => String(c.id)));
  for (const s of slots) {
    if (s.courseId && !activeIds.has(s.courseId)) {
      conditions.push({
        condition: "Timetable entry without an active curriculum course",
        detail: `Slot "${s.label}" references a course that is not in the active curriculum.`,
        severity: "high",
      });
    }
  }

  return { conditions, activeCourseCount: courses.length };
}
