// ============================================================================
// Lochie Life College — Coordination windows (SERVER ONLY)
// ============================================================================
// The student must experience ONE coherent teacher. Internally, the faculty
// coordinates in a structured, inspectable way.
//
// A coordination window deliberately pauses visible classroom interaction:
//
//   1. Observer records what the student actually said.
//   2. Critic inspects the reasoning — silently — and escalates only if there
//      is a genuine problem.
//   3. Researcher is consulted ONLY if factual uncertainty exists.
//   4. The Instructor receives the synthesis.
//   5. The Instructor produces the single visible response.
//
// Only step 5 reaches the student. Steps 1–4 are attendance without speech.
// ============================================================================

import { db } from "@/db";
import { collegeFacultyContributions, collegeSessionEvents } from "@/db/college";
import { eq } from "drizzle-orm";
import {
  answerConsultation,
  coordinationBoard,
  currentAttention,
  emitEvent,
  handOff,
  requestConsultation,
  setAttention,
  settleHandoff,
} from "./orchestrator";
import { getAttentionPolicy } from "./attention";
import { getFacultyPosition } from "./faculty";
import { runFacultyPosition, type FacultyRun } from "./teaching";
import type { FacultyProtocol } from "./protocol";

// ---------------------------------------------------------------------------
// Signal detection
// ---------------------------------------------------------------------------
// IMPORTANT: these are SIGNALS, not findings. A keyword in a sentence is not
// proof of a misconception. The detector proposes candidate events; faculty
// determine whether the signal is real. Nothing here asserts a conclusion.

export interface DetectedSignal {
  eventType: string;
  because: string;
  /** Always "signal" — never "fact". A heuristic cannot establish a finding. */
  epistemicStatus: "signal";
}

const SIGNAL_RULES: Array<{ eventType: string; test: RegExp; because: string }> = [
  {
    eventType: "factual_uncertainty_detected",
    test: /\b(is it true|actually true|i read that|i heard|isn'?t it|apparently|source|citation|prove)\b/i,
    because: "The response appeals to an external fact that has not been verified.",
  },
  {
    eventType: "misconception_detected",
    test: /\b(so basically|which means|therefore all|that means every|always works|never works)\b/i,
    because: "The response contains a sweeping generalisation that may not hold.",
  },
  {
    eventType: "contradiction_detected",
    test: /\b(but you said|earlier you|that contradicts|doesn'?t match|opposite of)\b/i,
    because: "The response asserts a conflict with something previously stated.",
  },
  {
    eventType: "research_required",
    test: /\b(what does the research|any studies|evidence for|who says|what's the data)\b/i,
    because: "The response explicitly requests evidence.",
  },
  {
    eventType: "learning_evidence_observed",
    test: /\b(i think i get it|that makes sense|i tried|i noticed|i managed|i did it|i worked out)\b/i,
    because: "The response reports an attempt or a shift in understanding.",
  },
];

/**
 * Propose candidate events from a student response.
 * Returns signals, never conclusions. An empty result is a legitimate outcome:
 * most student responses need no faculty escalation at all.
 */
export function detectSignals(text: string): DetectedSignal[] {
  const out: DetectedSignal[] = [];
  for (const rule of SIGNAL_RULES) {
    if (rule.test.test(text)) {
      out.push({
        eventType: rule.eventType,
        because: rule.because,
        epistemicStatus: "signal",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coordination window
// ---------------------------------------------------------------------------

export interface WindowStep {
  order: number;
  positionKey: string;
  name: string;
  action: string;
  visible: boolean;
  detail: string;
}

export interface CoordinationWindow {
  trigger: string;
  studentVisibleResponse: string | null;
  respondingPosition: string | null;
  steps: WindowStep[];
  signals: DetectedSignal[];
  consultations: Array<{ from: string; to: string; question: string; outcome: string }>;
  internalContributions: FacultyRun[];
  note: string;
}

/**
 * Run a coordination window over an unexpected student response.
 *
 * `declaredEvents` lets the caller state authoritatively what happened
 * (e.g. the student explicitly asked for a source). Heuristic signals are
 * added as candidates. Faculty attention is routed from the union.
 */
export async function runCoordinationWindow(opts: {
  sessionId: string;
  protocol: FacultyProtocol;
  studentResponse: string;
  courseId?: string | null;
  weekIndex?: number | null;
  objective?: string;
  orientationBriefing: string;
  declaredEvents?: string[];
  localOnly?: boolean;
}): Promise<CoordinationWindow> {
  const steps: WindowStep[] = [];
  const internalContributions: FacultyRun[] = [];
  const consultations: CoordinationWindow["consultations"] = [];
  let order = 0;

  const has = (key: string) =>
    opts.protocol.positions.some((p) => p.positionKey === key && p.mode !== "administrative");

  // --- 0. The student's response enters the record as an event -------------
  await emitEvent({
    sessionId: opts.sessionId,
    eventType: "student_response_received",
    payload: opts.studentResponse.slice(0, 4000),
    emittedBy: "student",
    protocol: opts.protocol,
  });

  // --- 1. OBSERVER records it. Attends, does not speak. --------------------
  if (has("observer")) {
    await setAttention({
      sessionId: opts.sessionId,
      positionKey: "observer",
      state: "watching",
      reason: "Recording the student's response as primary evidence.",
      spoke: false,
    });
    await db.insert(collegeFacultyContributions).values({
      sessionId: opts.sessionId,
      positionKey: "observer",
      contributionType: "observation",
      stance: "neutral",
      content: `Student response recorded verbatim: "${opts.studentResponse.slice(0, 1500)}"`,
      truthClass: "fact",
      confidence: "known",
    });
    steps.push({
      order: ++order,
      positionKey: "observer",
      name: "Observer",
      action: "recorded the response",
      visible: false,
      detail: "Evidence captured without interpretation. Observer does not interrupt teaching.",
    });
  }

  // --- 2. Signals are proposed, not concluded ------------------------------
  const signals = detectSignals(opts.studentResponse);
  const declared = (opts.declaredEvents ?? []).map((e) => ({
    eventType: e,
    because: "Declared explicitly by the caller.",
    epistemicStatus: "signal" as const,
  }));
  const allEvents = [...declared, ...signals];

  const routedPositions = new Set<string>();
  for (const s of allEvents) {
    const res = await emitEvent({
      sessionId: opts.sessionId,
      eventType: s.eventType,
      payload: `${s.because} [${s.epistemicStatus}]`,
      emittedBy: "system",
      protocol: opts.protocol,
    });
    for (const r of res.routed) {
      if (r.action === "activate" || r.action === "consult" || r.action === "interrupt") {
        routedPositions.add(r.positionKey);
      }
    }
  }

  // --- 3. CRITIC inspects reasoning, silently ------------------------------
  const criticEngaged = routedPositions.has("critic") && has("critic");
  if (criticEngaged) {
    const run = await runFacultyPosition({
      positionKey: "critic",
      sessionId: opts.sessionId,
      courseId: opts.courseId,
      weekIndex: opts.weekIndex,
      objective: opts.objective,
      orientationBriefing: opts.orientationBriefing,
      localOnly: opts.localOnly,
      taskOverride:
        "The student said something unexpected. Inspect the REASONING only. Is there a genuine problem — a false assumption, an overreach, an ambiguity in how it was explained to them? If the reasoning is sound, say exactly: NO CONCERN. Do not critique ordinary conversation. Under 120 words.",
      visibleToStudent: false,
    });
    if (!("error" in run)) {
      internalContributions.push(run);
      const noConcern = /\bNO CONCERN\b/i.test(run.content);
      steps.push({
        order: ++order,
        positionKey: "critic",
        name: "Critic",
        action: noConcern ? "inspected and stood down" : "identified a reasoning issue",
        visible: false,
        detail: noConcern
          ? "No genuine reasoning problem. Returning to watching."
          : "A reasoning issue was raised for the Instructor's attention.",
      });
      await setAttention({
        sessionId: opts.sessionId,
        positionKey: "critic",
        state: noConcern ? "watching" : "escalated",
        reason: noConcern
          ? "Inspected the response; no genuine reasoning problem. Standing down."
          : "A reasoning problem was found and escalated to the Instructor.",
        spoke: false,
      });
    }
  }

  // --- 4. RESEARCHER only if factual uncertainty genuinely exists ----------
  const needsResearch = allEvents.some(
    (s) => s.eventType === "factual_uncertainty_detected" || s.eventType === "research_required"
  );
  if (needsResearch && has("researcher")) {
    const consult = await requestConsultation({
      sessionId: opts.sessionId,
      requestingPosition: "instructor",
      requestedPosition: "researcher",
      reason: "The student's response turns on a factual point that is not established.",
      question: "Verify whether the disputed factual point can be established from the record.",
      urgency: "high",
      scope: "Factual verification only. Do not advise on how to teach it.",
    });
    if (consult.ok) {
      const run = await runFacultyPosition({
        positionKey: "researcher",
        sessionId: opts.sessionId,
        courseId: opts.courseId,
        weekIndex: opts.weekIndex,
        objective: opts.objective,
        orientationBriefing: opts.orientationBriefing,
        localOnly: opts.localOnly,
        taskOverride:
          "A factual point is in question. State ONLY what can be established from the College's records and what cannot. If it cannot be established, say so plainly — uncertainty is a legitimate answer. Do not teach. Under 120 words.",
        visibleToStudent: false,
      });
      if (!("error" in run)) {
        internalContributions.push(run);
        await answerConsultation({
          id: consult.consultation.id,
          response: run.content.slice(0, 4000),
          outcome: "Evidence returned to the Instructor.",
        });
        consultations.push({
          from: "instructor",
          to: "researcher",
          question: consult.consultation.question,
          outcome: "Evidence returned to the Instructor.",
        });
        steps.push({
          order: ++order,
          positionKey: "researcher",
          name: "Researcher",
          action: "returned evidence to the Instructor",
          visible: false,
          detail: "Consulted because factual uncertainty materially affected the lesson.",
        });
      }
    }
  } else if (has("researcher")) {
    steps.push({
      order: ++order,
      positionKey: "researcher",
      name: "Researcher",
      action: "remained dormant",
      visible: false,
      detail: "No research question exists. The matter is not factual.",
    });
  }

  // --- 5. INSTRUCTOR receives the synthesis and produces the ONE response --
  const synthesis = internalContributions
    .map((c) => `[${c.name} — internal, not shown to the student]\n${c.content.slice(0, 1200)}`)
    .join("\n\n");

  let studentVisibleResponse: string | null = null;
  let respondingPosition: string | null = null;

  if (has("instructor")) {
    await setAttention({
      sessionId: opts.sessionId,
      positionKey: "instructor",
      state: "engaged",
      reason: "Received faculty synthesis. Producing the single response to the student.",
    });

    const board = await coordinationBoard(opts.sessionId);
    const run = await runFacultyPosition({
      positionKey: "instructor",
      sessionId: opts.sessionId,
      courseId: opts.courseId,
      weekIndex: opts.weekIndex,
      objective: opts.objective,
      orientationBriefing: opts.orientationBriefing,
      localOnly: opts.localOnly,
      visibleToStudent: true,
      extraContext: [
        `THE STUDENT SAID:\n"${opts.studentResponse.slice(0, 2000)}"`,
        synthesis
          ? `INTERNAL FACULTY COORDINATION (the student has NOT seen any of this):\n${synthesis}`
          : "",
        board,
      ]
        .filter(Boolean)
        .join("\n\n"),
      taskOverride:
        "Respond to the student directly, as ONE teacher. You have privately received input from other faculty positions — use it, but do NOT report it, name other positions, or narrate the College's internal process. The student should experience a single coherent teacher. Under 200 words.",
    });

    if (!("error" in run)) {
      internalContributions.push(run);
      studentVisibleResponse = run.content;
      respondingPosition = "instructor";
      steps.push({
        order: ++order,
        positionKey: "instructor",
        name: "Instructor",
        action: "responded to the student",
        visible: true,
        detail: "The single visible classroom response.",
      });
      await setAttention({
        sessionId: opts.sessionId,
        positionKey: "instructor",
        state: "engaged",
        reason: "Responded to the student.",
        spoke: true,
      });
    }
  }

  // --- 6. OBSERVER notes what followed ------------------------------------
  if (has("observer") && studentVisibleResponse) {
    steps.push({
      order: ++order,
      positionKey: "observer",
      name: "Observer",
      action: "continues watching",
      visible: false,
      detail: "Awaiting the student's next response to record what actually changed.",
    });
  }

  await db.insert(collegeSessionEvents).values({
    sessionId: opts.sessionId,
    stage: "lesson",
    note: `Coordination window: ${steps.length} internal step(s), ${
      steps.filter((s) => s.visible).length
    } visible to the student.`,
    actor: "system",
  });

  return {
    trigger: opts.studentResponse.slice(0, 500),
    studentVisibleResponse,
    respondingPosition,
    steps,
    signals: allEvents,
    consultations,
    internalContributions,
    note: "The student experiences one coherent teacher. Faculty coordination is structured and inspectable, but not exposed in the classroom.",
  };
}

/**
 * Role-creep guard used at the API boundary: a position asked to act outside
 * its remit defers instead of answering.
 */
export function deferIfOutOfRemit(
  positionKey: string,
  matter: string
): { defer: boolean; to?: string; message?: string } {
  const policy = getAttentionPolicy(positionKey);
  const position = getFacultyPosition(positionKey);
  if (!policy || !position) return { defer: false };
  const lowered = matter.toLowerCase();
  for (const d of policy.deferMatters) {
    const words = d.matter
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4);
    const hits = words.filter((w) => lowered.includes(w)).length;
    if (hits >= 2) {
      return {
        defer: true,
        to: d.to,
        message: `${position.name} defers: "${d.matter}" belongs to ${d.to}, not to this position.`,
      };
    }
  }
  return { defer: false };
}

export { handOff, settleHandoff, currentAttention };
