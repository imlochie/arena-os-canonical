// ============================================================================
// Lochie Life College — Live timetable (SERVER ONLY)
// ============================================================================
//   TEMPLATE   the configured recurring structure ("every Thursday, 2:00")
//   OVERRIDE   a date-specific exception that NEVER mutates the template
//   INSTANCE   what is scheduled for one real date
//   SESSION    what actually happened there
//
// The timetable answers WHAT SHOULD BE HAPPENING. College State answers WHAT
// IS ACTUALLY HAPPENING. These must never silently overwrite one another.
//
// Runtime status is NOT inferred from the clock passing: a slot whose end time
// has passed is `unknown`, not `completed`. Completion requires evidence.
// ============================================================================

import { db } from "@/db";
import {
  collegeCourses,
  collegeDayThemes,
  collegeTimetableInstances,
  collegeTimetableOverrides,
  collegeTimetablePeriods,
  collegeTimetableTemplateSlots,
  collegeTimetableVersions,
} from "@/db/college";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { brisbaneNow, brisbaneToday } from "./time";

export const ACTIVITY_TYPES = [
  "academic",
  "creative",
  "administrative",
  "health",
  "relationship",
  "household",
  "adventure",
  "recovery",
  "entertainment",
  "routine",
] as const;

export const SLOT_BEHAVIOURS = ["fixed", "scheduled", "slotable"] as const;

export const EXCEPTION_TYPES = [
  "cancelled",
  "moved",
  "substituted",
  "extended",
  "shortened",
  "rescheduled",
  "special_session",
  "holiday",
  "personal_commitment",
  "unavailable",
  "unscheduled",
] as const;

export const RUNTIME_STATUSES = [
  "scheduled",
  "current",
  "in_progress",
  "completed",
  "missed",
  "cancelled",
  "deviated",
  "unknown",
] as const;

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function dayName(dow: number): string {
  return DAY_NAMES[dow] ?? "";
}

/** Minutes since midnight, or null when the time is not configured. */
export function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function fmtTime(hhmm: string): string {
  const mins = toMinutes(hhmm);
  if (mins === null) return hhmm || "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export async function getActiveTimetableVersion() {
  const [v] = await db
    .select()
    .from(collegeTimetableVersions)
    .where(eq(collegeTimetableVersions.status, "active"))
    .orderBy(desc(collegeTimetableVersions.versionNumber))
    .limit(1);
  return v ?? null;
}

export async function createTimetableVersion(input: {
  label: string;
  reason: string;
  termId?: string | null;
  copyFromId?: string | null;
}) {
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${collegeTimetableVersions.versionNumber}), 0)::int` })
    .from(collegeTimetableVersions);
  const next = Number(max) + 1;

  const current = await getActiveTimetableVersion();
  if (current) {
    await db
      .update(collegeTimetableVersions)
      .set({ status: "superseded", effectiveTo: brisbaneToday() })
      .where(eq(collegeTimetableVersions.id, current.id));
  }

  const [version] = await db
    .insert(collegeTimetableVersions)
    .values({
      termId: input.termId ?? null,
      versionNumber: next,
      label: input.label.slice(0, 200),
      status: "active",
      reason: input.reason.slice(0, 2000),
      effectiveFrom: brisbaneToday(),
      supersedesId: current?.id ?? null,
    })
    .returning();

  // Carry the structure forward so a new version is not an empty timetable.
  const source = input.copyFromId ?? current?.id ?? null;
  if (source) {
    const [periods, themes, slots] = await Promise.all([
      db.select().from(collegeTimetablePeriods).where(eq(collegeTimetablePeriods.versionId, source)),
      db.select().from(collegeDayThemes).where(eq(collegeDayThemes.versionId, source)),
      db
        .select()
        .from(collegeTimetableTemplateSlots)
        .where(eq(collegeTimetableTemplateSlots.versionId, source)),
    ]);

    const periodMap = new Map<string, string>();
    for (const p of periods) {
      const [np] = await db
        .insert(collegeTimetablePeriods)
        .values({ ...p, id: undefined, versionId: version.id, createdAt: undefined })
        .returning();
      periodMap.set(p.id, np.id);
    }
    for (const t of themes) {
      await db
        .insert(collegeDayThemes)
        .values({ ...t, id: undefined, versionId: version.id, createdAt: undefined });
    }
    for (const s of slots) {
      await db.insert(collegeTimetableTemplateSlots).values({
        ...s,
        id: undefined,
        versionId: version.id,
        periodId: s.periodId ? (periodMap.get(s.periodId) ?? null) : null,
        createdAt: undefined,
        updatedAt: undefined,
      });
    }
  }

  return version;
}

// ---------------------------------------------------------------------------
// Template reads
// ---------------------------------------------------------------------------

export async function getPeriods(versionId: string) {
  return db
    .select()
    .from(collegeTimetablePeriods)
    .where(eq(collegeTimetablePeriods.versionId, versionId))
    .orderBy(asc(collegeTimetablePeriods.sequence));
}

export async function getDayThemes(versionId: string) {
  return db
    .select()
    .from(collegeDayThemes)
    .where(eq(collegeDayThemes.versionId, versionId))
    .orderBy(asc(collegeDayThemes.dayOfWeek));
}

export async function getTemplateSlots(versionId: string, dayOfWeek?: number) {
  const where = dayOfWeek
    ? and(
        eq(collegeTimetableTemplateSlots.versionId, versionId),
        eq(collegeTimetableTemplateSlots.active, true),
        eq(collegeTimetableTemplateSlots.dayOfWeek, dayOfWeek)
      )
    : and(
        eq(collegeTimetableTemplateSlots.versionId, versionId),
        eq(collegeTimetableTemplateSlots.active, true)
      );
  return db
    .select()
    .from(collegeTimetableTemplateSlots)
    .where(where)
    .orderBy(
      asc(collegeTimetableTemplateSlots.dayOfWeek),
      asc(collegeTimetableTemplateSlots.sequence)
    );
}

// ---------------------------------------------------------------------------
// Resolution: template + overrides → what is scheduled for a date
// ---------------------------------------------------------------------------

export interface ResolvedSlot {
  slotId: string;
  periodId: string | null;
  periodKey: string;
  periodLabel: string;
  date: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  title: string;
  description: string;
  slotBehaviour: string;
  activityType: string;
  courseId: string | null;
  courseCode: string | null;
  sessionKind: string;
  generatesSession: boolean;
  informsCollegeState: boolean;
  icon: string;
  colorKey: string;
  items: string[];
  sequence: number;
  needsConfiguration: boolean;
  configurationNote: string;
  /** Present when a date-specific override applies. */
  override: {
    id: string;
    exceptionType: string;
    reason: string;
    provenance: string;
  } | null;
  runtimeStatus: string;
  statusEvidence: string;
  instanceId: string | null;
  sessionId: string | null;
}

function isoDow(dateIso: string): number {
  // Treat the ISO date as a plain calendar date (no timezone shifting).
  const [y, m, d] = dateIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const js = dt.getUTCDay(); // 0=Sun
  return js === 0 ? 7 : js;
}

/**
 * What is scheduled for one date: the recurring template, with any
 * date-specific overrides layered on top, plus recorded runtime state.
 */
export async function resolveDay(dateIso: string): Promise<{
  date: string;
  dayOfWeek: number;
  dayName: string;
  theme: string;
  versionId: string | null;
  versionLabel: string | null;
  slots: ResolvedSlot[];
}> {
  const version = await getActiveTimetableVersion();
  if (!version) {
    return {
      date: dateIso,
      dayOfWeek: isoDow(dateIso),
      dayName: dayName(isoDow(dateIso)),
      theme: "",
      versionId: null,
      versionLabel: null,
      slots: [],
    };
  }

  const dow = isoDow(dateIso);
  const [periods, themes, slots, overrides, instances, courses] = await Promise.all([
    getPeriods(version.id),
    getDayThemes(version.id),
    getTemplateSlots(version.id, dow),
    db.select().from(collegeTimetableOverrides).where(eq(collegeTimetableOverrides.date, dateIso)),
    db.select().from(collegeTimetableInstances).where(eq(collegeTimetableInstances.date, dateIso)),
    db.select().from(collegeCourses),
  ]);

  const periodById = new Map(periods.map((p) => [p.id, p]));
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const overrideBySlot = new Map(overrides.filter((o) => o.slotId).map((o) => [o.slotId!, o]));
  const instanceBySlot = new Map(instances.filter((i) => i.slotId).map((i) => [i.slotId!, i]));

  const resolved: ResolvedSlot[] = [];

  for (const s of slots) {
    // Respect the slot's own effective window.
    if (s.effectiveFrom && dateIso < s.effectiveFrom) continue;
    if (s.effectiveTo && dateIso > s.effectiveTo) continue;

    const ov = overrideBySlot.get(s.id) ?? null;
    const inst = instanceBySlot.get(s.id) ?? null;
    const period = s.periodId ? periodById.get(s.periodId) : undefined;

    // A cancellation removes it from the day but is still reported as such.
    const startTime = ov?.newStartTime || s.startTime;
    const endTime = ov?.newEndTime || s.endTime;
    const title = ov?.newTitle || s.title;
    const courseId = ov?.newCourseId ?? s.courseId;

    let items: string[] = [];
    try {
      items = JSON.parse(s.items || "[]");
    } catch {
      items = [];
    }

    resolved.push({
      slotId: s.id,
      periodId: s.periodId,
      periodKey: period?.key ?? "",
      periodLabel: period?.label ?? "",
      date: dateIso,
      dayOfWeek: dow,
      startTime,
      endTime,
      title,
      description: s.description,
      slotBehaviour: s.slotBehaviour,
      activityType: s.activityType,
      courseId,
      courseCode: courseId ? (courseById.get(courseId)?.code ?? null) : null,
      sessionKind: s.sessionKind,
      generatesSession: s.generatesSession,
      informsCollegeState: s.informsCollegeState,
      icon: s.icon,
      colorKey: s.colorKey,
      items,
      sequence: s.sequence,
      needsConfiguration: s.needsConfiguration,
      configurationNote: s.configurationNote,
      override: ov
        ? {
            id: ov.id,
            exceptionType: ov.exceptionType,
            reason: ov.reason,
            provenance: ov.provenance,
          }
        : null,
      runtimeStatus: inst?.runtimeStatus ?? (ov?.exceptionType === "cancelled" ? "cancelled" : "scheduled"),
      statusEvidence: inst?.statusEvidence ?? "",
      instanceId: inst?.id ?? null,
      sessionId: inst?.sessionId ?? null,
    });
  }

  // One-off additions: overrides with no slotId are special sessions.
  for (const o of overrides.filter((x) => !x.slotId)) {
    resolved.push({
      slotId: "",
      periodId: null,
      periodKey: "",
      periodLabel: "",
      date: dateIso,
      dayOfWeek: dow,
      startTime: o.newStartTime,
      endTime: o.newEndTime,
      title: o.newTitle || "Special session",
      description: o.reason,
      slotBehaviour: "scheduled",
      activityType: "academic",
      courseId: o.newCourseId,
      courseCode: o.newCourseId ? (courseById.get(o.newCourseId)?.code ?? null) : null,
      sessionKind: "lesson",
      generatesSession: true,
      informsCollegeState: true,
      icon: "✨",
      colorKey: "",
      items: [],
      sequence: 999,
      needsConfiguration: false,
      configurationNote: "",
      override: {
        id: o.id,
        exceptionType: o.exceptionType,
        reason: o.reason,
        provenance: o.provenance,
      },
      runtimeStatus: "scheduled",
      statusEvidence: "",
      instanceId: null,
      sessionId: null,
    });
  }

  resolved.sort((a, b) => {
    const am = toMinutes(a.startTime);
    const bm = toMinutes(b.startTime);
    if (am === null && bm === null) return a.sequence - b.sequence;
    if (am === null) return 1;
    if (bm === null) return -1;
    return am - bm || a.sequence - b.sequence;
  });

  return {
    date: dateIso,
    dayOfWeek: dow,
    dayName: dayName(dow),
    theme: themes.find((t) => t.dayOfWeek === dow)?.theme ?? "",
    versionId: version.id,
    versionLabel: version.label,
    slots: resolved,
  };
}

// ---------------------------------------------------------------------------
// The live clock
// ---------------------------------------------------------------------------

export interface LivePosition {
  date: string;
  time: string;
  dayName: string;
  theme: string;
  nowMinutes: number;
  current: ResolvedSlot | null;
  next: ResolvedSlot | null;
  previous: ResolvedSlot | null;
  later: ResolvedSlot[];
  completed: ResolvedSlot[];
  /** Overlapping slots the design itself contains — surfaced, not resolved. */
  concurrent: ResolvedSlot[];
  note: string;
}

/**
 * Where the College is right now, from the application clock — never from
 * conversational memory.
 */
export async function livePosition(atIso?: string): Promise<LivePosition> {
  const now = brisbaneNow();
  const date = atIso ?? now.isoDate;
  const day = await resolveDay(date);
  const nowMinutes = now.hour * 60 + now.minute;

  const timed = day.slots.filter(
    (s) => toMinutes(s.startTime) !== null && s.runtimeStatus !== "cancelled"
  );

  const active = timed.filter((s) => {
    const start = toMinutes(s.startTime)!;
    const end = toMinutes(s.endTime) ?? start + 60;
    return nowMinutes >= start && nowMinutes < end;
  });

  const past = timed.filter((s) => {
    const end = toMinutes(s.endTime) ?? (toMinutes(s.startTime)! + 60);
    return nowMinutes >= end;
  });

  const future = timed.filter((s) => toMinutes(s.startTime)! > nowMinutes);

  // The design genuinely contains overlapping periods (Garage Downtime and
  // Dinner). Report them all rather than inventing a precedence rule.
  const current = active[0] ?? null;
  const concurrent = active.slice(1);

  return {
    date,
    time: `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`,
    dayName: day.dayName,
    theme: day.theme,
    nowMinutes,
    current,
    next: future[0] ?? null,
    previous: past[past.length - 1] ?? null,
    later: future,
    completed: past,
    concurrent,
    note: concurrent.length
      ? "More than one slot is scheduled for this moment. The timetable design contains deliberate overlaps; the College reports both rather than choosing."
      : "",
  };
}

// ---------------------------------------------------------------------------
// Instances & runtime status
// ---------------------------------------------------------------------------

/**
 * Materialise an instance for a slot on a date. Instances are created lazily —
 * the recurring template is the source of truth, not hundreds of pre-made rows.
 */
export async function ensureInstance(slotId: string, dateIso: string) {
  const [existing] = await db
    .select()
    .from(collegeTimetableInstances)
    .where(
      and(
        eq(collegeTimetableInstances.slotId, slotId),
        eq(collegeTimetableInstances.date, dateIso)
      )
    )
    .limit(1);
  if (existing) return existing;

  const day = await resolveDay(dateIso);
  const slot = day.slots.find((s) => s.slotId === slotId);
  if (!slot) return null;

  const [row] = await db
    .insert(collegeTimetableInstances)
    .values({
      slotId,
      versionId: day.versionId,
      date: dateIso,
      startTime: slot.startTime,
      endTime: slot.endTime,
      title: slot.title,
      courseId: slot.courseId,
      overrideId: slot.override?.id ?? null,
      runtimeStatus: slot.override?.exceptionType === "cancelled" ? "cancelled" : "scheduled",
    })
    .returning();
  return row;
}

/**
 * Set runtime status. Completion REQUIRES evidence — the clock passing is not
 * evidence that something happened.
 */
export async function setInstanceStatus(input: {
  slotId: string;
  date: string;
  status: string;
  evidence: string;
  sessionId?: string | null;
}): Promise<{ ok: true; instance: typeof collegeTimetableInstances.$inferSelect } | { ok: false; error: string }> {
  if (!RUNTIME_STATUSES.includes(input.status as (typeof RUNTIME_STATUSES)[number])) {
    return { ok: false, error: `unknown runtime status "${input.status}"` };
  }
  const needsEvidence = ["completed", "missed", "deviated", "in_progress"];
  if (needsEvidence.includes(input.status) && !input.evidence.trim()) {
    return {
      ok: false,
      error: `"${input.status}" requires evidence. The clock passing the end time is not evidence that something happened.`,
    };
  }

  const inst = await ensureInstance(input.slotId, input.date);
  if (!inst) return { ok: false, error: "no such slot on that date" };

  const [row] = await db
    .update(collegeTimetableInstances)
    .set({
      runtimeStatus: input.status,
      statusEvidence: input.evidence.slice(0, 2000),
      sessionId: input.sessionId ?? inst.sessionId,
      updatedAt: new Date(),
    })
    .where(eq(collegeTimetableInstances.id, inst.id))
    .returning();
  return { ok: true, instance: row };
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export async function createOverride(input: {
  slotId?: string | null;
  date: string;
  exceptionType: string;
  newStartTime?: string;
  newEndTime?: string;
  newTitle?: string;
  newCourseId?: string | null;
  reason: string;
  provenance?: string;
}): Promise<
  { ok: true; override: typeof collegeTimetableOverrides.$inferSelect } | { ok: false; error: string }
> {
  if (!EXCEPTION_TYPES.includes(input.exceptionType as (typeof EXCEPTION_TYPES)[number])) {
    return { ok: false, error: `unknown exception type "${input.exceptionType}"` };
  }
  if (!input.reason.trim()) {
    return {
      ok: false,
      error:
        "reason required — an override records why reality differed, and that reason is what stops a future audit treating it as an unexplained change",
    };
  }
  const [row] = await db
    .insert(collegeTimetableOverrides)
    .values({
      slotId: input.slotId ?? null,
      date: input.date,
      exceptionType: input.exceptionType,
      newStartTime: (input.newStartTime ?? "").slice(0, 10),
      newEndTime: (input.newEndTime ?? "").slice(0, 10),
      newTitle: (input.newTitle ?? "").slice(0, 200),
      newCourseId: input.newCourseId ?? null,
      reason: input.reason.slice(0, 2000),
      provenance: (input.provenance ?? "founder").slice(0, 120),
    })
    .returning();
  return { ok: true, override: row };
}

// ---------------------------------------------------------------------------
// Curriculum ↔ timetable conflicts — surfaced, never auto-repaired
// ---------------------------------------------------------------------------

export interface TimetableConflict {
  kind: "slot_without_active_course" | "active_course_without_slot" | "needs_configuration";
  detail: string;
  slotId?: string;
  courseId?: string;
  severity: "high" | "medium" | "low";
}

export async function detectTimetableConflicts(
  activeCourseIds: string[]
): Promise<TimetableConflict[]> {
  const version = await getActiveTimetableVersion();
  if (!version) return [];
  const slots = await getTemplateSlots(version.id);
  const courses = await db.select().from(collegeCourses);
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const out: TimetableConflict[] = [];

  const active = new Set(activeCourseIds);
  const placed = new Set<string>();

  for (const s of slots) {
    if (s.courseId) {
      placed.add(s.courseId);
      if (!active.has(s.courseId)) {
        const c = courseById.get(s.courseId);
        out.push({
          kind: "slot_without_active_course",
          slotId: s.id,
          courseId: s.courseId,
          detail: `${dayName(s.dayOfWeek)} ${s.startTime} "${s.title}" references ${
            c ? c.code : "a course"
          }, which is not in the active curriculum. The slot has been left in place.`,
          severity: "high",
        });
      }
    }
    if (s.needsConfiguration) {
      out.push({
        kind: "needs_configuration",
        slotId: s.id,
        detail: `${dayName(s.dayOfWeek)} "${s.title}": ${s.configurationNote}`,
        severity: "low",
      });
    }
  }

  for (const id of active) {
    if (!placed.has(id)) {
      const c = courseById.get(id);
      out.push({
        kind: "active_course_without_slot",
        courseId: id,
        detail: `${c ? c.code : "A course"} is in the active curriculum but has no timetable placement.`,
        severity: "medium",
      });
    }
  }

  return out;
}
