// ============================================================================
// Lochie Life College — Faculty context packet (SERVER ONLY)
// ============================================================================
// Faculty must reconstruct institutional understanding from AUTHORITATIVE
// RECORDS, not from conversational memory. This module builds a controlled,
// labelled packet for one faculty position, honouring its bounded context
// scope, and states visibility limits explicitly.
//
// This deliberately differs from `src/lib/projectContext.ts`, which merges
// project memory + artifacts into one undifferentiated block and invites the
// model to "challenge it where the new material suggests it is wrong". That is
// correct for a Work OS. It is wrong for an institution, where the model must
// know which claims are canonical, which are filed history, which are working
// material, and which are unverified.
// ============================================================================

import { db } from "@/db";
import {
  collegeContextSignals,
  collegeCourses,
  collegeCourseWeeks,
  collegeGoals,
  collegeMemory,
  collegeRecords,
} from "@/db/college";
import { and, desc, eq, sql } from "drizzle-orm";
import { computeCollegeState, type CollegeState } from "./state";
import { getFacultyPosition, type FacultyPosition } from "./faculty";
import { claimLine, EPISTEMIC_LABEL } from "./truth";
import { formatIsoDate } from "./time";

export interface ContextPacket {
  positionKey: string;
  /** The system prompt for this faculty position. */
  system: string;
  /** The labelled institutional context block. */
  context: string;
  /** Everything the packet could not establish. Never hidden from the model. */
  limitations: string[];
  /** Which scope keys were actually populated. */
  included: string[];
}

const FACULTY_CHARTER = `You are a member of the Faculty of Lochie Life College, a personal university whose purpose is to help the student become by learning.

INSTITUTIONAL PHILOSOPHY
- Education before productivity. Measure progress by capability gained, not tasks completed.
- Principles before techniques: teach the "why" that makes the "how" stick.
- Kind rigor: academically serious, human in tone, never preachy.
- The Continuation Principle: setbacks are observations, not failures requiring a restart. Never tell the student to start the semester over.
- Whole-person education: no domain should develop at the expense of all others.

EVIDENCE BEFORE INTERPRETATION
Distinguish clearly, and label explicitly when it matters:
- OBSERVATION — what is recorded or actually occurred
- INTERPRETATION — a reasoned reading of that evidence
- ASSESSMENT — a judgement drawn from interpretation
Never present a conclusion with more confidence than the evidence supports. When evidence is incomplete, say so. Uncertainty is a legitimate scholarly outcome.

CONTINUITY THROUGH RECORDS
Institutional understanding is reconstructed from authoritative records, not from conversational memory. Everything below is supplied from the College's persistent state. If a fact is not present below, you do not know it — say so rather than inventing it. Do not invent institutional decisions, courses, weeks, or history.

AUTHORITY
Working conversation has no institutional authority. Nothing you say becomes an institutional record until it is explicitly filed through Administration. Do not convert a single successful practice into governance; repeated operational evidence justifies standards.

HISTORICAL INTEGRITY
Preserve chronology before interpretation. Do not rearrange events to produce a cleaner narrative. Distinguish what was understood at the time from what is understood now.

TEACHING MODE
Adapt to the student's intent. When they seek understanding, explain, ask, and build capability. When they request a direct fact or a completed task, provide it efficiently and add educational context only where it genuinely helps. Do not turn every request into a lecture.`;

function positionBlock(p: FacultyPosition): string {
  return `YOUR POSITION: ${p.emoji} ${p.name}
Remit: ${p.remit}
The question you exist to answer: "${p.question}"
Authority boundary: ${p.authorityBoundary}
Expected output: ${p.outputType}
${p.mayFileRecords ? "" : "You may NOT file institutional records. You may only propose them.\n"}${p.mayAssess ? "" : "You may NOT issue a formal assessment. You may only recommend one.\n"}
Other positions may disagree with you. That disagreement is valuable and will be preserved — do not soften your position to manufacture consensus, and do not pretend to speak for positions other than your own.`;
}

/** Institutional position, always included — every position needs to know "when" it is. */
function stateBlock(state: CollegeState): string {
  const lines: string[] = [];
  lines.push("INSTITUTIONAL POSITION (from persistent College State):");
  lines.push(
    `[FACT] Today: ${state.realWorld.longDate}, ${state.realWorld.time} ${state.realWorld.timezone}`
  );
  lines.push(claimLine("Term", state.position.term));
  lines.push(claimLine("Academic week (derived from calendar)", state.position.derivedWeek));
  lines.push(claimLine("Academic week (declared by institution)", state.position.declaredWeek));
  lines.push(claimLine("Week theme", state.position.weekTheme));

  if (state.conflicts.length) {
    lines.push("");
    lines.push("!! UNRESOLVED CONFLICTS — do not silently pick a side:");
    for (const c of state.conflicts) {
      lines.push(`- ${c.title}: ${c.detail} (sources: ${c.sources.join(" vs ")})`);
    }
    lines.push(
      "If the academic position matters to this session, state the conflict to the student and proceed on the most defensible reading while saying which you used."
    );
  }
  return lines.join("\n");
}

/**
 * Build the context packet for one faculty position in one session.
 * Only the scope keys declared by the position are included.
 */
export async function buildContextPacket(opts: {
  positionKey: string;
  courseId?: string | null;
  weekIndex?: number | null;
  sessionObjective?: string;
  state?: CollegeState;
}): Promise<ContextPacket> {
  const position = getFacultyPosition(opts.positionKey);
  const limitations: string[] = [];
  const included: string[] = [];

  if (!position) {
    return {
      positionKey: opts.positionKey,
      system: FACULTY_CHARTER,
      context: "",
      limitations: [`Unknown faculty position "${opts.positionKey}".`],
      included: [],
    };
  }

  const state = opts.state ?? (await computeCollegeState());
  const scope = new Set(position.contextScope);
  const blocks: string[] = [stateBlock(state)];
  included.push("institutional_state");

  // ---- course + objective ----
  if (scope.has("course") && opts.courseId) {
    const [course] = await db
      .select()
      .from(collegeCourses)
      .where(eq(collegeCourses.id, opts.courseId))
      .limit(1);
    if (course) {
      included.push("course");
      const statusNote =
        course.status === "approved" || course.status === "delivering"
          ? "approved"
          : `NOT approved (status: ${course.status}) — treat as a blueprint, not an accredited course`;
      blocks.push(
        `COURSE: ${course.code} — ${course.title}\n[${course.status === "approved" ? "FACT" : "INTERPRETATION"}] Catalogue status: ${statusNote}\nSummary: ${course.summary || "(none recorded)"}\nPrimary capabilities: ${course.primaryCapabilities}`
      );
      if (scope.has("objective") && opts.weekIndex) {
        const [cw] = await db
          .select()
          .from(collegeCourseWeeks)
          .where(
            and(
              eq(collegeCourseWeeks.courseId, course.id),
              eq(collegeCourseWeeks.weekIndex, opts.weekIndex)
            )
          )
          .limit(1);
        if (cw) {
          included.push("objective");
          blocks.push(
            `WEEKLY OBJECTIVE (week ${cw.weekIndex}):\n${cw.objective || "(not recorded)"}\nQuestion of the week: ${cw.questionOfWeek || "(not recorded)"}`
          );
        } else {
          limitations.push(
            `No roadmap entry exists for ${course.code} week ${opts.weekIndex}. The weekly objective is UNKNOWN.`
          );
        }
      }
    } else {
      limitations.push("The referenced course could not be found in College State.");
    }
  } else if (scope.has("course")) {
    limitations.push("No course was supplied for this session; teaching context is generic.");
  }

  if (opts.sessionObjective) {
    blocks.push(`SESSION OBJECTIVE (stated for this session):\n${opts.sessionObjective}`);
    included.push("session_objective");
  }

  // ---- prior learning (student memory) ----
  if (scope.has("prior_learning")) {
    const prior = await db
      .select()
      .from(collegeMemory)
      .where(
        and(
          eq(collegeMemory.active, true),
          sql`${collegeMemory.scope} in ('student_learning','course')`
        )
      )
      .orderBy(desc(collegeMemory.updatedAt))
      .limit(15);
    if (prior.length) {
      included.push("prior_learning");
      blocks.push(
        `PRIOR LEARNING (each line labelled with its epistemic status — do not treat an observation as established):\n${prior
          .map((m) => `- [${EPISTEMIC_LABEL[m.epistemicStatus as keyof typeof EPISTEMIC_LABEL] ?? m.epistemicStatus}] ${m.content.slice(0, 260)}`)
          .join("\n")}`
      );
    } else {
      limitations.push("No prior learning records exist. Student history is UNKNOWN.");
    }
  }

  // ---- teaching memory ----
  if (scope.has("teaching_memory")) {
    const teaching = await db
      .select()
      .from(collegeMemory)
      .where(and(eq(collegeMemory.active, true), eq(collegeMemory.scope, "teaching")))
      .orderBy(desc(collegeMemory.corroborationCount), desc(collegeMemory.updatedAt))
      .limit(12);
    if (teaching.length) {
      included.push("teaching_memory");
      blocks.push(
        `TEACHING MEMORY (what the institution has learned about teaching this student):\n${teaching
          .map(
            (m) =>
              `- [${EPISTEMIC_LABEL[m.epistemicStatus as keyof typeof EPISTEMIC_LABEL] ?? m.epistemicStatus}, corroborated ×${m.corroborationCount}] ${m.memoryType}: ${m.content.slice(0, 240)}`
          )
          .join("\n")}`
      );
    } else {
      limitations.push("No teaching memory exists yet. Adapt cautiously and record what you observe.");
    }
  }

  // ---- real-world conditions ----
  if (scope.has("context_signals")) {
    const signals = await db
      .select()
      .from(collegeContextSignals)
      .where(eq(collegeContextSignals.active, true))
      .orderBy(desc(collegeContextSignals.createdAt))
      .limit(10);
    if (signals.length) {
      included.push("context_signals");
      blocks.push(
        `REAL-WORLD CONDITIONS (declared by the student or recorded — never inferred or surveilled):\n${signals
          .map((s) => `- [${s.signalType}] ${s.content}${s.impact ? ` → bearing on teaching: ${s.impact}` : ""}`)
          .join(
            "\n"
          )}\nThese inform how today's session should be interpreted. They do not overwrite institutional records, and you must not speculate about conditions not listed here.`
      );
    } else {
      blocks.push(
        "REAL-WORLD CONDITIONS: none declared. Do not speculate about the student's circumstances — ask if it matters."
      );
      included.push("context_signals");
    }
  }

  // ---- goals ----
  if (scope.has("goals")) {
    const goals = await db
      .select()
      .from(collegeGoals)
      .where(sql`${collegeGoals.status} in ('active','progressing','stalled')`)
      .orderBy(desc(collegeGoals.updatedAt))
      .limit(8);
    if (goals.length) {
      included.push("goals");
      blocks.push(
        `ACTIVE GOALS:\n${goals
          .map((g) => `- [${g.status}] ${g.title}${g.purpose ? ` — purpose: ${g.purpose}` : ""}${g.obstacles ? ` — obstacles: ${g.obstacles}` : ""}`)
          .join("\n")}`
      );
    } else {
      limitations.push("No active goals are recorded.");
    }
  }

  // ---- open questions ----
  if (scope.has("open_questions")) {
    const qs = await db
      .select()
      .from(collegeMemory)
      .where(and(eq(collegeMemory.active, true), eq(collegeMemory.memoryType, "question")))
      .orderBy(desc(collegeMemory.updatedAt))
      .limit(10);
    if (qs.length) {
      included.push("open_questions");
      blocks.push(
        `UNRESOLVED ACADEMIC QUESTIONS:\n${qs.map((q) => `- ${q.content.slice(0, 240)}`).join("\n")}`
      );
    }
  }

  // ---- prior records (registrar) ----
  if (scope.has("prior_records")) {
    const recs = await db
      .select()
      .from(collegeRecords)
      .where(eq(collegeRecords.status, "filed"))
      .orderBy(desc(collegeRecords.filedAt))
      .limit(10);
    if (recs.length) {
      included.push("prior_records");
      blocks.push(
        `FILED INSTITUTIONAL RECORDS (authoritative history — chronological, do not rewrite):\n${recs
          .map(
            (r) =>
              `- ${r.occurredOn ? formatIsoDate(r.occurredOn) : "(date unknown)"} · ${r.recordType} · ${r.subject}`
          )
          .join("\n")}`
      );
    } else {
      limitations.push(
        "No filed institutional records exist. The College has no authoritative history yet — say so rather than implying continuity."
      );
    }
  }

  if (scope.has("capabilities")) {
    blocks.push(
      "ASSESSMENT BASIS: assessments must be authentic projects (no exams), and should evidence measurable improvement in at least one primary capability."
    );
    included.push("capabilities");
  }

  // ---- visibility statement (always last, always present) ----
  const visibility = limitations.length
    ? `VISIBILITY LIMITATIONS — state these to the student if they affect your answer:\n${limitations.map((l) => `- ${l}`).join("\n")}`
    : "VISIBILITY: all context required by your position was available.";

  const context = [...blocks, visibility].join("\n\n---\n\n");

  return {
    positionKey: position.key,
    system: `${FACULTY_CHARTER}\n\n---\n\n${positionBlock(position)}`,
    context,
    limitations,
    included,
  };
}

export { FACULTY_CHARTER };
