// ============================================================================
// Lochie Life College — LAYER 7, part 1: TEMPORAL STATE
// ============================================================================
// Time is not presentation metadata. Time is operational context.
//
// Layer 6 taught the College to track what it knows. This module answers a
// different question: HOW LONG HAS IT BEEN? Elapsed time changes what a
// briefing should do — a student returning after two days needs orientation,
// a student returning after three weeks needs their continuity reconstructed,
// and neither should be decided by a model guessing from a date string.
//
// Everything here is DETERMINISTIC and derived from the application clock in
// Australia/Brisbane. No AI, no inference, no "it feels like week 11". If the
// evidence for an interval does not exist, this module says so rather than
// substituting a plausible number — an invented elapsed time is worse than an
// admitted gap, because every downstream decision would inherit the fiction.
//
// It computes nothing about the student's psychology. It measures intervals
// between recorded events, and it names what it could not measure.
// ============================================================================

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  collegeAudits,
  collegeEventLedger,
  collegeGoals,
  collegeSessions,
} from "@/db/college";
import { brisbaneNow, brisbaneToday, INSTITUTIONAL_TZ } from "./time";

// ---------------------------------------------------------------------------
// Interval — a measured gap, or an honest absence of one
// ---------------------------------------------------------------------------

/**
 * Every temporal field is one of these. `known: false` is a first-class
 * outcome: "we have never recorded a College session" is a real answer, and it
 * must not be rendered as "0 days ago", which would read as "just now".
 */
export interface Interval {
  /** Whether the College actually has the evidence to measure this. */
  known: boolean;
  /** Whole days elapsed, Brisbane calendar days. Null when unknown. */
  days: number | null;
  /** Whole hours elapsed, for intervals shorter than a day. Null when unknown. */
  hours: number | null;
  /** The ISO date the interval is measured from. Null when unknown. */
  since: string | null;
  /** Human phrasing: "4 days ago", "never recorded". */
  label: string;
  /** What evidence this was measured from, so the number is auditable. */
  evidence: string;
}

const unknownInterval = (evidence: string): Interval => ({
  known: false,
  days: null,
  hours: null,
  since: null,
  label: "no record",
  evidence,
});

/** Brisbane calendar date → a UTC-noon instant, so day arithmetic cannot drift. */
function dateToNoon(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0);
}

/** Whole Brisbane calendar days between two ISO dates (b - a). */
export function daysBetween(aIso: string, bIso: string): number {
  return Math.round((dateToNoon(bIso) - dateToNoon(aIso)) / 86_400_000);
}

function phrase(days: number, hours: number | null): string {
  if (days === 0) {
    if (hours === null) return "today";
    if (hours <= 0) return "just now";
    if (hours === 1) return "1 hour ago";
    return `${hours} hours ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  // Round to nearest rather than floor: 15 days is "2 weeks", not "2 weeks"
  // by accident of flooring while 13 days is "1 week". An absence the student
  // is being asked to reason about should not be quietly understated.
  if (days < 14) return `${days} days ago`;
  if (days < 45) {
    const w = Math.round(days / 7);
    return `${w} week${w === 1 ? "" : "s"} ago (${days} days)`;
  }
  if (days < 365) {
    const m = Math.round(days / 30);
    return `${m} month${m === 1 ? "" : "s"} ago (${days} days)`;
  }
  return "over a year ago";
}

/** Build an interval from a past timestamp or ISO date. */
function intervalFrom(
  value: Date | string | null | undefined,
  evidence: string,
  now: Date
): Interval {
  if (!value) return unknownInterval(evidence);
  const iso =
    typeof value === "string"
      ? value.slice(0, 10)
      : brisbaneToday(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return unknownInterval(evidence);

  const today = brisbaneToday(now);
  const days = daysBetween(iso, today);
  const hours =
    typeof value === "string"
      ? null
      : Math.max(0, Math.floor((now.getTime() - value.getTime()) / 3_600_000));

  return {
    known: true,
    days,
    hours,
    since: iso,
    label: days < 0 ? `in ${Math.abs(days)} days` : phrase(days, hours),
    evidence,
  };
}

/** Build a forward-looking interval (a deadline). Negative days = overdue. */
function countdownTo(
  iso: string | null | undefined,
  evidence: string,
  now: Date
): Interval {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso.slice(0, 10))) {
    return unknownInterval(evidence);
  }
  const target = iso.slice(0, 10);
  const today = brisbaneToday(now);
  const days = daysBetween(today, target);
  return {
    known: true,
    days,
    hours: null,
    since: target,
    label:
      days < 0
        ? `${Math.abs(days)} days overdue`
        : days === 0
          ? "today"
          : days === 1
            ? "tomorrow"
            : `in ${days} days`,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Continuity — what elapsed time MEANS
// ---------------------------------------------------------------------------

export type ContinuityState =
  | "no_history"
  | "normal"
  | "short_absence"
  | "extended_absence"
  | "long_absence";

/**
 * Thresholds are configuration, not magic numbers buried in a conditional.
 * They are exported so the briefing can show its own boundaries — a student
 * told "you have been away a long time" is entitled to know what the College
 * counts as long.
 */
export const CONTINUITY_THRESHOLDS = {
  /** Up to this many days: ordinary rhythm, nothing to reconstruct. */
  normalDays: 3,
  /** Up to this many days: short absence, mention what changed. */
  shortAbsenceDays: 8,
  /** Up to this many days: extended absence, rebuild continuity. */
  extendedAbsenceDays: 22,
  /** Beyond that: a re-entry briefing. */
} as const;

export interface ContinuityAssessment {
  state: ContinuityState;
  /** What the briefing should DO in this state. */
  briefingBehaviour: string;
  /** Why this state was chosen, in terms of the measured interval. */
  reason: string;
}

export function assessContinuity(lastMeaningful: Interval): ContinuityAssessment {
  if (!lastMeaningful.known || lastMeaningful.days === null) {
    return {
      state: "no_history",
      briefingBehaviour:
        "State plainly that there is no recorded history to brief from. Do not improvise a narrative.",
      reason:
        "No qualifying interaction has ever been recorded, so no interval can be measured.",
    };
  }
  const d = lastMeaningful.days;
  if (d <= CONTINUITY_THRESHOLDS.normalDays) {
    return {
      state: "normal",
      briefingBehaviour:
        "Quick orientation. Continuity is intact — do not re-explain what the student already holds.",
      reason: `Last meaningful interaction ${d} day(s) ago, within the ${CONTINUITY_THRESHOLDS.normalDays}-day normal rhythm.`,
    };
  }
  if (d < CONTINUITY_THRESHOLDS.shortAbsenceDays) {
    return {
      state: "short_absence",
      briefingBehaviour:
        "Mention what changed since the last visit. Do not reconstruct the whole picture.",
      reason: `Last meaningful interaction ${d} day(s) ago — a short gap, not a break in continuity.`,
    };
  }
  if (d < CONTINUITY_THRESHOLDS.extendedAbsenceDays) {
    return {
      state: "extended_absence",
      briefingBehaviour:
        "Reconstruct continuity: where the curriculum stands, what was last taught, what remains open.",
      reason: `Last meaningful interaction ${d} day(s) ago — long enough that context has to be rebuilt, not assumed.`,
    };
  }
  return {
    state: "long_absence",
    briefingBehaviour:
      "Re-entry briefing. Establish where the College is before proposing anything. Do not open with obligations.",
    reason: `Last meaningful interaction ${d} day(s) ago — the student is returning, not continuing.`,
  };
}

// ---------------------------------------------------------------------------
// What counts as "meaningful progress"
// ---------------------------------------------------------------------------

/**
 * MEANINGFUL PROGRESS IS EVIDENCED, NOT FELT.
 *
 * The temptation is to score engagement. That is exactly the psychological
 * profiling the College refuses. Instead this is a fixed, inspectable list of
 * ledger events that constitute demonstrated movement: the student showed
 * something, an objective was met, a goal was advanced, or a record was filed.
 *
 * Opening a page is not progress. A class that ran is not automatically
 * progress either — attendance is participation, and it is measured
 * separately as "last College session".
 */
export const MEANINGFUL_PROGRESS_EVENTS = [
  "objective_demonstrated",
  "goal_addressed",
  "record_filed",
  "memory_promoted",
  "curriculum_change",
  "decision_recorded",
] as const;

/** Events that count as the student being present at all. */
export const INTERACTION_EVENTS = [
  "class_opened",
  "session_closed",
  "faculty_activated",
  "real_world_interruption",
  "real_world_context_added",
  ...MEANINGFUL_PROGRESS_EVENTS,
] as const;

// ---------------------------------------------------------------------------
// The resolved temporal state
// ---------------------------------------------------------------------------

export interface GoalTemporal {
  id: string;
  title: string;
  status: string;
  timeframe: string;
  sinceStart: Interval;
  sinceReview: Interval;
  /** Only present when the goal carries a real deadline. */
  deadline: Interval | null;
  /** Diagnostic condition, never a score. */
  condition: string;
  /**
   * True only when a dated deadline is genuinely close. A goal with no
   * deadline is never "under pressure" — inventing urgency is how a briefing
   * becomes nagging.
   */
  underTimePressure: boolean;
}

export interface TemporalState {
  /** The application clock. Never model memory. */
  now: {
    isoDate: string;
    time: string;
    dayOfWeek: number;
    timezone: string;
  };
  sinceLastCollegeSession: Interval;
  sinceLastExternalAcademicEvent: Interval;
  sinceLastMeaningfulProgress: Interval;
  sinceLastInteraction: Interval;
  sinceLastReview: Interval;
  goals: GoalTemporal[];
  continuity: ContinuityAssessment;
  /** Things the College could not measure, named explicitly. */
  unmeasured: string[];
}

/**
 * Resolve the College's temporal position.
 *
 * Read-only. This never writes, never closes a session, never decides that
 * something has lapsed. It measures and reports; Layer 6 already established
 * that completion requires evidence rather than a clock, and that rule does
 * not weaken just because a different module is doing the arithmetic.
 */
export async function resolveTemporalState(
  now: Date = new Date()
): Promise<TemporalState> {
  const clock = brisbaneNow(now);
  const unmeasured: string[] = [];

  // ---- last College session (observed, not merely scheduled) -------------
  const [lastSession] = await db
    .select({
      observedDate: collegeSessions.observedDate,
      status: collegeSessions.status,
    })
    .from(collegeSessions)
    .where(
      and(
        isNotNull(collegeSessions.observedDate),
        sql`${collegeSessions.status} in ('completed','running','interrupted')`
      )
    )
    .orderBy(desc(collegeSessions.observedDate))
    .limit(1);

  const sinceLastCollegeSession = intervalFrom(
    lastSession?.observedDate ?? null,
    "college_sessions.observed_date, most recent session that actually ran",
    now
  );
  if (!sinceLastCollegeSession.known) {
    unmeasured.push("No College session has been observed, so session rhythm cannot be measured.");
  }

  // ---- last external academic event (TAFE and similar) -------------------
  const [lastExternal] = await db
    .select({ date: collegeEventLedger.date, summary: collegeEventLedger.summary })
    .from(collegeEventLedger)
    .where(eq(collegeEventLedger.eventType, "external_academic_event"))
    .orderBy(desc(collegeEventLedger.date))
    .limit(1);

  const sinceLastExternalAcademicEvent = intervalFrom(
    lastExternal?.date ?? null,
    "event ledger, external_academic_event",
    now
  );
  if (!sinceLastExternalAcademicEvent.known) {
    unmeasured.push(
      "No external academic event has been recorded. The College knows nothing about TAFE or other providers unless it is told."
    );
  }

  // ---- last meaningful progress -----------------------------------------
  const [lastProgress] = await db
    .select({ date: collegeEventLedger.date, eventType: collegeEventLedger.eventType })
    .from(collegeEventLedger)
    .where(
      sql`${collegeEventLedger.eventType} in ${sql.raw(
        `(${MEANINGFUL_PROGRESS_EVENTS.map((e) => `'${e}'`).join(",")})`
      )}`
    )
    .orderBy(desc(collegeEventLedger.date))
    .limit(1);

  const sinceLastMeaningfulProgress = intervalFrom(
    lastProgress?.date ?? null,
    lastProgress
      ? `event ledger, "${lastProgress.eventType}" — evidenced progress, not inferred`
      : "event ledger, no qualifying progress event",
    now
  );
  if (!sinceLastMeaningfulProgress.known) {
    unmeasured.push(
      "No evidenced progress event exists yet. Absence of evidence is reported as such, never as a lack of progress."
    );
  }

  // ---- last interaction of any kind -------------------------------------
  const [lastInteraction] = await db
    .select({ date: collegeEventLedger.date, eventType: collegeEventLedger.eventType })
    .from(collegeEventLedger)
    .where(
      sql`${collegeEventLedger.eventType} in ${sql.raw(
        `(${INTERACTION_EVENTS.map((e) => `'${e}'`).join(",")})`
      )}`
    )
    .orderBy(desc(collegeEventLedger.date))
    .limit(1);

  const sinceLastInteraction = intervalFrom(
    lastInteraction?.date ?? null,
    lastInteraction
      ? `event ledger, "${lastInteraction.eventType}"`
      : "event ledger, no interaction recorded",
    now
  );

  // ---- last audit / review ----------------------------------------------
  const [lastAudit] = await db
    .select({ createdAt: collegeAudits.createdAt, scopeLabel: collegeAudits.scopeLabel })
    .from(collegeAudits)
    .orderBy(desc(collegeAudits.createdAt))
    .limit(1);

  const sinceLastReview = intervalFrom(
    lastAudit?.createdAt ?? null,
    lastAudit ? `college_audits, "${lastAudit.scopeLabel}"` : "college_audits, none recorded",
    now
  );

  // ---- goals -------------------------------------------------------------
  const goalRows = await db
    .select()
    .from(collegeGoals)
    .where(sql`${collegeGoals.status} in ('active','progressing','stalled','proposed')`)
    .orderBy(desc(collegeGoals.createdAt));

  const goals: GoalTemporal[] = goalRows.map((g) => {
    const sinceStart = intervalFrom(g.createdAt ?? null, "college_goals.created_at", now);
    const sinceReview = intervalFrom(
      g.lastReviewedAt ?? null,
      g.lastReviewedAt ? "college_goals.last_reviewed_at" : "college_goals.last_reviewed_at is null",
      now
    );
    // A deadline exists only when the goal carries a real dated target.
    const deadline = deadlineFor(g.timeframe, now);
    const underTimePressure =
      deadline !== null && deadline.known && deadline.days !== null && deadline.days <= 14;

    return {
      id: g.id,
      title: g.title,
      status: g.status,
      timeframe: g.timeframe || "open",
      sinceStart,
      sinceReview,
      deadline,
      condition: goalCondition(g.status, sinceReview, deadline),
      underTimePressure,
    };
  });

  const continuity = assessContinuity(
    sinceLastMeaningfulProgress.known ? sinceLastMeaningfulProgress : sinceLastInteraction
  );

  return {
    now: {
      isoDate: clock.isoDate,
      time: `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`,
      dayOfWeek: clock.dayOfWeek,
      timezone: INSTITUTIONAL_TZ,
    },
    sinceLastCollegeSession,
    sinceLastExternalAcademicEvent,
    sinceLastMeaningfulProgress,
    sinceLastInteraction,
    sinceLastReview,
    goals,
    continuity,
    unmeasured,
  };
}

/**
 * A timeframe is only a deadline when it names a date. "semester", "long_term"
 * and "open" are durations or intentions, not deadlines, and converting them
 * into one would manufacture pressure the founder never set.
 */
function deadlineFor(timeframe: string, now: Date): Interval | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/.exec((timeframe ?? "").trim());
  if (!iso) return null;
  return countdownTo(iso[0], "college_goals.timeframe, explicit dated target", now);
}

/**
 * Diagnostic condition — a sentence describing the actual state, never a score
 * and never an instruction to intervene.
 */
function goalCondition(
  status: string,
  sinceReview: Interval,
  deadline: Interval | null
): string {
  if (deadline?.known && deadline.days !== null && deadline.days < 0) {
    return `Dated target passed ${Math.abs(deadline.days)} day(s) ago. The goal is still open; the date is not.`;
  }
  if (deadline?.known && deadline.days !== null && deadline.days <= 14) {
    return `Dated target ${deadline.label}. Temporal pressure is real and stated.`;
  }
  if (status === "stalled") {
    return "Recorded as stalled. That is a standing condition, not today's news.";
  }
  if (!sinceReview.known) {
    return "Never formally reviewed. Not a problem in itself — stated so it is visible.";
  }
  if (sinceReview.days !== null && sinceReview.days > 60) {
    return `Last reviewed ${sinceReview.label}. Review is overdue by the College's own interval, not by urgency.`;
  }
  return "Stable. No change indicated.";
}

// ---------------------------------------------------------------------------
// Rendering — the same numbers, as text
// ---------------------------------------------------------------------------

export function renderTemporalState(t: TemporalState): string {
  const L: string[] = [];
  const row = (k: string, i: Interval) =>
    `  ${k.padEnd(34)} ${i.label}${i.since ? `  (${i.since})` : ""}`;

  L.push(`TEMPORAL STATE — ${t.now.isoDate} ${t.now.time} ${t.now.timezone}`);
  L.push("");
  L.push(row("Last meaningful interaction", t.sinceLastInteraction));
  L.push(row("Last meaningful progress", t.sinceLastMeaningfulProgress));
  L.push(row("Last College session", t.sinceLastCollegeSession));
  L.push(row("Last external academic event", t.sinceLastExternalAcademicEvent));
  L.push(row("Last review", t.sinceLastReview));
  L.push("");
  L.push(`CONTINUITY — ${t.continuity.state.toUpperCase().replace(/_/g, " ")}`);
  L.push(`  ${t.continuity.reason}`);
  L.push(`  → ${t.continuity.briefingBehaviour}`);

  if (t.goals.length) {
    L.push("");
    L.push("GOALS");
    for (const g of t.goals) {
      L.push(`  ${g.title} [${g.status}]`);
      L.push(`    started ${g.sinceStart.label} · reviewed ${g.sinceReview.label}`);
      if (g.deadline) L.push(`    target ${g.deadline.label}`);
      L.push(`    ${g.condition}`);
    }
  }

  if (t.unmeasured.length) {
    L.push("");
    L.push("NOT MEASURABLE");
    for (const u of t.unmeasured) L.push(`  · ${u}`);
  }

  return L.join("\n");
}
