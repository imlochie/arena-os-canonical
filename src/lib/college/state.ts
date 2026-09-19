// ============================================================================
// Lochie Life College — College State engine (SERVER ONLY)
// ============================================================================
// The institution's current understanding of itself, recomputed from persisted
// state rather than recalled from a model's conversation context.
//
// Non-negotiables implemented here:
//   • State lives in the database. The model interprets it; it never stores it.
//   • Every surfaced value is a Claim carrying truth class + provenance.
//   • Scheduled / Observed / Adjusted are computed separately and compared,
//     never merged. A deviation is reported, not auto-resolved.
//   • UNKNOWN and CONFLICT are first-class outcomes. Empty tables produce
//     honest "the institution does not know" rather than invented data.
// ============================================================================

import { db } from "@/db";
import {
  collegeContextSignals,
  collegeCourses,
  collegeCourseWeeks,
  collegeDeviations,
  collegeFaculty,
  collegeGoals,
  collegeInstitution,
  collegeMemory,
  collegeRecords,
  collegeSessions,
  collegeSources,
  collegeStateSnapshots,
  collegeTerms,
  collegeTimetableSlots,
  collegeWeeks,
} from "@/db/college";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  brisbaneDayOfWeek,
  brisbaneLongDate,
  brisbaneTime,
  brisbaneToday,
  dayName,
  deriveWeek,
  formatIsoDate,
  INSTITUTIONAL_TZ,
} from "./time";
import {
  Claim,
  conflict,
  expectation,
  fact,
  interpretation,
  unknown,
} from "./truth";

export interface TimetableEntry {
  id: string;
  dayOfWeek: number;
  dayLabel: string;
  startTime: string;
  label: string;
  courseCode: string | null;
  courseTitle: string | null;
  sessionKind: string;
  confidence: string;
  sourceKey: string;
}

export interface CollegeState {
  generatedAt: string;
  realWorld: {
    date: Claim<string>;
    longDate: string;
    time: string;
    dayOfWeek: number;
    dayLabel: string;
    timezone: string;
  };
  institution: {
    known: boolean;
    name: string;
    motto: string;
    foundingQuote: string;
    academicYear: number;
    phase: string;
    facultyStatus: Claim<string | null>;
  };
  position: {
    term: Claim<string | null>;
    derivedWeek: Claim<number | null>;
    declaredWeek: Claim<number | null>;
    /** The reconciled reading — may legitimately be a CONFLICT. */
    effectiveWeek: Claim<number | null>;
    weekTheme: Claim<string | null>;
    termStatusNote: string;
    outOfRange: boolean;
    weeksPastEnd: number;
    weekCount: number;
  };
  scheduled: {
    todaySlots: TimetableEntry[];
    nextSlot: Claim<TimetableEntry | null>;
    weekSlots: TimetableEntry[];
    timetableKnown: boolean;
  };
  observed: {
    currentSession: Claim<Record<string, unknown> | null>;
    recentSessions: Array<Record<string, unknown>>;
    sessionsThisWeek: number;
  };
  deviations: {
    open: Array<Record<string, unknown>>;
    count: number;
  };
  context: {
    activeSignals: Array<Record<string, unknown>>;
    count: number;
  };
  goals: {
    active: Array<Record<string, unknown>>;
    count: number;
    stalled: number;
  };
  knowledge: {
    established: Array<Record<string, unknown>>;
    hypotheses: Array<Record<string, unknown>>;
    revisitQueue: Array<Record<string, unknown>>;
    openQuestions: Array<Record<string, unknown>>;
    counts: { observation: number; interpretation: number; hypothesis: number; established: number };
  };
  record: {
    recentFiled: Array<Record<string, unknown>>;
    pendingProposals: Array<Record<string, unknown>>;
    filedCount: number;
    proposedCount: number;
  };
  faculty: {
    positions: Array<Record<string, unknown>>;
    count: number;
  };
  curriculum: {
    courses: Array<Record<string, unknown>>;
    approvedCount: number;
    blueprintCount: number;
  };
  attention: {
    items: Array<{ severity: string; title: string; detail: string; truthClass: string }>;
  };
  conflicts: Array<{ title: string; detail: string; sources: string[] }>;
  unknowns: string[];
  sources: Array<Record<string, unknown>>;
}

function slotToEntry(
  s: typeof collegeTimetableSlots.$inferSelect,
  courseMap: Map<string, { code: string; title: string }>
): TimetableEntry {
  const c = s.courseId ? courseMap.get(s.courseId) : undefined;
  return {
    id: s.id,
    dayOfWeek: s.dayOfWeek,
    dayLabel: dayName(s.dayOfWeek),
    startTime: s.startTime,
    label: s.label,
    courseCode: c?.code ?? null,
    courseTitle: c?.title ?? null,
    sessionKind: s.sessionKind,
    confidence: s.confidence,
    sourceKey: s.sourceKey,
  };
}

/**
 * Compute the full institutional state. Pure read — no writes, no side
 * effects, safe to call on every request.
 */
export async function computeCollegeState(now: Date = new Date()): Promise<CollegeState> {
  const todayIso = brisbaneToday(now);
  const dow = brisbaneDayOfWeek(now);
  const unknowns: string[] = [];
  const conflicts: Array<{ title: string; detail: string; sources: string[] }> = [];
  const attention: Array<{ severity: string; title: string; detail: string; truthClass: string }> = [];

  // ---- institution ----
  const [inst] = await db.select().from(collegeInstitution).limit(1);

  // ---- term + calendar ----
  const terms = await db
    .select()
    .from(collegeTerms)
    .where(eq(collegeTerms.status, "active"))
    .orderBy(desc(collegeTerms.year))
    .limit(1);
  const term = terms[0];

  let termClaim: Claim<string | null>;
  let derivedWeekClaim: Claim<number | null>;
  let declaredWeekClaim: Claim<number | null>;
  let effectiveWeekClaim: Claim<number | null>;
  let weekThemeClaim: Claim<string | null>;
  let outOfRange = false;
  let weeksPastEnd = 0;
  let weekCount = 0;
  let termStatusNote = "";

  if (!term) {
    termClaim = unknown("No active term recorded in College State.");
    derivedWeekClaim = unknown("No term start date available to derive from.");
    declaredWeekClaim = unknown("No institutional declaration recorded.");
    effectiveWeekClaim = unknown("Cannot determine academic position.");
    weekThemeClaim = unknown("No week theme available.");
    unknowns.push("No active academic term is recorded. The College cannot place itself in time.");
  } else {
    weekCount = term.weekCount;
    termClaim = fact(term.name, term.sourceKey || "Academic Calendar", term.sourceKey);
    const d = deriveWeek(term.startMonday, term.weekCount, todayIso);
    outOfRange = d.outOfRange;
    weeksPastEnd = d.weeksPastEnd;

    // The arithmetic itself is a fact about the calendar.
    derivedWeekClaim = fact(
      d.weekIndex,
      `Derived from Academic Calendar: Week 1 Monday ${formatIsoDate(term.startMonday)}, today ${formatIsoDate(todayIso)}`,
      term.sourceKey
    );

    const declared = inst?.declaredWeekIndex ?? null;
    declaredWeekClaim =
      declared === null
        ? unknown("Institutional State does not declare a current week.")
        : fact(
            declared,
            `${inst?.declaredSourceKey || "Institutional State"}${inst?.declaredStatusNote ? ` — ${inst.declaredStatusNote}` : ""}`,
            inst?.declaredSourceKey ?? undefined
          );

    // ---- reconcile: declared vs derived ----
    if (declared !== null && declared !== d.weekIndex) {
      const detail = `The Academic Calendar places today (${formatIsoDate(todayIso)}) in week ${d.weekIndex}${d.outOfRange ? ` — which is ${d.weeksPastEnd} week(s) past the final listed week (${term.weekCount})` : ""}, while Institutional State declares Week ${declared}.`;
      effectiveWeekClaim = conflict(
        declared,
        "Institutional State vs Academic Calendar",
        [
          `Academic Calendar → week ${d.weekIndex}`,
          `Institutional State → week ${declared}`,
        ],
        detail
      );
      conflicts.push({
        title: "Academic position is disputed",
        detail,
        sources: ["Academic Calendar (Source of Truth)", "Institutional State — Current"],
      });
      attention.push({
        severity: "high",
        title: "Unresolved academic position",
        detail:
          "Teaching position cannot be trusted until Administration reconciles the calendar with Institutional State. The College is not guessing on your behalf.",
        truthClass: "conflict",
      });
    } else if (d.outOfRange) {
      const detail = `Today is ${d.weeksPastEnd} week(s) past the final listed week (Week ${term.weekCount}). The calendar does not define what happens after Week ${term.weekCount}.`;
      effectiveWeekClaim = conflict(
        d.weekIndex,
        "Academic Calendar (Source of Truth)",
        [`Calendar defines weeks 1–${term.weekCount}`, `Derived position: week ${d.weekIndex}`],
        detail
      );
      conflicts.push({
        title: "Calendar exhausted",
        detail,
        sources: ["Academic Calendar (Source of Truth)"],
      });
      attention.push({
        severity: "high",
        title: "Semester calendar has no entry for today",
        detail: `Week ${term.weekCount} ended and no further weeks are defined. Administration needs to close the semester or extend the calendar.`,
        truthClass: "conflict",
      });
    } else {
      effectiveWeekClaim = fact(
        d.weekIndex,
        "Academic Calendar (Source of Truth) — agrees with Institutional State",
        term.sourceKey
      );
    }

    // theme for the effective week
    const weekRows = await db
      .select()
      .from(collegeWeeks)
      .where(eq(collegeWeeks.termId, term.id))
      .orderBy(asc(collegeWeeks.weekIndex));
    const target = effectiveWeekClaim.value;
    const wk = weekRows.find((w) => w.weekIndex === target);
    weekThemeClaim = wk
      ? fact(wk.theme, "Academic Calendar week table", wk.sourceKey)
      : unknown(
          d.outOfRange
            ? `Calendar defines no week ${target}.`
            : "No theme recorded for this week."
        );
    termStatusNote = inst?.declaredStatusNote ?? "";
  }

  // ---- courses ----
  const courses = await db.select().from(collegeCourses).orderBy(asc(collegeCourses.code));
  const courseMap = new Map(courses.map((c) => [c.id, { code: c.code, title: c.title }]));
  const approvedCount = courses.filter((c) => c.status === "approved" || c.status === "delivering").length;
  const blueprintCount = courses.filter((c) => c.status === "blueprint").length;

  // ---- scheduled state (timetable) ----
  const slots = await db
    .select()
    .from(collegeTimetableSlots)
    .where(eq(collegeTimetableSlots.active, true))
    .orderBy(asc(collegeTimetableSlots.dayOfWeek), asc(collegeTimetableSlots.startTime));
  const timetableKnown = slots.length > 0;
  if (!timetableKnown) {
    unknowns.push(
      "No timetable slots are recorded. The College cannot say what should be happening today."
    );
  }
  const weekSlots = slots.map((s) => slotToEntry(s, courseMap));
  const todaySlots = weekSlots.filter((s) => s.dayOfWeek === dow);

  let nextSlot: Claim<TimetableEntry | null>;
  if (!timetableKnown) {
    nextSlot = unknown("No timetable recorded.");
  } else {
    const nowHm = brisbaneTime(now);
    const laterToday = todaySlots.find((s) => !s.startTime || s.startTime > nowHm);
    const upcoming =
      laterToday ??
      [...weekSlots].sort((a, b) => {
        const da = (a.dayOfWeek - dow + 7) % 7 || 7;
        const dbb = (b.dayOfWeek - dow + 7) % 7 || 7;
        return da - dbb || a.startTime.localeCompare(b.startTime);
      })[0];
    nextSlot = upcoming
      ? expectation(
          upcoming,
          `Timetable (${upcoming.confidence}) — ${upcoming.sourceKey || "unattributed source"}`,
          upcoming.sourceKey
        )
      : unknown("No upcoming timetable slot found.");
    const lowConfidence = weekSlots.filter((s) => s.confidence !== "known");
    if (lowConfidence.length) {
      attention.push({
        severity: "medium",
        title: "Timetable is not fully established",
        detail: `${lowConfidence.length} slot(s) are marked ${[...new Set(lowConfidence.map((s) => s.confidence))].join("/")} rather than known. Treat them as provisional.`,
        truthClass: "interpretation",
      });
    }
  }

  // ---- observed state (sessions) ----
  const recentSessions = await db
    .select()
    .from(collegeSessions)
    .orderBy(desc(collegeSessions.createdAt))
    .limit(10);
  const running = recentSessions.find((s) => s.status === "running");
  const currentSession: Claim<Record<string, unknown> | null> = running
    ? fact(running as unknown as Record<string, unknown>, "College session runtime")
    : unknown("No session is currently running.");
  const sessionsThisWeek = recentSessions.filter(
    (s) => s.weekIndex === effectiveWeekClaim.value
  ).length;

  // ---- deviations (timetable vs reality) ----
  const openDeviations = await db
    .select()
    .from(collegeDeviations)
    .where(sql`${collegeDeviations.resolution} in ('open','acknowledged')`)
    .orderBy(desc(collegeDeviations.createdAt))
    .limit(20);
  for (const d of openDeviations) {
    attention.push({
      severity: d.resolution === "open" ? "high" : "medium",
      title: `Deviation: ${d.deviationType.replace(/_/g, " ")}`,
      detail: `Scheduled: ${d.scheduledState || "—"} · Observed: ${d.observedState || "—"}${d.adjustedState ? ` · Adjusted: ${d.adjustedState}` : " · No adjustment decided"}`,
      truthClass: d.adjustedState ? "decision" : "fact",
    });
  }

  // ---- real-world context ----
  const signals = await db
    .select()
    .from(collegeContextSignals)
    .where(eq(collegeContextSignals.active, true))
    .orderBy(desc(collegeContextSignals.createdAt))
    .limit(20);

  // ---- goals ----
  const goals = await db
    .select()
    .from(collegeGoals)
    .where(sql`${collegeGoals.status} in ('proposed','active','progressing','stalled')`)
    .orderBy(desc(collegeGoals.updatedAt))
    .limit(20);
  const stalled = goals.filter((g) => g.status === "stalled").length;

  // ---- educational memory ----
  const memAll = await db
    .select()
    .from(collegeMemory)
    .where(eq(collegeMemory.active, true))
    .orderBy(desc(collegeMemory.updatedAt))
    .limit(200);
  const counts = {
    observation: memAll.filter((m) => m.epistemicStatus === "observation").length,
    interpretation: memAll.filter((m) => m.epistemicStatus === "interpretation").length,
    hypothesis: memAll.filter((m) => m.epistemicStatus === "hypothesis").length,
    established: memAll.filter((m) => m.epistemicStatus === "established").length,
  };
  const established = memAll.filter((m) => m.epistemicStatus === "established").slice(0, 8);
  const hypotheses = memAll.filter((m) => m.epistemicStatus === "hypothesis").slice(0, 8);
  const revisitQueue = memAll.filter((m) => m.memoryType === "revisit").slice(0, 10);
  const openQuestions = memAll.filter((m) => m.memoryType === "question").slice(0, 10);
  if (revisitQueue.length) {
    attention.push({
      severity: "medium",
      title: `${revisitQueue.length} item(s) queued for revisit`,
      detail: revisitQueue
        .slice(0, 3)
        .map((r) => r.content.slice(0, 90))
        .join(" · "),
      truthClass: "fact",
    });
  }

  // ---- institutional record ----
  const recentFiled = await db
    .select()
    .from(collegeRecords)
    .where(eq(collegeRecords.status, "filed"))
    .orderBy(desc(collegeRecords.filedAt))
    .limit(10);
  const pendingProposals = await db
    .select()
    .from(collegeRecords)
    .where(eq(collegeRecords.status, "proposed"))
    .orderBy(desc(collegeRecords.createdAt))
    .limit(20);
  if (pendingProposals.length) {
    attention.push({
      severity: "medium",
      title: `${pendingProposals.length} record(s) awaiting filing`,
      detail:
        "The Registrar has proposed records. They are not institutional history until filed.",
      truthClass: "expectation",
    });
  }
  const [filedCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(collegeRecords)
    .where(eq(collegeRecords.status, "filed"));

  // ---- faculty ----
  const faculty = await db
    .select()
    .from(collegeFaculty)
    .where(eq(collegeFaculty.active, true))
    .orderBy(asc(collegeFaculty.positionKey));

  // ---- sources ----
  const sources = await db.select().from(collegeSources).orderBy(asc(collegeSources.key));

  if (!inst) {
    unknowns.push("No institution record exists. Run the College bootstrap.");
  }
  if (!courses.length) {
    unknowns.push("No courses are recorded. Curriculum position is unknown.");
  }
  if (!faculty.length) {
    unknowns.push("No faculty positions are defined.");
  }

  return {
    generatedAt: new Date().toISOString(),
    realWorld: {
      date: fact(todayIso, "System clock, rendered in Australia/Brisbane"),
      longDate: brisbaneLongDate(now),
      time: brisbaneTime(now),
      dayOfWeek: dow,
      dayLabel: dayName(dow),
      timezone: INSTITUTIONAL_TZ,
    },
    institution: {
      known: Boolean(inst),
      name: inst?.name ?? "Lochie Life College",
      motto: inst?.motto ?? "Become by Learning.",
      foundingQuote: inst?.foundingQuote ?? "That's Life.",
      academicYear: inst?.academicYear ?? 2026,
      phase: inst?.institutionalPhase ?? "",
      facultyStatus: inst?.facultyStatus
        ? fact(inst.facultyStatus, inst.declaredSourceKey || "Institutional State")
        : unknown("Faculty status not recorded."),
    },
    position: {
      term: termClaim,
      derivedWeek: derivedWeekClaim,
      declaredWeek: declaredWeekClaim,
      effectiveWeek: effectiveWeekClaim,
      weekTheme: weekThemeClaim,
      termStatusNote,
      outOfRange,
      weeksPastEnd,
      weekCount,
    },
    scheduled: {
      todaySlots,
      nextSlot,
      weekSlots,
      timetableKnown,
    },
    observed: {
      currentSession,
      recentSessions: recentSessions as unknown as Array<Record<string, unknown>>,
      sessionsThisWeek,
    },
    deviations: {
      open: openDeviations as unknown as Array<Record<string, unknown>>,
      count: openDeviations.length,
    },
    context: {
      activeSignals: signals as unknown as Array<Record<string, unknown>>,
      count: signals.length,
    },
    goals: {
      active: goals as unknown as Array<Record<string, unknown>>,
      count: goals.length,
      stalled,
    },
    knowledge: {
      established: established as unknown as Array<Record<string, unknown>>,
      hypotheses: hypotheses as unknown as Array<Record<string, unknown>>,
      revisitQueue: revisitQueue as unknown as Array<Record<string, unknown>>,
      openQuestions: openQuestions as unknown as Array<Record<string, unknown>>,
      counts,
    },
    record: {
      recentFiled: recentFiled as unknown as Array<Record<string, unknown>>,
      pendingProposals: pendingProposals as unknown as Array<Record<string, unknown>>,
      filedCount: filedCountRow?.n ?? 0,
      proposedCount: pendingProposals.length,
    },
    faculty: {
      positions: faculty as unknown as Array<Record<string, unknown>>,
      count: faculty.length,
    },
    curriculum: {
      courses: courses as unknown as Array<Record<string, unknown>>,
      approvedCount,
      blueprintCount,
    },
    attention: { items: attention },
    conflicts,
    unknowns,
    sources: sources as unknown as Array<Record<string, unknown>>,
  };
}

/**
 * Persist an auditable snapshot of derived state. Derived values are
 * rebuildable; the snapshot exists so a past reading can be explained.
 */
export async function snapshotCollegeState(
  reason: string,
  state?: CollegeState
): Promise<string | null> {
  try {
    const s = state ?? (await computeCollegeState());
    const [row] = await db
      .insert(collegeStateSnapshots)
      .values({
        reason: reason.slice(0, 120),
        brisbaneDate: s.realWorld.date.value,
        derivedWeekIndex: s.position.derivedWeek.value ?? null,
        declaredWeekIndex: s.position.declaredWeek.value ?? null,
        conflictCount: s.conflicts.length,
        unknownCount: s.unknowns.length,
        payload: JSON.stringify(s).slice(0, 900000),
      })
      .returning();
    return row?.id ?? null;
  } catch {
    return null;
  }
}
