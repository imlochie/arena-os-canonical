// ============================================================================
// Lochie Life College — Effectiveness, audit & stability (SERVER ONLY)
// ============================================================================
// "Do not optimise the College by default. Make the College observable,
//  understandable, and governable."
//
// The purpose of this module is UNDERSTANDING, not perpetual optimisation.
// It is built to be able to conclude:
//
//     "Yes. It appears to be working. No meaningful problem identified.
//      Keep it as it is."
//
// and to treat that as a successful audit.
//
// Guard rails encoded here:
//   · never collapse effectiveness into a single score
//   · never claim causation from a before/after boundary
//   · never treat a real-world interruption as a schedule failure
//   · never recommend change on insufficient evidence
//   · never reopen a settled KEEP AS IS before its review date
// ============================================================================

import { db } from "@/db";
import {
  collegeAuditThresholds,
  collegeAudits,
  collegeContextSignals,
  collegeDeviations,
  collegeFormativeEvidence,
  collegeGoals,
  collegeIntents,
  collegeSessions,
  collegeTimetableInstances,
  collegeTimetableTemplateSlots,
} from "@/db/college";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { brisbaneToday, addDays, daysBetween } from "./time";
import * as ledger from "./ledger";

// ---------------------------------------------------------------------------
// Dimensions — evidence categories, deliberately NOT weighted into a score
// ---------------------------------------------------------------------------

export type DimensionStatus =
  | "present"
  | "absent"
  | "mixed"
  | "insufficient_evidence"
  | "not_applicable";

export interface AuditDimension {
  key: string;
  label: string;
  status: DimensionStatus;
  /** Plain observation. Never a verdict. */
  observation: string;
  /** Raw counts so the founder can check the reasoning. */
  evidence: Record<string, number | string>;
}

export type AuditStatus =
  | "stable"
  | "improving"
  | "deteriorating"
  | "changed"
  | "uncertain"
  | "insufficient_evidence";

export type AuditDecision = "keep_as_is" | "investigate" | "propose_change" | "no_decision";

export interface AuditThresholds {
  minObservations: number;
  minWeeks: number;
  deviationsBeforeReview: number;
  reviewIntervalDays: number;
}

const DEFAULT_THRESHOLDS: AuditThresholds = {
  minObservations: 4,
  minWeeks: 3,
  deviationsBeforeReview: 3,
  reviewIntervalDays: 28,
};

export async function getThresholds(
  scopeType: string,
  scopeId?: string | null
): Promise<AuditThresholds> {
  const rows = await db
    .select()
    .from(collegeAuditThresholds)
    .where(eq(collegeAuditThresholds.scopeType, scopeType));
  const specific = scopeId ? rows.find((r) => r.scopeId === scopeId) : undefined;
  const general = rows.find((r) => !r.scopeId);
  const chosen = specific ?? general;
  if (!chosen) return DEFAULT_THRESHOLDS;
  return {
    minObservations: chosen.minObservations,
    minWeeks: chosen.minWeeks,
    deviationsBeforeReview: chosen.deviationsBeforeReview,
    reviewIntervalDays: chosen.reviewIntervalDays,
  };
}

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export async function setIntent(input: {
  subjectType: string;
  subjectId?: string | null;
  subjectKey?: string;
  statement: string;
  intentKind?: "goal" | "plan" | "experiment";
  reviewAfterDays?: number | null;
  reason?: string;
}) {
  // A new intent supersedes rather than overwrites — historical audits must
  // not be re-judged against a goal that did not exist at the time.
  const existing = await db
    .select()
    .from(collegeIntents)
    .where(
      and(
        eq(collegeIntents.subjectType, input.subjectType),
        eq(collegeIntents.active, true),
        input.subjectId
          ? eq(collegeIntents.subjectId, input.subjectId)
          : eq(collegeIntents.subjectKey, input.subjectKey ?? "")
      )
    );

  for (const e of existing) {
    await db.update(collegeIntents).set({ active: false }).where(eq(collegeIntents.id, e.id));
  }

  const [row] = await db
    .insert(collegeIntents)
    .values({
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      subjectKey: (input.subjectKey ?? "").slice(0, 200),
      statement: input.statement.slice(0, 4000),
      intentKind: input.intentKind ?? "plan",
      reviewAfterDays: input.reviewAfterDays ?? null,
      supersedesId: existing[0]?.id ?? null,
      reason: (input.reason ?? "").slice(0, 2000),
    })
    .returning();
  return row;
}

export async function getIntent(subjectType: string, subjectId?: string | null, subjectKey?: string) {
  const rows = await db
    .select()
    .from(collegeIntents)
    .where(and(eq(collegeIntents.subjectType, subjectType), eq(collegeIntents.active, true)))
    .orderBy(desc(collegeIntents.createdAt));
  if (subjectId) return rows.find((r) => r.subjectId === subjectId) ?? null;
  if (subjectKey) return rows.find((r) => r.subjectKey === subjectKey) ?? null;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Slot audit
// ---------------------------------------------------------------------------

export interface AuditReport {
  scopeType: string;
  scopeId: string | null;
  scopeLabel: string;
  period: { start: string; end: string };
  intent: { statement: string; kind: string } | null;
  structure: string;
  dimensions: AuditDimension[];
  contextualFactors: string[];
  auditStatus: AuditStatus;
  interpretation: string;
  recommendation: string;
  evidenceQuality: "strong" | "moderate" | "limited" | "insufficient";
  /** Why the audit is or is not entitled to draw a conclusion. */
  sufficiency: string;
  comparable: boolean;
  /** How many discrete observations this report rests on. */
  observations: number;
}

/**
 * Audit a recurring timetable slot against its INTENT — not against a
 * theoretical optimum.
 */
export async function auditSlot(
  slotId: string,
  periodStart: string,
  periodEnd: string
): Promise<AuditReport> {
  const [slot] = await db
    .select()
    .from(collegeTimetableTemplateSlots)
    .where(eq(collegeTimetableTemplateSlots.id, slotId))
    .limit(1);

  const label = slot ? slot.title : "Unknown slot";
  const intent = await getIntent("slot", slotId);
  const thresholds = await getThresholds("slot", slotId);

  const instances = await db
    .select()
    .from(collegeTimetableInstances)
    .where(
      and(
        eq(collegeTimetableInstances.slotId, slotId),
        gte(collegeTimetableInstances.date, periodStart),
        lte(collegeTimetableInstances.date, periodEnd)
      )
    )
    .orderBy(asc(collegeTimetableInstances.date));

  const deviations = await db
    .select()
    .from(collegeDeviations)
    .where(eq(collegeDeviations.slotId, slotId));

  const signals = await db
    .select()
    .from(collegeContextSignals)
    .where(eq(collegeContextSignals.active, true));

  const occurred = instances.filter((i) => i.runtimeStatus === "completed").length;
  const missed = instances.filter((i) => i.runtimeStatus === "missed").length;
  const cancelled = instances.filter((i) => i.runtimeStatus === "cancelled").length;
  const unknown = instances.filter((i) => i.runtimeStatus === "unknown" || i.runtimeStatus === "scheduled").length;

  // A missed session with a real-world explanation is NOT a schedule failure.
  const explainedMisses = deviations.filter((d) =>
    ["appointment", "work", "travel", "household", "availability"].some((k) =>
      `${d.observedState} ${d.deviationType}`.toLowerCase().includes(k)
    )
  ).length;

  const weeksCovered = Math.max(1, Math.ceil(daysBetween(periodStart, periodEnd) / 7));
  const sufficientEvidence =
    instances.length >= thresholds.minObservations && weeksCovered >= thresholds.minWeeks;

  const dimensions: AuditDimension[] = [
    {
      key: "attendance",
      label: "Attendance",
      status: instances.length === 0 ? "insufficient_evidence" : occurred > 0 ? "present" : "absent",
      observation:
        instances.length === 0
          ? "No instances recorded for this period."
          : `${occurred} of ${instances.length} recorded instance(s) completed.`,
      evidence: { instances: instances.length, completed: occurred, missed, cancelled, unrecorded: unknown },
    },
    {
      key: "consistency",
      label: "Consistency",
      status: !sufficientEvidence
        ? "insufficient_evidence"
        : occurred >= instances.length - 1
          ? "present"
          : "mixed",
      observation: !sufficientEvidence
        ? `Needs at least ${thresholds.minObservations} instances across ${thresholds.minWeeks} weeks before consistency can be assessed. Currently ${instances.length} across ~${weeksCovered}.`
        : `Completed ${occurred} of ${instances.length} over ~${weeksCovered} week(s).`,
      evidence: { weeks: weeksCovered, required: thresholds.minObservations },
    },
    {
      key: "goal_alignment",
      label: "Goal alignment",
      status: intent ? "present" : "insufficient_evidence",
      observation: intent
        ? `Evaluated against the recorded intent: "${intent.statement}"`
        : "No intent recorded for this slot. Without a stated purpose, effectiveness cannot be judged — only activity can be counted.",
      evidence: { intentKind: intent?.intentKind ?? "none" },
    },
    {
      key: "friction",
      label: "Friction",
      status: deviations.length === 0 ? "absent" : explainedMisses >= deviations.length ? "not_applicable" : "present",
      observation:
        deviations.length === 0
          ? "No recorded deviations."
          : explainedMisses >= deviations.length
            ? `${deviations.length} deviation(s), all attributable to real-world circumstances rather than the structure itself.`
            : `${deviations.length} deviation(s), of which ${deviations.length - explainedMisses} are not explained by recorded real-world context.`,
      evidence: { deviations: deviations.length, explained: explainedMisses },
    },
    {
      key: "sustainability",
      label: "Sustainability",
      status: !sufficientEvidence ? "insufficient_evidence" : "present",
      observation: !sufficientEvidence
        ? "Too early to say whether this structure can realistically continue."
        : "The structure has persisted across the period without recorded structural friction.",
      evidence: { activeSignals: signals.length },
    },
  ];

  // Real-world context comes from two places: declared context signals, and
  // the institutional timeline. The ledger is the more reliable of the two
  // because it was written as things happened, not reconstructed afterwards.
  const ledgerContext = await ledger.range({
    from: periodStart,
    to: periodEnd,
    slotId,
    eventTypes: ["real_world_interruption", "class_shortened", "timetable_override"],
  });

  const contextualFactors = [
    ...signals.slice(0, 8).map((s) => `${s.signalType}: ${s.content}`.slice(0, 200)),
    ...ledgerContext.slice(0, 8).map((e: { date: string; eventType: string; summary: string }) => `${e.date} ${e.eventType}: ${e.summary}`.slice(0, 200)),
  ];

  // ---- Status + recommendation -------------------------------------------
  let auditStatus: AuditStatus = "insufficient_evidence";
  let interpretation: string;
  let recommendation: string;
  let evidenceQuality: AuditReport["evidenceQuality"] = "insufficient";

  if (!sufficientEvidence) {
    auditStatus = "insufficient_evidence";
    evidenceQuality = instances.length === 0 ? "insufficient" : "limited";
    interpretation = `Not enough has happened yet to say anything meaningful. ${instances.length} recorded instance(s) across roughly ${weeksCovered} week(s); the configured threshold is ${thresholds.minObservations} instances across ${thresholds.minWeeks} weeks.`;
    recommendation = "INSUFFICIENT EVIDENCE. No change indicated. Let it run.";
  } else {
    const unexplainedProblems = deviations.length - explainedMisses;
    const completionRate = instances.length ? occurred / instances.length : 0;

    if (unexplainedProblems >= thresholds.deviationsBeforeReview) {
      auditStatus = "uncertain";
      evidenceQuality = "moderate";
      interpretation = `${unexplainedProblems} deviation(s) are not explained by recorded real-world context. That is a pattern worth looking at, not a verdict.`;
      recommendation = "INVESTIGATE. The pattern may be structural, or the context may simply not have been recorded.";
    } else if (completionRate >= 0.7) {
      auditStatus = "stable";
      evidenceQuality = instances.length >= thresholds.minObservations * 2 ? "strong" : "moderate";
      interpretation = `The structure is being followed. ${
        deviations.length
          ? `The ${deviations.length} deviation(s) recorded are attributable to real-world circumstances rather than the timetable.`
          : "No deviations recorded."
      }`;
      recommendation = "NO CHANGE INDICATED. No meaningful problem identified.";
    } else {
      auditStatus = "uncertain";
      evidenceQuality = "moderate";
      interpretation = `Completion is lower than the recorded instances suggest was intended, but the reasons are not established. ${explainedMisses} of ${deviations.length} deviation(s) have recorded real-world explanations.`;
      recommendation =
        "INVESTIGATE before changing anything. Distinguish a goal problem from an execution problem from a measurement problem from an environmental problem.";
    }
  }

  return {
    scopeType: "slot",
    scopeId: slotId,
    scopeLabel: label,
    period: { start: periodStart, end: periodEnd },
    intent: intent ? { statement: intent.statement, kind: intent.intentKind } : null,
    structure: slot ? `${slot.startTime}–${slot.endTime}` : "",
    dimensions,
    contextualFactors,
    auditStatus,
    interpretation,
    recommendation,
    evidenceQuality,
    sufficiency: sufficientEvidence
      ? `Threshold met: ${instances.length} instance(s) across ~${weeksCovered} week(s).`
      : `Threshold NOT met: needs ${thresholds.minObservations} instance(s) across ${thresholds.minWeeks} week(s).`,
    comparable: true,
    observations: instances.length,
  };
}

/** Audit a course against its intent. */
export async function auditCourse(
  courseId: string,
  periodStart: string,
  periodEnd: string
): Promise<AuditReport> {
  const intent = await getIntent("course", courseId);
  const thresholds = await getThresholds("course", courseId);

  const sessions = await db
    .select()
    .from(collegeSessions)
    .where(eq(collegeSessions.courseId, courseId))
    .orderBy(asc(collegeSessions.createdAt));

  const inPeriod = sessions.filter(
    (s) => (s.observedDate ?? "") >= periodStart && (s.observedDate ?? "") <= periodEnd
  );
  const completed = inPeriod.filter((s) => s.status === "completed").length;

  const evidence = await db
    .select()
    .from(collegeFormativeEvidence)
    .where(eq(collegeFormativeEvidence.courseId, courseId));

  const weeksCovered = Math.max(1, Math.ceil(daysBetween(periodStart, periodEnd) / 7));
  const sufficient = inPeriod.length >= thresholds.minObservations;

  const dimensions: AuditDimension[] = [
    {
      key: "exposure",
      label: "Exposure",
      status: inPeriod.length ? "present" : "absent",
      observation: `${inPeriod.length} session(s) in this period; ${sessions.length} lifetime.`,
      evidence: { inPeriod: inPeriod.length, lifetime: sessions.length },
    },
    {
      key: "completion",
      label: "Completion",
      status: inPeriod.length === 0 ? "insufficient_evidence" : completed ? "present" : "absent",
      observation: `${completed} of ${inPeriod.length} session(s) completed.`,
      evidence: { completed, total: inPeriod.length },
    },
    {
      key: "learning_evidence",
      label: "Learning evidence",
      status: evidence.length === 0 ? "absent" : "present",
      observation: evidence.length
        ? `${evidence.length} formative observation(s) recorded. These are observations of learning, not formal attainment.`
        : "No formative evidence recorded for this course.",
      evidence: { formative: evidence.length },
    },
    {
      key: "continuity",
      label: "Continuity",
      status: !sufficient ? "insufficient_evidence" : "present",
      observation: !sufficient
        ? `Needs ${thresholds.minObservations} session(s) before continuity can be assessed; currently ${inPeriod.length}.`
        : `The course has run across ~${weeksCovered} week(s) in this period.`,
      evidence: { weeks: weeksCovered },
    },
  ];

  const auditStatus: AuditStatus = !sufficient
    ? "insufficient_evidence"
    : completed >= inPeriod.length * 0.7
      ? "stable"
      : "uncertain";

  return {
    scopeType: "course",
    scopeId: courseId,
    scopeLabel: intent?.subjectKey || "Course",
    period: { start: periodStart, end: periodEnd },
    intent: intent ? { statement: intent.statement, kind: intent.intentKind } : null,
    structure: "",
    dimensions,
    contextualFactors: [],
    auditStatus,
    interpretation: !sufficient
      ? `Only ${inPeriod.length} session(s) have occurred in this period. That is not enough to judge the course.`
      : `${completed} of ${inPeriod.length} session(s) completed, with ${evidence.length} formative observation(s).`,
    recommendation: !sufficient
      ? "INSUFFICIENT EVIDENCE. No change indicated."
      : auditStatus === "stable"
        ? "NO CHANGE INDICATED."
        : "INVESTIGATE.",
    evidenceQuality: sufficient ? "moderate" : "insufficient",
    sufficiency: sufficient
      ? "Threshold met."
      : `Threshold NOT met: needs ${thresholds.minObservations} session(s).`,
    comparable: true,
    observations: inPeriod.length,
  };
}

// ---------------------------------------------------------------------------
// Period comparison — never manufactures a winner
// ---------------------------------------------------------------------------

export interface ComparisonRow {
  dimension: string;
  a: string;
  b: string;
  changed: boolean;
}

export interface Comparison {
  a: { start: string; end: string; label: string };
  b: { start: string; end: string; label: string };
  rows: ComparisonRow[];
  conditionsDiffer: string[];
  comparable: boolean;
  interpretation: string;
  causationWarning: string;
}

export async function comparePeriods(input: {
  scopeType: "slot" | "course";
  scopeId: string;
  aStart: string;
  aEnd: string;
  bStart: string;
  bEnd: string;
}): Promise<Comparison> {
  const run = input.scopeType === "slot" ? auditSlot : auditCourse;
  const [a, b] = await Promise.all([
    run(input.scopeId, input.aStart, input.aEnd),
    run(input.scopeId, input.bStart, input.bEnd),
  ]);

  const rows: ComparisonRow[] = [];
  for (const da of a.dimensions) {
    const dbd = b.dimensions.find((x) => x.key === da.key);
    rows.push({
      dimension: da.label,
      a: da.observation,
      b: dbd?.observation ?? "—",
      changed: da.status !== (dbd?.status ?? da.status),
    });
  }

  // Did the underlying conditions change? If so the periods are NOT a clean
  // experiment and must not be presented as one.
  const conditionsDiffer: string[] = [];
  if (a.structure !== b.structure && (a.structure || b.structure)) {
    conditionsDiffer.push(
      `The structure itself differed: "${a.structure || "unset"}" vs "${b.structure || "unset"}".`
    );
  }
  if (a.intent?.statement !== b.intent?.statement) {
    conditionsDiffer.push("The recorded intent differed between the two periods.");
  }
  if (a.contextualFactors.length !== b.contextualFactors.length) {
    conditionsDiffer.push(
      "Different real-world context was active in each period."
    );
  }
  // Unequal or insufficient observation counts. Two periods of very different
  // size are not a like-for-like comparison, however tempting the percentages.
  if (a.observations !== b.observations) {
    conditionsDiffer.push(
      `Different number of observations: ${a.observations} in Period A vs ${b.observations} in Period B. Percentages computed over unequal samples are not directly comparable.`
    );
  }
  if (
    a.auditStatus === "insufficient_evidence" ||
    b.auditStatus === "insufficient_evidence"
  ) {
    const which =
      a.auditStatus === "insufficient_evidence" && b.auditStatus === "insufficient_evidence"
        ? "Neither period"
        : a.auditStatus === "insufficient_evidence"
          ? "Period A"
          : "Period B";
    conditionsDiffer.push(
      `${which} meets the configured evidence threshold. A comparison against a period with insufficient evidence cannot establish a difference.`
    );
  }
  // Different period lengths mean different exposure to disruption.
  const aDays = daysBetween(input.aStart, input.aEnd);
  const bDays = daysBetween(input.bStart, input.bEnd);
  if (Math.abs(aDays - bDays) > 7) {
    conditionsDiffer.push(
      `The periods are different lengths: ${aDays} days vs ${bDays} days.`
    );
  }

  // Versions in force. If the curriculum, timetable or faculty configuration
  // changed between the periods, the two are not the same experiment — and the
  // ledger is what lets us know that without guessing.
  const versionsA = await periodVersions(input.aStart, input.aEnd);
  const versionsB = await periodVersions(input.bStart, input.bEnd);
  for (const [label, va, vb] of [
    ["curriculum version", versionsA.curriculum, versionsB.curriculum],
    ["timetable version", versionsA.timetable, versionsB.timetable],
  ] as const) {
    if (va && vb && va !== vb) {
      conditionsDiffer.push(
        `The ${label} changed between the periods. Behaviour under one version is not directly comparable to another.`
      );
    }
  }
  if (versionsA.facultyChanged || versionsB.facultyChanged) {
    conditionsDiffer.push(
      "Faculty configuration changed during one of the periods. Who was teaching, and how, was not held constant."
    );
  }
  if (versionsA.majorDeviations !== versionsB.majorDeviations) {
    conditionsDiffer.push(
      `Different numbers of recorded deviations: ${versionsA.majorDeviations} vs ${versionsB.majorDeviations}.`
    );
  }

  const comparable = conditionsDiffer.length === 0;
  const anyChange = rows.some((r) => r.changed);

  return {
    a: { start: input.aStart, end: input.aEnd, label: "Period A" },
    b: { start: input.bStart, end: input.bEnd, label: "Period B" },
    rows,
    conditionsDiffer,
    comparable,
    interpretation: !anyChange
      ? "No meaningful difference currently established."
      : comparable
        ? "Some dimensions differ between the periods. The difference is described, not explained."
        : "Some dimensions differ, but the underlying conditions also differed. These two periods are not a clean experiment.",
    causationWarning:
      "Differences between periods are described, never attributed. The College reports what changed after a boundary; it does not claim the boundary caused it.",
  };
}

// ---------------------------------------------------------------------------
// Recording an audit decision
// ---------------------------------------------------------------------------

export async function recordAudit(input: {
  report: AuditReport;
  decision: AuditDecision;
  decisionReason: string;
  decidedBy?: string;
  curriculumVersionId?: string | null;
  timetableVersionId?: string | null;
  comparedPeriod?: { start: string; end: string } | null;
  conditionsNote?: string;
  comparableConditions?: boolean;
  reviewIntervalDays?: number;
}) {
  const thresholds = await getThresholds(input.report.scopeType, input.report.scopeId);
  const interval = input.reviewIntervalDays ?? thresholds.reviewIntervalDays;

  // A settled KEEP AS IS must not be reopened next week.
  const reopenAfter =
    input.decision === "keep_as_is" ? addDays(brisbaneToday(), interval) : null;

  const [row] = await db
    .insert(collegeAudits)
    .values({
      scopeType: input.report.scopeType,
      scopeId: input.report.scopeId,
      scopeLabel: input.report.scopeLabel.slice(0, 200),
      periodStart: input.report.period.start,
      periodEnd: input.report.period.end,
      comparedPeriodStart: input.comparedPeriod?.start ?? "",
      comparedPeriodEnd: input.comparedPeriod?.end ?? "",
      curriculumVersionId: input.curriculumVersionId ?? null,
      timetableVersionId: input.timetableVersionId ?? null,
      conditionsNote: (input.conditionsNote ?? "").slice(0, 2000),
      comparableConditions: input.comparableConditions ?? true,
      dimensions: JSON.stringify(input.report.dimensions),
      evidenceConsidered: JSON.stringify(
        input.report.dimensions.map((d) => ({ key: d.key, evidence: d.evidence }))
      ),
      contextualFactors: JSON.stringify(input.report.contextualFactors),
      auditStatus: input.report.auditStatus,
      interpretation: input.report.interpretation.slice(0, 4000),
      decision: input.decision,
      decisionReason: input.decisionReason.slice(0, 2000),
      decidedBy: (input.decidedBy ?? "founder").slice(0, 120),
      reopenAfter,
    })
    .returning();

  return {
    audit: row,
    note:
      input.decision === "keep_as_is"
        ? `Recorded as an institutional decision. This question will not be reopened before ${reopenAfter}.`
        : "Audit recorded.",
  };
}

/** Is this scope currently settled by a KEEP AS IS decision? */
export async function isSettled(
  scopeType: string,
  scopeId: string
): Promise<{ settled: boolean; until?: string; reason?: string }> {
  const [latest] = await db
    .select()
    .from(collegeAudits)
    .where(and(eq(collegeAudits.scopeType, scopeType), eq(collegeAudits.scopeId, scopeId)))
    .orderBy(desc(collegeAudits.createdAt))
    .limit(1);

  if (!latest || latest.decision !== "keep_as_is" || !latest.reopenAfter) {
    return { settled: false };
  }
  const today = brisbaneToday();
  if (today < latest.reopenAfter) {
    return {
      settled: true,
      until: latest.reopenAfter,
      reason: latest.decisionReason,
    };
  }
  return { settled: false };
}

export async function auditHistory(scopeType?: string, scopeId?: string) {
  if (scopeType && scopeId) {
    return db
      .select()
      .from(collegeAudits)
      .where(and(eq(collegeAudits.scopeType, scopeType), eq(collegeAudits.scopeId, scopeId)))
      .orderBy(desc(collegeAudits.createdAt));
  }
  return db.select().from(collegeAudits).orderBy(desc(collegeAudits.createdAt)).limit(50);
}


/**
 * What was actually in force during a period, according to the ledger.
 * Used to establish whether two periods are genuinely comparable.
 */
async function periodVersions(from: string, to: string) {
  const entries = await ledger.range({ from, to });
  const curriculum = new Set(
    entries.map((e) => e.curriculumVersionId).filter(Boolean) as string[]
  );
  const timetable = new Set(
    entries.map((e) => e.timetableVersionId).filter(Boolean) as string[]
  );
  return {
    curriculum: curriculum.size === 1 ? [...curriculum][0] : curriculum.size ? "mixed" : null,
    timetable: timetable.size === 1 ? [...timetable][0] : timetable.size ? "mixed" : null,
    facultyChanged: entries.some((e) => e.eventType === "faculty_configuration_changed"),
    majorDeviations: entries.filter(
      (e) => e.eventType === "real_world_interruption" || e.eventType === "class_shortened"
    ).length,
  };
}
