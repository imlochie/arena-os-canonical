// ============================================================================
// Lochie Life College — LAYER 8: BOUNDED ACCOUNTABILITY
// ============================================================================
// "The College should hold you accountable to commitments you have actually
//  made, while remaining capable of recognising when circumstances changed."
//
// Accountability without punishment. The College may say:
//
//     "You said you would do X. You haven't done X.
//      Here's how we know. Here's how much time has passed."
//
// It may NOT say "therefore you are failing". Between those two sentences sits
// the entire difference between decision-support and a bureaucrat living in
// your phone.
//
// FOUR SEPARATE THINGS, deliberately never merged:
//
//   GOAL         what are we trying to accomplish?
//   PLAN         how did we intend to get there?
//   COMMITMENT   what did the student explicitly agree to do?
//   ACCOUNTABILITY  did reality match, and what should we understand from it?
//
// RULES ENFORCED HERE
//
//   · A MISSED COMMITMENT IS A FACT, NOT A VERDICT. It records what was missed
//     and, where the student said so, why. It never concludes anything about
//     the person.
//   · THE COLLEGE NEVER MOVES THE GOAL TO FLATTER THE NUMBERS. A missed
//     commitment does not silently lower the objective; that requires an
//     explicit institutional decision by the founder.
//   · A PATTERN IS REPORTED, NOT DIAGNOSED. Three misses is an observation
//     worth naming. It is not a personality assessment, and this module builds
//     no psychological profile.
//   · INTENSITY IS WORDING ONLY. gentle/direct/firm changes how a fact is
//     phrased. It never changes which facts exist, never creates an
//     obligation, and never grants authority — the Layer 3 rule that
//     personality cannot confer authority holds here verbatim.
//   · "NO CHANGE INDICATED" IS A REAL OUTCOME. A reviewed commitment that was
//     deliberately left alone stops reopening the same conversation daily.
// ============================================================================

import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  collegeAccountabilitySettings,
  collegeCommitments,
  collegeGoals,
} from "@/db/college";
import { brisbaneToday } from "./time";
import { daysBetween } from "./temporal-state";

export type Intensity = "gentle" | "direct" | "firm";

export interface AccountabilitySettings {
  intensity: Intensity;
  patternWindowDays: number;
  patternThreshold: number;
}

export const DEFAULT_ACCOUNTABILITY: AccountabilitySettings = {
  intensity: "direct",
  patternWindowDays: 14,
  patternThreshold: 3,
};

export interface CommitmentView {
  id: string;
  statement: string;
  commitmentType: string;
  status: string;
  dueDate: string | null;
  plannedMinutes: number | null;
  actualMinutes: number | null;
  goalId: string | null;
  goalTitle: string | null;
  missedReasonKind: string;
  missedReason: string;
  origin: string;
  /** Days until due. Negative = overdue. Null when undated. */
  daysUntilDue: number | null;
  /** Diagnostic sentence. Never a judgement about the student. */
  condition: string;
  /** True only when a real date has passed and nothing was recorded. */
  overdue: boolean;
  /** True when reviewed and deliberately left as-is. */
  settled: boolean;
}

export interface AccountabilityPattern {
  /** What repeated. */
  what: string;
  /** How many times, within the configured window. */
  occurrences: number;
  windowDays: number;
  /** The reasons the student gave, where they gave any. */
  statedReasons: string[];
  /**
   * What the College does about it: nothing automatic. The pattern is named
   * and the objective is explicitly NOT changed.
   */
  response: string;
}

export interface AccountabilityState {
  /** What the student agreed to, in the current window. */
  made: number;
  completed: number;
  missed: number;
  deferred: number;
  cancelled: number;
  open: number;
  /** Minutes intended vs minutes actually recorded. Null when unplanned. */
  plannedMinutes: number | null;
  actualMinutes: number | null;
  /**
   * Rhythm relative to the plan, in whole commitments. Negative = behind.
   * Null when there is no dated plan to be behind of — being "behind" requires
   * something to be behind.
   */
  rhythmDelta: number | null;
  rhythmNote: string;
  commitments: CommitmentView[];
  overdue: CommitmentView[];
  dueToday: CommitmentView[];
  patterns: AccountabilityPattern[];
  /** Whether anything at all warrants the student's attention. */
  quiet: boolean;
  /** The headline sentence, phrased at the configured intensity. */
  summary: string;
  settings: AccountabilitySettings;
  note: string;
}

// ---------------------------------------------------------------------------
// Wording — intensity changes phrasing, never facts
// ---------------------------------------------------------------------------

const PHRASE: Record<Intensity, {
  missedOne: (s: string, d: number) => string;
  behind: (n: number) => string;
  pattern: (n: number, w: number) => string;
  onTrack: string;
}> = {
  gentle: {
    missedOne: (s, d) =>
      `"${s}" hasn't happened yet — it was due ${d === 1 ? "yesterday" : `${d} days ago`}.`,
    behind: (n) => `Your rhythm is about ${n} session${n === 1 ? "" : "s"} behind the plan.`,
    pattern: (n, w) => `This has come up ${n} times in the last ${w} days.`,
    onTrack: "You're on track with what you committed to.",
  },
  direct: {
    missedOne: (s, d) =>
      `You committed to "${s}" ${d === 1 ? "yesterday" : `${d} days ago`}. It hasn't happened.`,
    behind: (n) => `You are ${n} session${n === 1 ? "" : "s"} behind the plan you set.`,
    pattern: (n, w) => `This is the ${ordinal(n)} time in ${w} days.`,
    onTrack: "Commitments and reality match. No change indicated.",
  },
  firm: {
    missedOne: (s, d) =>
      `"${s}" was committed to ${d === 1 ? "yesterday" : `${d} days ago`} and has not been done.`,
    behind: (n) =>
      `The plan is ${n} session${n === 1 ? "" : "s"} short. That gap is real and it is not closing itself.`,
    pattern: (n, w) =>
      `This commitment has now been missed ${n} times in ${w} days. The pattern warrants review.`,
    onTrack: "Commitments and reality match. Nothing to raise.",
  },
};

function ordinal(n: number): string {
  if (n === 1) return "first";
  if (n === 2) return "second";
  if (n === 3) return "third";
  return `${n}th`;
}

const REASON_LABEL: Record<string, string> = {
  forgot: "forgotten",
  chose_not_to: "deliberately not done",
  circumstance: "prevented by circumstance",
  unclear_task: "blocked because the task was unclear",
  no_reason_given: "no reason recorded",
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function accountabilitySettings(): Promise<AccountabilitySettings> {
  const [row] = await db.select().from(collegeAccountabilitySettings).limit(1);
  if (!row) return DEFAULT_ACCOUNTABILITY;
  const intensity = (["gentle", "direct", "firm"] as const).includes(row.intensity as Intensity)
    ? (row.intensity as Intensity)
    : "direct";
  return {
    intensity,
    patternWindowDays: row.patternWindowDays ?? DEFAULT_ACCOUNTABILITY.patternWindowDays,
    patternThreshold: row.patternThreshold ?? DEFAULT_ACCOUNTABILITY.patternThreshold,
  };
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

function conditionFor(
  status: string,
  daysUntilDue: number | null,
  missedReasonKind: string,
  settled: boolean
): string {
  if (settled) {
    return "Reviewed and left as it stands. No change indicated.";
  }
  switch (status) {
    case "completed":
      return "Completed and recorded.";
    case "cancelled":
      return "Cancelled deliberately. That is a decision, not a failure.";
    case "deferred":
      return "Deferred deliberately. The commitment still stands; the date moved.";
    case "partial":
      return "Partially done. Recorded as it happened, not rounded up or down.";
    case "missed": {
      const why = REASON_LABEL[missedReasonKind] ?? "no reason recorded";
      return `Recorded as missed (${why}). This is context, not a verdict.`;
    }
    default:
      if (daysUntilDue === null) return "Open, with no dated expectation.";
      if (daysUntilDue < 0) {
        return `Due ${Math.abs(daysUntilDue)} day(s) ago with nothing recorded. The College does not assume why.`;
      }
      if (daysUntilDue === 0) return "Due today.";
      return `Due in ${daysUntilDue} day(s).`;
  }
}

/**
 * Resolve accountability state.
 *
 * Read-only. It never marks a commitment missed on the student's behalf: an
 * overdue commitment with nothing recorded is reported as exactly that, and
 * remains `open` until someone says what happened. Inferring "missed" from the
 * clock would be the same mistake as inferring session completion from it.
 */
export async function accountabilityState(
  now: Date = new Date()
): Promise<AccountabilityState> {
  const today = brisbaneToday(now);
  const settings = await accountabilitySettings();

  const windowStart = (() => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - settings.patternWindowDays);
    return d.toISOString().slice(0, 10);
  })();

  const rows = await db
    .select({
      c: collegeCommitments,
      goalTitle: collegeGoals.title,
    })
    .from(collegeCommitments)
    .leftJoin(collegeGoals, eq(collegeGoals.id, collegeCommitments.goalId))
    .where(eq(collegeCommitments.active, true))
    .orderBy(desc(collegeCommitments.dueDate));

  const commitments: CommitmentView[] = rows.map(({ c, goalTitle }) => {
    const daysUntilDue =
      c.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(c.dueDate)
        ? daysBetween(today, c.dueDate)
        : null;
    const settled =
      Boolean(c.lastReviewedAt) &&
      Boolean(c.reviewAfter) &&
      c.reviewAfter! > today;
    const overdue =
      c.status === "open" && daysUntilDue !== null && daysUntilDue < 0 && !settled;

    return {
      id: c.id,
      statement: c.statement,
      commitmentType: c.commitmentType,
      status: c.status,
      dueDate: c.dueDate,
      plannedMinutes: c.plannedMinutes,
      actualMinutes: c.actualMinutes,
      goalId: c.goalId,
      goalTitle: goalTitle ?? null,
      missedReasonKind: c.missedReasonKind,
      missedReason: c.missedReason,
      origin: c.origin,
      daysUntilDue,
      condition: conditionFor(c.status, daysUntilDue, c.missedReasonKind, settled),
      overdue,
      settled,
    };
  });

  // Counts are taken over the pattern window, so "this week" means something.
  const inWindow = commitments.filter(
    (c) => !c.dueDate || c.dueDate >= windowStart
  );

  const completed = inWindow.filter((c) => c.status === "completed").length;
  const missed = inWindow.filter((c) => c.status === "missed").length;
  const deferred = inWindow.filter((c) => c.status === "deferred").length;
  const cancelled = inWindow.filter((c) => c.status === "cancelled").length;
  const open = inWindow.filter((c) => c.status === "open").length;
  const made = inWindow.length;

  const planned = inWindow.reduce((n, c) => n + (c.plannedMinutes ?? 0), 0);
  const actual = inWindow.reduce((n, c) => n + (c.actualMinutes ?? 0), 0);

  // Rhythm: only meaningful where dated commitments exist to be behind of.
  const datedDue = inWindow.filter(
    (c) => c.dueDate && c.daysUntilDue !== null && c.daysUntilDue <= 0
  );
  const rhythmDelta = datedDue.length
    ? datedDue.filter((c) => c.status === "completed" || c.status === "partial").length -
      datedDue.length
    : null;

  const rhythmNote =
    rhythmDelta === null
      ? "No dated commitments have come due, so there is no rhythm to be ahead or behind of."
      : rhythmDelta === 0
        ? "Every commitment that came due was accounted for."
        : PHRASE[settings.intensity].behind(Math.abs(rhythmDelta));

  const overdueList = commitments.filter((c) => c.overdue);
  const dueToday = commitments.filter((c) => c.daysUntilDue === 0 && c.status === "open");

  // ---- patterns ----------------------------------------------------------
  // A pattern is repetition of the SAME commitment statement being missed. It
  // is named, counted, and explicitly not acted upon.
  const patterns: AccountabilityPattern[] = [];
  const missedInWindow = commitments.filter(
    (c) => c.status === "missed" && (!c.dueDate || c.dueDate >= windowStart)
  );
  const byStatement = new Map<string, CommitmentView[]>();
  for (const c of missedInWindow) {
    const key = c.statement.trim().toLowerCase();
    byStatement.set(key, [...(byStatement.get(key) ?? []), c]);
  }
  for (const [, group] of byStatement) {
    if (group.length < settings.patternThreshold) continue;
    patterns.push({
      what: group[0].statement,
      occurrences: group.length,
      windowDays: settings.patternWindowDays,
      statedReasons: [
        ...new Set(
          group
            .map((g) => g.missedReason || REASON_LABEL[g.missedReasonKind] || "")
            .filter(Boolean)
        ),
      ],
      response:
        "The College is not changing the objective. The pattern is recorded so today's class can address the gap directly, and so the founder can decide whether the commitment itself was the wrong shape.",
    });
  }

  // ---- headline ----------------------------------------------------------
  const P = PHRASE[settings.intensity];
  let summary: string;
  if (made === 0) {
    summary = "No commitments have been made. Nothing to hold you to.";
  } else if (overdueList.length === 1) {
    const c = overdueList[0];
    summary = P.missedOne(c.statement, Math.abs(c.daysUntilDue ?? 0));
  } else if (overdueList.length > 1) {
    summary = `${overdueList.length} commitments are past their date with nothing recorded.`;
  } else if (rhythmDelta !== null && rhythmDelta < 0) {
    summary = P.behind(Math.abs(rhythmDelta));
  } else {
    summary = P.onTrack;
  }

  const quiet =
    overdueList.length === 0 && patterns.length === 0 && (rhythmDelta ?? 0) >= 0;

  return {
    made,
    completed,
    missed,
    deferred,
    cancelled,
    open,
    plannedMinutes: planned || null,
    actualMinutes: actual || null,
    rhythmDelta,
    rhythmNote,
    commitments,
    overdue: overdueList,
    dueToday,
    patterns,
    quiet,
    summary,
    settings,
    note:
      "The College records what was committed and what happened. It does not conclude that the student is failing, and it never moves a goal to make the numbers look better.",
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderAccountability(a: AccountabilityState): string {
  const L: string[] = [];
  L.push("ACCOUNTABILITY");
  L.push(`  ${a.summary}`);
  if (a.made > 0) {
    L.push(
      `  ${a.completed} / ${a.made} completed · ${a.missed} missed · ${a.deferred} deferred · ${a.open} open`
    );
    L.push(`  ${a.rhythmNote}`);
  }
  for (const c of a.overdue.slice(0, 5)) {
    L.push(`  · ${c.statement} — ${c.condition}`);
  }
  for (const p of a.patterns) {
    L.push("");
    L.push("PATTERN DETECTED");
    L.push(`  "${p.what}" — ${p.occurrences} times in ${p.windowDays} days.`);
    if (p.statedReasons.length) L.push(`  Stated: ${p.statedReasons.join("; ")}`);
    L.push(`  ${p.response}`);
  }
  return L.join("\n");
}
