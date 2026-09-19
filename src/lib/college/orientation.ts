// ============================================================================
// Lochie Life College — class orientation (SERVER ONLY)
// ============================================================================
// College State as the CONTROL LOOP, not a display. Every College session
// begins here: the runtime answers the institution's standing questions before
// any teaching happens, so a class never has to reconstruct the College for
// itself.
//
//   WHERE ARE WE?            → academic position
//   WHAT SHOULD BE HAPPENING?→ timetable / curriculum
//   WHAT IS ACTUALLY HAPPENING? → observations / real-world context
//   WHAT MATTERS RIGHT NOW?  → goals / objectives
//   WHAT DO WE ALREADY KNOW? → educational memory
//   WHAT DO WE NEED TO LEARN?→ gaps
//   WHO SHOULD ACT?          → faculty composition
//   WHAT MUST BE RECORDED?   → registrar criteria
// ============================================================================

import { db } from "@/db";
import {
  collegeCourseWeeks,
  collegeCourses,
  collegeMemory,
  collegeSessions,
} from "@/db/college";
import { and, desc, eq, sql } from "drizzle-orm";
import { computeCollegeState, type CollegeState } from "./state";
import { getCurrentCurriculum } from "./curriculum";
import { deriveFacultyComposition, getSessionKind } from "./faculty";
import { claimLine } from "./truth";
import { formatIsoDate } from "./time";

export interface Orientation {
  whereAreWe: {
    summary: string;
    conflicted: boolean;
    lines: string[];
  };
  whatShouldBeHappening: {
    summary: string;
    curriculumVersion: string | null;
    course: Record<string, unknown> | null;
    objective: string | null;
    questionOfWeek: string | null;
    known: boolean;
  };
  whatIsActuallyHappening: {
    summary: string;
    contextSignals: string[];
    openDeviations: number;
    lastSession: Record<string, unknown> | null;
  };
  whatMattersNow: { goals: string[]; priorities: string[] };
  whatWeKnow: { established: string[]; hypotheses: string[]; counts: Record<string, number> };
  whatWeNeedToLearn: { gaps: string[]; revisit: string[]; openQuestions: string[] };
  whoShouldAct: Array<{ positionKey: string; reason: string; required: boolean }>;
  whatMustBeRecorded: { criteria: string[]; note: string };
  /** Rendered briefing suitable for injection into a faculty prompt. */
  briefing: string;
  limitations: string[];
}

export async function buildOrientation(opts: {
  courseId?: string | null;
  sessionKind?: string;
  weekIndex?: number | null;
  state?: CollegeState;
}): Promise<Orientation> {
  const state = opts.state ?? (await computeCollegeState());
  const limitations: string[] = [];
  const sessionKind = opts.sessionKind ?? "lesson";

  // ---- WHERE ARE WE ----
  const posLines = [
    claimLine("Term", state.position.term),
    claimLine("Week (calendar-derived)", state.position.derivedWeek),
    claimLine("Week (institutionally recorded)", state.position.declaredWeek),
    claimLine("Week theme", state.position.weekTheme),
  ];
  const conflicted = state.position.effectiveWeek.truthClass === "conflict";
  const whereSummary = conflicted
    ? `Academic position is DISPUTED. ${state.position.effectiveWeek.note ?? ""}`.trim()
    : `Semester position: week ${state.position.effectiveWeek.value ?? "unknown"}.`;
  if (conflicted) {
    limitations.push(
      "The academic week is disputed between the Academic Calendar and Institutional State. Teaching may proceed, but the position must not be asserted as settled."
    );
  }

  // ---- WHAT SHOULD BE HAPPENING ----
  const curriculum = await getCurrentCurriculum();
  let course: Record<string, unknown> | null = null;
  let objective: string | null = null;
  let questionOfWeek: string | null = null;

  if (opts.courseId) {
    const [c] = await db
      .select()
      .from(collegeCourses)
      .where(eq(collegeCourses.id, opts.courseId))
      .limit(1);
    course = (c as unknown as Record<string, unknown>) ?? null;
    const inCurriculum = curriculum.courses.some((cc) => String(cc.id) === opts.courseId);
    if (c && !inCurriculum) {
      limitations.push(
        `${c.code} is not in the active curriculum. It is known to the College but has not been selected into what the College currently teaches.`
      );
    }
    const wk = opts.weekIndex ?? state.position.effectiveWeek.value ?? null;
    if (c && wk) {
      const [cw] = await db
        .select()
        .from(collegeCourseWeeks)
        .where(
          and(eq(collegeCourseWeeks.courseId, c.id), eq(collegeCourseWeeks.weekIndex, Number(wk)))
        )
        .limit(1);
      if (cw) {
        objective = cw.objective || null;
        questionOfWeek = cw.questionOfWeek || null;
      } else {
        limitations.push(`No weekly objective is recorded for ${c.code} week ${wk}.`);
      }
    }
  } else if (curriculum.courses.length === 0) {
    limitations.push(
      "The active curriculum is empty, so the College cannot say what should be taught."
    );
  }

  const shouldSummary = !curriculum.version
    ? "No curriculum version exists."
    : curriculum.courses.length === 0
      ? "Curriculum version exists but contains no courses."
      : `${curriculum.courses.length} course(s) in ${curriculum.version.label}.`;

  // ---- WHAT IS ACTUALLY HAPPENING ----
  const signals = state.context.activeSignals.map(
    (s) => `${String(s.signalType)}: ${String(s.content)}`
  );
  const [lastSession] = await db
    .select()
    .from(collegeSessions)
    .where(sql`${collegeSessions.status} in ('completed','interrupted')`)
    .orderBy(desc(collegeSessions.createdAt))
    .limit(1);

  // ---- WHAT MATTERS NOW ----
  const goals = state.goals.active.map((g) => `${String(g.title)} [${String(g.status)}]`);

  // ---- WHAT WE ALREADY KNOW ----
  const established = state.knowledge.established.map((m) => String(m.content));
  const hypotheses = state.knowledge.hypotheses.map(
    (m) => `${String(m.content)} (corroborated ×${String(m.corroborationCount)})`
  );

  // ---- WHAT WE NEED TO LEARN ----
  const revisit = state.knowledge.revisitQueue.map((m) => String(m.content));
  const openQuestions = state.knowledge.openQuestions.map((m) => String(m.content));
  const gaps: string[] = [];
  if (!objective && opts.courseId) gaps.push("No weekly objective recorded for this course/week.");
  const confusion = await db
    .select()
    .from(collegeMemory)
    .where(
      and(
        eq(collegeMemory.active, true),
        sql`${collegeMemory.memoryType} in ('confusion','misconception','struggle')`
      )
    )
    .orderBy(desc(collegeMemory.updatedAt))
    .limit(5);
  for (const c of confusion) gaps.push(`Known difficulty: ${c.content.slice(0, 160)}`);

  // ---- WHO SHOULD ACT ----
  const composition = deriveFacultyComposition(sessionKind, {
    hasOpenDeviation: state.deviations.count > 0,
    isRevisit: revisit.length > 0,
    needsEvidence: openQuestions.length > 0,
  });

  // ---- WHAT MUST BE RECORDED ----
  const criteria = [
    "A course or progression milestone was reached",
    "An institutional decision was made",
    "A significant learning discovery occurred",
    "Curriculum changed",
    "A goal was created, completed or materially changed",
    "Teaching strategy changed",
    "A previous record needs correcting",
    "A teaching session completed",
  ];

  // ---- rendered briefing ----
  const kind = getSessionKind(sessionKind);
  const briefing = [
    "CLASS ORIENTATION — produced by the College before teaching begins.",
    "",
    "1. WHERE ARE WE?",
    ...posLines.map((l) => `   ${l}`),
    conflicted ? "   !! Position disputed — do not assert it as settled." : "",
    "",
    "2. WHAT SHOULD BE HAPPENING?",
    `   Curriculum: ${shouldSummary}`,
    course ? `   Course: ${String(course.code)} — ${String(course.title)}` : "   Course: none supplied",
    `   Objective: ${objective ?? "UNKNOWN — not recorded"}`,
    questionOfWeek ? `   Question of the week: ${questionOfWeek}` : "",
    "",
    "3. WHAT IS ACTUALLY HAPPENING?",
    signals.length ? `   Declared conditions: ${signals.join(" · ")}` : "   No real-world conditions declared.",
    `   Open deviations: ${state.deviations.count}`,
    lastSession
      ? `   Last session: ${String(lastSession.title)} (${String(lastSession.status)}${lastSession.observedDate ? `, ${formatIsoDate(String(lastSession.observedDate))}` : ""})`
      : "   No previous session recorded.",
    "",
    "4. WHAT MATTERS RIGHT NOW?",
    goals.length ? `   Goals: ${goals.join(" · ")}` : "   No active goals recorded.",
    "",
    "5. WHAT DO WE ALREADY KNOW?",
    established.length ? `   Established: ${established.join(" · ")}` : "   No established teaching knowledge.",
    hypotheses.length ? `   Hypotheses: ${hypotheses.join(" · ")}` : "",
    "",
    "6. WHAT DO WE NEED TO LEARN?",
    gaps.length ? `   Gaps: ${gaps.join(" · ")}` : "   No specific gaps recorded.",
    revisit.length ? `   Revisit queue: ${revisit.join(" · ")}` : "",
    "",
    "7. WHO SHOULD ACT?",
    `   ${kind.emoji} ${kind.name} → ${composition.map((c) => c.positionKey).join(", ")}`,
    "   (Administration is not present in class. The Registrar is invoked afterwards only if the session is record-worthy.)",
    "",
    limitations.length
      ? `VISIBILITY LIMITATIONS:\n${limitations.map((l) => `   - ${l}`).join("\n")}`
      : "VISIBILITY: orientation complete.",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return {
    whereAreWe: { summary: whereSummary, conflicted, lines: posLines },
    whatShouldBeHappening: {
      summary: shouldSummary,
      curriculumVersion: curriculum.version ? String(curriculum.version.label) : null,
      course,
      objective,
      questionOfWeek,
      known: Boolean(objective),
    },
    whatIsActuallyHappening: {
      summary: signals.length ? signals.join(" · ") : "No conditions declared.",
      contextSignals: signals,
      openDeviations: state.deviations.count,
      lastSession: (lastSession as unknown as Record<string, unknown>) ?? null,
    },
    whatMattersNow: { goals, priorities: [] },
    whatWeKnow: { established, hypotheses, counts: state.knowledge.counts },
    whatWeNeedToLearn: { gaps, revisit, openQuestions },
    whoShouldAct: composition,
    whatMustBeRecorded: {
      criteria,
      note: "Faculty hand off; the Registrar classifies and files. Routine working material is not institutional history.",
    },
    briefing,
    limitations,
  };
}
