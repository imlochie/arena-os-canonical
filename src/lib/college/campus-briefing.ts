// ============================================================================
// Lochie Life College — LAYER 7, part 3: THE CAMPUS BRIEFING / ARRIVAL RUNTIME
// ============================================================================
// This sits ABOVE the class runtime, not inside it:
//
//        COLLEGE STATE → TEMPORAL STATE → CAMPUS BRIEFING → BEGIN CLASS
//                                                             ↓
//                                                      CLASS PREFLIGHT
//                                                             ↓
//                                    MEMORY → ATTENTION → COORDINATION
//                                                             ↓
//                                                          TEACHING
//                                                             ↓
//                                                     RECORD → AUDIT
//
// The old briefing failed because it asked "generate an interesting daily
// summary". This one asks a different question entirely:
//
//   "Resolve my current institutional state at this exact point in time,
//    determine what has changed since I was last here, determine whether that
//    changes today's operating context, and present the result before handing
//    me into the appropriate class runtime."
//
// Consequences of that difference, all enforced below:
//
//   · THE BRIEFING IS COMPUTED, NOT GENERATED. Every field is derived from
//     recorded state. No model runs here. Nothing in this file calls the AI
//     abstraction, so the briefing cannot hallucinate an institution.
//
//   · IT CHANGES BEHAVIOUR WITH ELAPSED TIME. A three-week absence does not
//     get the same briefing as a Tuesday. The College does not throw itself
//     at a returning student.
//
//   · "NOTHING MATERIALLY CHANGED" IS A VALID BRIEFING. Short is a correct
//     answer. Manufacturing content to look useful is the original failure.
//
//   · IT NEVER MUTATES. Arrival is not an institutional act. The briefing
//     opens nothing, closes nothing, and files nothing.
// ============================================================================

import { and, desc, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { collegeEventLedger, collegeSessions } from "@/db/college";
import { accountabilityState, type AccountabilityState } from "./accountability";
import { externalAcademicPicture, type ExternalAcademicPicture } from "./external-academic";
import { governanceQueue, type GovernanceItem } from "./governance";
import { liveCollegeState, type LiveCollegeState } from "./live-state";
import {
  resolveTemporalState,
  type ContinuityState,
  type TemporalState,
} from "./temporal-state";
import { brisbaneLongDate, dayName } from "./time";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface BriefingChange {
  /** What happened. */
  what: string;
  /** When, as an ISO date. */
  when: string;
  /** Where it came from, so the student can go and look. */
  source: string;
  /** Whether this is a material change or routine activity. */
  material: boolean;
}

export type BriefingDepth =
  | "none"
  | "quick_orientation"
  | "what_changed"
  | "reconstruct_continuity"
  | "re_entry";

export interface CampusBriefing {
  /** WHERE ARE WE — the clock, the calendar position, the live state. */
  where: {
    longDate: string;
    dayName: string;
    time: string;
    timezone: string;
    currentActivity: string;
    nextActivity: string | null;
  };
  /** The measured temporal position. First-class, never buried in a prompt. */
  temporal: TemporalState;
  /** WHAT CHANGED since the student was last here. */
  changed: {
    since: string | null;
    items: BriefingChange[];
    materialCount: number;
    /** Plain statement, including "nothing material changed". */
    summary: string;
  };
  /**
   * ACCOUNTABILITY — what was committed to, and what happened. Sits beside
   * the other sections rather than above them: the College notices, it does
   * not preside.
   */
  accountability: AccountabilityState;
  /** WHAT MATTERS — only things with a real basis for mattering today. */
  matters: {
    external: ExternalAcademicPicture;
    governance: GovernanceItem[];
    conditions: string[];
    /** True when there is genuinely nothing requiring the founder. */
    quiet: boolean;
  };
  /** WHAT'S NEXT — the handoff into the class runtime. */
  next: {
    /**
     * Whether a *class* can begin now. Deliberately narrower than "something
     * is on the timetable": 75 of 77 slots are recovery, relationship, health
     * and household time. Offering BEGIN CLASS over "Time with Kirra" would be
     * the College claiming authority over a life it does not run.
     */
    classAvailable: boolean;
    /** Whether the current slot is scheduled life, not academic work. */
    lifeActivity: boolean;
    title: string | null;
    courseId: string | null;
    startTime: string | null;
    activityType: string | null;
    /** What the briefing recommends — never what it will do on its own. */
    handoff: string;
  };
  /** How the briefing decided to behave, and why. */
  behaviour: {
    depth: BriefingDepth;
    continuity: ContinuityState;
    reason: string;
    /** The instruction the briefing gives itself. Inspectable, not hidden. */
    directive: string;
  };
  note: string;
}

// ---------------------------------------------------------------------------
// Depth — elapsed time decides how much briefing is appropriate
// ---------------------------------------------------------------------------

const DEPTH_FOR: Record<ContinuityState, BriefingDepth> = {
  no_history: "none",
  normal: "quick_orientation",
  short_absence: "what_changed",
  extended_absence: "reconstruct_continuity",
  long_absence: "re_entry",
};

const DIRECTIVE: Record<BriefingDepth, string> = {
  none:
    "There is no recorded history. Say so plainly and offer to begin. Do not invent a past.",
  quick_orientation:
    "Continuity is intact. Orient in a sentence or two and hand off. Do not re-explain what the student already holds.",
  what_changed:
    "A short gap. Lead with what changed; skip anything that did not. Stay brief.",
  reconstruct_continuity:
    "Rebuild the picture: where the curriculum stands, what was last taught, what remains open. Do not assume retained context.",
  re_entry:
    "The student is returning, not continuing. Establish where the College is before proposing anything. Do not open with obligations or a backlog.",
};

/**
 * Which ledger events constitute a MATERIAL change — something that altered
 * the institution, as opposed to routine activity that merely happened.
 *
 * A class running is activity. A curriculum changing is material. The
 * distinction is what lets the briefing honestly say "nothing material
 * changed" after a week of ordinary classes, instead of padding.
 */
const MATERIAL_EVENTS = new Set([
  "curriculum_change",
  "decision_recorded",
  "timetable_override",
  "memory_promoted",
  "record_filed",
  "goal_addressed",
  "objective_demonstrated",
  "audit_recorded",
  "real_world_context_added",
  "real_world_interruption",
  "external_academic_event",
]);

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

/**
 * Build the arrival briefing.
 *
 * Read-only by construction: it composes Layer 6's live state, Layer 7's
 * temporal state, the external picture and the governance queue. It does not
 * write, and it does not run a model.
 */
export async function campusBriefing(now: Date = new Date()): Promise<CampusBriefing> {
  const [temporal, live, external, governance, accountability] = await Promise.all([
    resolveTemporalState(now),
    liveCollegeState(now),
    externalAcademicPicture(now),
    governanceQueue(),
    accountabilityState(now),
  ]);

  const depth = DEPTH_FOR[temporal.continuity.state];

  // ---- WHAT CHANGED ------------------------------------------------------
  // The window is the student's actual absence, not an arbitrary "last 7 days".
  const since =
    temporal.sinceLastInteraction.since ??
    temporal.sinceLastCollegeSession.since ??
    null;

  const changeRows = since
    ? await db
        .select({
          date: collegeEventLedger.date,
          eventType: collegeEventLedger.eventType,
          summary: collegeEventLedger.summary,
        })
        .from(collegeEventLedger)
        .where(gte(collegeEventLedger.date, since))
        .orderBy(desc(collegeEventLedger.date))
        .limit(200)
    : [];

  const items: BriefingChange[] = changeRows
    .filter((r) => MATERIAL_EVENTS.has(r.eventType))
    .map((r) => ({
      what: r.summary || r.eventType.replace(/_/g, " "),
      when: r.date,
      source: `event ledger · ${r.eventType}`,
      material: true,
    }));

  // Deduplicate identical summaries on the same day — repetition is noise,
  // and a briefing that lists the same fact nine times is not informative.
  const seen = new Set<string>();
  const deduped = items.filter((i) => {
    const k = `${i.when}|${i.what}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const materialCount = deduped.length;
  const changedSummary =
    !since
      ? "No prior visit is recorded, so there is no window to compare against."
      : materialCount === 0
        ? "Nothing material changed while you were away. Ordinary activity may have continued; none of it altered the institution."
        : `${materialCount} material change(s) since ${since}.`;

  // ---- WHAT MATTERS ------------------------------------------------------
  const actionable = governance.items.filter((g) => !g.informationalOnly);
  const conditions: string[] = [];

  for (const a of live.alerts ?? []) {
    conditions.push(a.detail ? `${a.title} — ${a.detail}` : a.title);
  }
  for (const g of temporal.goals) {
    if (g.underTimePressure) conditions.push(`${g.title} — ${g.condition}`);
  }
  if (external.imminent.length) {
    conditions.push(external.implication);
  }
  // Accountability speaks only when it has something factual to report. A
  // quiet week produces no line at all rather than a reassurance nobody asked
  // for — "you're doing great!" is exactly the padding this College refuses.
  // NOTE: the accountability SUMMARY is deliberately NOT copied in here. It
  // already has its own section, and repeating it made the briefing state the
  // same fact twice in twenty lines — which is how a briefing starts feeling
  // like nagging even when every individual sentence is fair.
  // Patterns are different: a pattern is a distinct observation about
  // repetition, not a restatement of today's position.
  for (const p of accountability.patterns) {
    conditions.push(
      `Pattern: "${p.what}" missed ${p.occurrences} times in ${p.windowDays} days. ${p.response}`
    );
  }
  // NOT here. `temporal.unmeasured` is an epistemic footnote — "the College
  // has never recorded an external academic event" is true and worth being
  // able to see, but it is not a thing that MATTERS TODAY. Promoting it into
  // WORTH KNOWING meant a College with nothing to report still produced a
  // bulleted list, which is exactly the padding this briefing exists to avoid.
  // It stays available on `temporal.unmeasured` for anyone who looks.

  const quiet =
    actionable.length === 0 && conditions.length === 0 && accountability.quiet;

  // ---- WHAT'S NEXT -------------------------------------------------------
  // The briefing REPORTS what is available. It never begins a class: that is
  // the student's act, and Layer 6's preflight is where it is validated.
  const current = live.current;
  // "activity" is a genuine timetable position too — §L4 required life,
  // health and household activities to be first-class, not lesser slots.
  // SLOT ≠ CLASS. A timetable position exists for almost every waking hour,
  // but only academic positions are something the College may invite you to
  // *begin*. Everything else — recovery, relationship, health, household — is
  // scheduled life the College observes and stays out of. Conflating the two
  // would have the Campus offering BEGIN CLASS over time with Kirra.
  const activityType =
    (current as { activityType?: string | null }).activityType ?? null;
  const scheduledNow = current.kind === "class" || current.kind === "activity";
  const hasClass =
    scheduledNow && (current.kind === "class" || activityType === "academic");
  const lifeActivity = scheduledNow && !hasClass;
  const nextTitle = live.next?.title ?? null;

  let handoff: string;
  if (hasClass) {
    handoff =
      `"${current.title}" is the current timetable position. Begin when ready — preflight will validate it.`;
  } else if (lifeActivity) {
    // Reported, not managed. No invitation, no nudge, no suggestion that the
    // time would be better spent studying.
    handoff = `"${current.title}" is scheduled now. That is not College time — nothing is being asked of you here.`;
  } else if (live.next) {
    handoff = `Nothing is scheduled right now. Next is "${live.next.title}" at ${live.next.startTime}.`;
  } else {
    handoff = "Nothing is scheduled for the rest of today. An unscheduled session can still be run deliberately.";
  }

  return {
    where: {
      longDate: brisbaneLongDate(now),
      dayName: dayName(temporal.now.dayOfWeek),
      time: temporal.now.time,
      timezone: temporal.now.timezone,
      currentActivity: current.title,
      nextActivity: nextTitle,
    },
    temporal,
    changed: { since, items: deduped, materialCount, summary: changedSummary },
    accountability,
    matters: { external, governance: actionable, conditions, quiet },
    next: {
      classAvailable: hasClass,
      lifeActivity,
      title: hasClass ? current.title : null,
      courseId: (current as { courseId?: string | null }).courseId ?? null,
      startTime: current.startTime || null,
      activityType,
      handoff,
    },
    behaviour: {
      depth,
      continuity: temporal.continuity.state,
      reason: temporal.continuity.reason,
      directive: DIRECTIVE[depth],
    },
    note:
      "Computed from recorded state, not generated. The briefing reports; it does not open, close, reschedule or file anything.",
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderBriefing(b: CampusBriefing): string {
  const L: string[] = [];
  L.push(`CAMPUS BRIEFING — ${b.where.longDate}`);
  L.push(`${b.where.time} ${b.where.timezone}`);
  L.push("");

  // Time since last meaningful interaction is FIRST, deliberately. If it is
  // visible, the College can be reasoned about; if it is buried in a context
  // blob, we are back to the black-box briefing.
  L.push(
    `LAST HERE — ${b.temporal.sinceLastInteraction.label}` +
      (b.temporal.sinceLastInteraction.since ? ` (${b.temporal.sinceLastInteraction.since})` : "")
  );
  L.push(`CONTINUITY — ${b.behaviour.continuity.toUpperCase().replace(/_/g, " ")}`);
  L.push(`  ${b.behaviour.reason}`);
  L.push("");

  L.push("WHERE ARE WE");
  L.push(`  ${b.where.currentActivity}`);
  if (b.where.nextActivity) L.push(`  next — ${b.where.nextActivity}`);
  L.push("");

  L.push("WHAT CHANGED");
  L.push(`  ${b.changed.summary}`);
  for (const c of b.changed.items.slice(0, 8)) {
    L.push(`  · ${c.when}  ${c.what}`);
  }
  if (b.changed.items.length > 8) {
    L.push(`  … and ${b.changed.items.length - 8} more in the ledger.`);
  }
  L.push("");

  if (!b.accountability.quiet || b.accountability.made > 0) {
    L.push("ACCOUNTABILITY");
    L.push(`  ${b.accountability.summary}`);
    if (b.accountability.made > 0) {
      L.push(
        `  ${b.accountability.completed} / ${b.accountability.made} completed · ${b.accountability.rhythmNote}`
      );
    }
    L.push("");
  }

  L.push("WHAT MATTERS");
  if (b.matters.quiet) {
    L.push("  Nothing requires a decision. NO CHANGE INDICATED.");
  } else {
    for (const g of b.matters.governance) {
      L.push(`  · [${g.authorityRequired}] ${g.what}`);
    }
    for (const c of b.matters.conditions) L.push(`  · ${c}`);
  }
  L.push("");

  if (b.matters.external.known) {
    L.push("EXTERNAL ACADEMIC");
    for (const c of b.matters.external.commitments) {
      L.push(`  ${c.provider} — ${c.title} [${c.status}]`);
      L.push(`    ${c.condition}`);
    }
    L.push("");
  }

  L.push("WHAT'S NEXT");
  L.push(`  ${b.next.handoff}`);
  L.push("");
  L.push(`BRIEFING BEHAVIOUR — ${b.behaviour.depth.replace(/_/g, " ")}`);
  L.push(`  ${b.behaviour.directive}`);

  return L.join("\n");
}
