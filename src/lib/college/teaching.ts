// ============================================================================
// Lochie Life College — executable teaching loop (SERVER ONLY)
// ============================================================================
// Runs faculty for real. Each position receives a DIFFERENT bounded context
// packet and produces a DIFFERENT class of output. Disagreement is stored,
// never collapsed into a single synthetic answer.
//
// Uses the existing `generate()` from src/lib/ai.ts — no new AI infrastructure.
// That function degrades to the local engine and never hard-fails, so the loop
// still completes with no network.
// ============================================================================

import { db } from "@/db";
import {
  collegeFacultyContributions,
  collegeFormativeEvidence,
  collegeSessionEvents,
  collegeSessions,
} from "@/db/college";
import { desc, eq } from "drizzle-orm";
import { generate } from "@/lib/ai";
import { buildContextPacket } from "./context";
import { buildOrientation } from "./orientation";
import { getFacultyPosition } from "./faculty";
import { computeCollegeState } from "./state";
import { compilePersonality, resolveFacultyForContext } from "./members";

/** What each position is asked to produce. Different roles → different output. */
const POSITION_TASK: Record<string, { task: string; contributionType: string; stance: string }> = {
  instructor: {
    task: "Teach this objective. Explain the principle behind it, then give ONE short applied activity the student can actually do. Begin at the student's current level. Keep it under 250 words.",
    contributionType: "interpretation",
    stance: "neutral",
  },
  researcher: {
    task: "State what information or evidence is relevant to this objective, and name what is NOT known or not established. Do not teach. Under 180 words.",
    contributionType: "observation",
    stance: "neutral",
  },
  critic: {
    task: "Pressure-test the plan and the current understanding. Name assumptions, likely misconceptions, and anything asserted with more confidence than the evidence supports. Disagree openly if warranted. Under 180 words.",
    contributionType: "dissent",
    stance: "dissent",
  },
  socratic: {
    task: "Produce 3 questions that would develop the student's independent judgement on this objective. Questions only — no answers.",
    contributionType: "question",
    stance: "question",
  },
  observer: {
    task: "Record ONLY what can be observed about this session so far: what was set, what was produced, what remains unattempted. Do not interpret or assess. Under 120 words.",
    contributionType: "observation",
    stance: "neutral",
  },
  assessor: {
    task: "Describe what evidence WOULD demonstrate this capability, and what has actually been evidenced so far. This is a formative observation, not a formal assessment. Under 150 words.",
    contributionType: "assessment",
    stance: "neutral",
  },
  specialist: {
    task: "Provide domain-specific depth relevant to this objective. Under 150 words.",
    contributionType: "interpretation",
    stance: "neutral",
  },
};

export interface FacultyRun {
  positionKey: string;
  name: string;
  contributionType: string;
  stance: string;
  content: string;
  via: string;
  ms: number;
  contextIncluded: string[];
  limitations: string[];
  /** False when this was internal faculty work the student never sees. */
  visibleToStudent?: boolean;
  /** Which configured faculty member occupied the position, if any. */
  memberName?: string;
}

/**
 * Run one faculty position with its own bounded context.
 * Administration positions are refused — they do not attend class.
 */
export async function runFacultyPosition(opts: {
  positionKey: string;
  sessionId: string;
  courseId?: string | null;
  weekIndex?: number | null;
  objective?: string;
  orientationBriefing: string;
  priorContributions?: Array<{ positionKey: string; content: string }>;
  localOnly?: boolean;
  /**
   * Replaces the position's default task for this one execution point. The
   * orchestrator uses this to ask a position a *specific* question rather than
   * its general one — e.g. asking the Critic to inspect a single response.
   */
  taskOverride?: string;
  /** Additional bounded context supplied by the orchestrator. */
  extraContext?: string;
  /**
   * Whether this execution produces student-visible output. Internal faculty
   * work (observation, silent inspection, consultation) is NOT shown in the
   * classroom — attending is not the same as speaking.
   */
  visibleToStudent?: boolean;
  /** Used to resolve which configured member occupies this position. */
  sessionKind?: string;
}): Promise<FacultyRun | { error: string }> {
  const position = getFacultyPosition(opts.positionKey);
  if (!position) return { error: `unknown position ${opts.positionKey}` };
  if (position.branch !== "faculty" || !position.participatesInClass) {
    return {
      error: `${position.name} is ${position.branch} and does not attend teaching sessions`,
    };
  }

  const packet = await buildContextPacket({
    positionKey: position.key,
    courseId: opts.courseId ?? null,
    weekIndex: opts.weekIndex ?? null,
    sessionObjective: opts.objective,
  });

  const spec = POSITION_TASK[position.key] ?? {
    task: "Contribute according to your remit.",
    contributionType: "interpretation",
    stance: "neutral",
  };

  // Peers' contributions are shown so positions can genuinely respond to one
  // another — but each still answers only its own question.
  const peer = (opts.priorContributions ?? [])
    .filter((p) => p.positionKey !== position.key)
    .map((p) => `--- ${p.positionKey} said ---\n${p.content.slice(0, 900)}`)
    .join("\n\n");

  const task = opts.taskOverride ?? spec.task;

  const userContent = [
    opts.orientationBriefing,
    "",
    "---",
    "",
    packet.context,
    opts.extraContext ? `\n---\n\n${opts.extraContext}` : "",
    peer ? `\n---\n\nOTHER FACULTY POSITIONS IN THIS SESSION:\n${peer}` : "",
    "",
    "---",
    "",
    opts.visibleToStudent === false
      ? "THIS IS INTERNAL FACULTY WORK. It will NOT be shown to the student. Do not address the student."
      : "",
    `YOUR TASK (${position.name}): ${task}`,
  ]
    .filter((s) => s !== "")
    .join("\n");

  // PERSONALITY layer. Compiled separately from institutional rules and
  // appended AFTER them, so institutional rules always come first and win.
  let personalityBlock = "";
  let memberName = "";
  if (opts.courseId !== undefined) {
    const serving = await resolveFacultyForContext({
      courseId: opts.courseId ?? null,
      sessionKind: opts.sessionKind,
    });
    const mine = serving.find((s) => s.member.positionKey === position.key);
    if (mine) {
      personalityBlock = compilePersonality(mine.member);
      memberName = mine.member.name;
    }
  }

  const started = Date.now();
  const res = await generate({
    modelId: "openai",
    messages: [{ role: "user", content: userContent }],
    system: personalityBlock ? `${packet.system}\n\n---\n\n${personalityBlock}` : packet.system,
    temperature: 0.6,
    localOnly: opts.localOnly,
    category: "reasoning",
  });

  const [row] = await db
    .insert(collegeFacultyContributions)
    .values({
      sessionId: opts.sessionId,
      positionKey: position.key,
      contributionType: spec.contributionType,
      stance: spec.stance,
      content: res.text.slice(0, 20000),
      truthClass: spec.contributionType === "observation" ? "fact" : "interpretation",
      confidence: packet.limitations.length ? "inferred" : "known",
    })
    .returning();

  const internal = opts.visibleToStudent === false;
  await db.insert(collegeSessionEvents).values({
    sessionId: opts.sessionId,
    stage: "lesson",
    note: `${position.name} contributed (${spec.contributionType}, via ${res.via})${
      internal ? " — internal faculty work, not shown to the student." : "."
    }`,
    actor: `faculty:${position.key}`,
  });

  return {
    positionKey: position.key,
    name: position.name,
    contributionType: spec.contributionType,
    stance: spec.stance,
    content: row.content,
    via: res.via,
    ms: Date.now() - started,
    contextIncluded: packet.included,
    limitations: packet.limitations,
    visibleToStudent: opts.visibleToStudent !== false,
    memberName: memberName || undefined,
  };
}

/**
 * Synthesise the faculty positions into a coordination summary WITHOUT
 * erasing them. The underlying contributions remain individually inspectable:
 * who said what, in which role, with what stance.
 */
export function coordinateFaculty(runs: FacultyRun[]): {
  summary: string;
  agreements: string[];
  disagreements: string[];
  positions: Array<{ positionKey: string; stance: string; contributionType: string }>;
} {
  const dissent = runs.filter((r) => r.stance === "dissent");
  const questions = runs.filter((r) => r.stance === "question");
  const positions = runs.map((r) => ({
    positionKey: r.positionKey,
    stance: r.stance,
    contributionType: r.contributionType,
  }));

  const disagreements = dissent.map(
    (d) => `${d.name} raised a challenge (${d.contributionType}); the position is preserved in full.`
  );
  const agreements = runs
    .filter((r) => r.stance === "neutral")
    .map((r) => `${r.name} contributed ${r.contributionType}.`);

  const summary = [
    `${runs.length} faculty position(s) participated: ${runs.map((r) => r.name).join(", ")}.`,
    dissent.length
      ? `${dissent.length} recorded dissent. Disagreement is preserved, not resolved into consensus.`
      : "No dissent recorded.",
    questions.length ? `${questions.length} position(s) contributed questions rather than answers.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return { summary, agreements, disagreements, positions };
}

/** Record formative evidence — explicitly NOT a formal assessment. */
export async function recordFormativeEvidence(input: {
  sessionId?: string | null;
  courseId?: string | null;
  weekIndex?: number | null;
  positionKey: string;
  evidenceType: string;
  content: string;
  capabilityKey?: string;
}) {
  const position = getFacultyPosition(input.positionKey);
  if (position && position.assessmentAuthority === "none") {
    return {
      ok: false as const,
      error: `${position.name} has no authority to make statements about attainment.`,
    };
  }
  const [row] = await db
    .insert(collegeFormativeEvidence)
    .values({
      sessionId: input.sessionId ?? null,
      courseId: input.courseId ?? null,
      weekIndex: input.weekIndex ?? null,
      positionKey: input.positionKey,
      evidenceType: input.evidenceType.slice(0, 60),
      content: input.content.slice(0, 8000),
      capabilityKey: (input.capabilityKey ?? "").slice(0, 60),
      assessmentKind: "formative",
    })
    .returning();
  return { ok: true as const, evidence: row };
}
