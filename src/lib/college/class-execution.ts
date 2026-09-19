// ============================================================================
// Lochie Life College — member-driven class execution (SERVER ONLY)
// ============================================================================
// LAYER 6 §6 §7 §8 §10 §11 §12 §13 §14 §19 §21 §37.
//
// This is the organ that makes the others behave like one organism:
//
//   MEMORY → ATTENTION → COORDINATION → TEACHING → RECORD
//
// What changes from Layer 5. Previously `runCoordinationWindow` knew, in
// TypeScript, that factual uncertainty means "run the researcher". The
// configuration the founder wrote was consulted for attention but not for
// sequence. Here the sequence itself comes from the member's effective policy
// and the coordination graph: who is woken, who they may ask, who they defer
// to, and who is permitted to speak.
//
// Three invariants this file exists to protect.
//
//   1. ATTENTION IS NOT SPEECH (§7 §14). Most members will watch. Silence is
//      recorded as a successful outcome and never padded into dialogue.
//
//   2. ONE STUDENT-FACING VOICE (§13). Internal coordination may involve
//      several members; the student hears the Instructor. Everything else is
//      internal faculty work, recorded and inspectable but not addressed to
//      the student.
//
//   3. FAILURE IS EXPLICIT (§37). A faculty execution failure, a memory
//      retrieval failure or a coordination failure is reported as such. The
//      class never degrades into an apparently successful one.
// ============================================================================

import { db } from "@/db";
import { collegeFacultyContributions, collegeSessionEvents } from "@/db/college";
import { generate } from "@/lib/ai";
import {
  evaluateAttention,
  recordAttentionDecision,
  resolveSpeakingOrder,
  type AttentionOutcome,
  type EffectivePolicy,
} from "./attention-resolver";
import {
  buildCoordinationGraph,
  canConsult,
  type CoordinationGraph,
} from "./coordination-graph";
import { buildMemberContext, summarisePacket, type MemberContextPacket } from "./member-context";
import {
  executionLabel,
  outputContractInstruction,
  parseFacultyOutput,
  validateFacultyOutput,
  type FacultyAction,
  type ValidatedOutput,
} from "./faculty-output";
import * as facultyMemory from "./faculty-memory";
import * as ledger from "./ledger";
import { compilePersonality } from "./members";
import { getFacultyPosition } from "./faculty";
import { setAttention } from "./orchestrator";

// ---------------------------------------------------------------------------
// What each position is asked to do. Unchanged in spirit from teaching.ts —
// kept here so the runtime can ask a DIFFERENT question per activation reason.
// ---------------------------------------------------------------------------

const POSITION_TASK: Record<string, string> = {
  instructor:
    "Teach this objective. Explain the principle behind it, then give ONE short applied activity the student can actually do. Begin at the student's current level. Under 250 words.",
  researcher:
    "State what evidence is relevant to this objective and what is NOT established. Do not teach. Under 150 words.",
  critic:
    "Pressure-test the reasoning. Name assumptions and anything asserted with more confidence than the evidence supports. If the reasoning is sound, say exactly: NO CONCERN. Under 150 words.",
  socratic:
    "Produce 3 questions that would develop the student's independent judgement on this objective. Questions only.",
  observer:
    "Record ONLY what can be observed: what was set, what was produced, what remains unattempted. Do not interpret. Under 120 words.",
  assessor:
    "Describe what evidence WOULD demonstrate this capability and what has actually been evidenced. Formative only. Under 150 words.",
  specialist: "Provide domain-specific depth relevant to this objective. Under 150 words.",
};

/** Which actions the runtime will accept from a position at a given moment. */
function allowedActionsFor(positionKey: string, isStudentFacing: boolean): FacultyAction[] {
  const position = getFacultyPosition(positionKey);
  const base: FacultyAction[] = ["observe", "consult", "defer", "propose"];
  if (isStudentFacing && position?.participatesInClass) base.push("speak");
  if (position?.key === "registrar" || position?.mayFileRecords) base.push("record");
  // Any position may assert record-worthiness; only Administration files.
  if (!base.includes("record")) base.push("record");
  return base;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemberExecution {
  positionKey: string;
  memberName: string;
  memberVersion: number | null;
  /** The attention outcome that led here. */
  attention: AttentionOutcome;
  /** Null when the member never executed — watching is not running. */
  output: ValidatedOutput | null;
  /** What the student actually sees, if anything. */
  visibleToStudent: boolean;
  contextSummary: ReturnType<typeof summarisePacket> | null;
  ms: number;
  /** §37 — populated when this member failed to execute. */
  failure: string | null;
}

export interface ConsultationRecord {
  from: string;
  to: string;
  reason: string;
  question: string;
  finding: string;
  confidence: string;
  evidence: string;
  /** False when the graph refused the edge. */
  permitted: boolean;
  basis: string;
}

export interface ClassExecution {
  /** Every member considered, including those that stayed dormant. */
  members: MemberExecution[];
  /** The single student-facing response. */
  studentFacingResponse: string | null;
  respondingPosition: string | null;
  consultations: ConsultationRecord[];
  deferrals: Array<{ from: string; to: string; matter: string; note: string }>;
  escalations: Array<{ from: string; to: string; matter: string; basis: string }>;
  interruptions: Array<{
    from: string;
    to: string;
    reason: string;
    accepted: boolean;
    basis: string;
  }>;
  /** Observations generated this class — candidates only (§19). */
  candidateMemories: Array<{
    positionKey: string;
    content: string;
    kind: string;
    stored: boolean;
    note: string;
  }>;
  silent: Array<{ positionKey: string; memberName: string; reason: string }>;
  failures: string[];
  graph: CoordinationGraph;
  /** True when ANY execution came from the offline fallback. */
  usedFallback: boolean;
}

// ---------------------------------------------------------------------------
// Running one member
// ---------------------------------------------------------------------------

async function executeMember(opts: {
  policy: EffectivePolicy;
  sessionId: string;
  courseId: string | null;
  weekIndex: number | null;
  objective: string;
  orientationBriefing: string;
  attention: AttentionOutcome;
  task: string;
  visibleToStudent: boolean;
  localOnly?: boolean;
  extraContext?: string;
  memberRow?: Parameters<typeof compilePersonality>[0] | null;
}): Promise<MemberExecution> {
  const started = Date.now();
  const { policy, attention } = opts;
  const base: Omit<MemberExecution, "output" | "contextSummary" | "ms" | "failure"> = {
    positionKey: policy.positionKey,
    memberName: policy.memberName || policy.positionKey,
    memberVersion: policy.memberVersion,
    attention,
    visibleToStudent: opts.visibleToStudent,
  };

  let packet: MemberContextPacket;
  try {
    packet = await buildMemberContext({
      policy,
      courseId: opts.courseId,
      weekIndex: opts.weekIndex,
      sessionObjective: opts.objective,
      triggeringEvent: attention.reason,
      attentionState: attention.state,
    });
  } catch (e) {
    return {
      ...base,
      output: null,
      contextSummary: null,
      ms: Date.now() - started,
      failure: `CONTEXT CONSTRUCTION FAILURE for ${base.memberName}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  const allowed = allowedActionsFor(policy.positionKey, opts.visibleToStudent);
  const defaultAction: FacultyAction = opts.visibleToStudent ? "speak" : "observe";

  const userContent = [
    opts.orientationBriefing,
    "",
    "---",
    "",
    packet.context,
    opts.extraContext ? `\n---\n\n${opts.extraContext}` : "",
    "",
    "---",
    "",
    opts.visibleToStudent
      ? "This response WILL be shown to the student. Address them directly."
      : "THIS IS INTERNAL FACULTY WORK. It will NOT be shown to the student. Do not address the student.",
    "",
    `YOUR TASK: ${opts.task}`,
    outputContractInstruction(allowed),
  ]
    .filter((s) => s !== "")
    .join("\n");

  // Personality is compiled separately and appended AFTER the institutional
  // charter, so institutional rules are read first and win on conflict.
  const personality = opts.memberRow ? compilePersonality(opts.memberRow) : "";

  let text: string;
  let via: string;
  try {
    const res = await generate({
      modelId: "openai",
      messages: [{ role: "user", content: userContent }],
      system: personality ? `${packet.system}\n\n---\n\n${personality}` : packet.system,
      temperature: 0.6,
      localOnly: opts.localOnly,
      category: "reasoning",
    });
    text = res.text;
    via = res.via;
  } catch (e) {
    // §37 — an execution failure is named, never smoothed over.
    return {
      ...base,
      output: null,
      contextSummary: summarisePacket(packet),
      ms: Date.now() - started,
      failure: `FACULTY EXECUTION FAILURE for ${base.memberName}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  const proposal = parseFacultyOutput(text, defaultAction, opts.visibleToStudent ? "student" : "system");
  const output = validateFacultyOutput({
    proposal,
    positionKey: policy.positionKey,
    grantedAuthority: policy.grantedAuthority,
    allowedActions: allowed,
    via,
  });

  // Persist the contribution. Refused actions are still recorded — the
  // thinking may matter even when the act was not permitted.
  await db.insert(collegeFacultyContributions).values({
    sessionId: opts.sessionId,
    positionKey: policy.positionKey,
    contributionType: output.executedAction === "speak" ? "interpretation" : "observation",
    stance: policy.positionKey === "critic" ? "dissent" : "neutral",
    content: proposal.content.slice(0, 20000),
    truthClass: output.executedAction === "observe" ? "fact" : "interpretation",
    confidence: proposal.confidence === "high" ? "known" : "inferred",
  });

  return {
    ...base,
    output,
    contextSummary: summarisePacket(packet),
    ms: Date.now() - started,
    failure: null,
  };
}

// ---------------------------------------------------------------------------
// The class execution
// ---------------------------------------------------------------------------

/**
 * Run one teaching exchange under member configuration.
 *
 * `events` are what actually happened — the student responded, a contradiction
 * was detected, and so on. Each event is evaluated against EVERY member's
 * effective policy independently (§6), and the resulting attention decisions
 * drive who runs.
 */
export async function executeClass(opts: {
  sessionId: string;
  courseId: string | null;
  weekIndex: number | null;
  objective: string;
  orientationBriefing: string;
  policies: Map<string, EffectivePolicy>;
  memberRows?: Map<string, Parameters<typeof compilePersonality>[0]>;
  /** Events driving this exchange. The first is treated as the trigger. */
  events: Array<{ eventType: string; payload?: string; phaseKey?: string }>;
  /** What the student said, when they said something. */
  studentResponse?: string | null;
  phaseKey?: string;
  localOnly?: boolean;
}): Promise<ClassExecution> {
  const graph = buildCoordinationGraph(opts.policies);
  const members: MemberExecution[] = [];
  const consultations: ConsultationRecord[] = [];
  const deferrals: ClassExecution["deferrals"] = [];
  const interruptions: ClassExecution["interruptions"] = [];
  const candidateMemories: ClassExecution["candidateMemories"] = [];
  const silent: ClassExecution["silent"] = [];
  const failures: string[] = [];
  let usedFallback = false;

  // ---- 1. ATTENTION: evaluate every event against every member (§6) ------
  // Independently. One member's activation never implies another's.
  const outcomes = new Map<string, AttentionOutcome>();
  for (const event of opts.events) {
    for (const [key, policy] of opts.policies) {
      const outcome = evaluateAttention(policy, {
        eventType: event.eventType,
        phaseKey: event.phaseKey ?? opts.phaseKey,
        payload: event.payload,
      });
      await recordAttentionDecision({
        sessionId: opts.sessionId,
        eventType: event.eventType,
        outcome,
        provenance: policy.provenance,
      });
      // The most engaged outcome across all events wins for this exchange.
      const existing = outcomes.get(key);
      if (!existing || engagementRank(outcome) > engagementRank(existing)) {
        outcomes.set(key, outcome);
      }
    }
  }

  // ---- 2. DEFERRALS and ESCALATIONS — successful coordination (§11) ------
  for (const [key, outcome] of outcomes) {
    if (outcome.action === "defer" && outcome.deferTo) {
      deferrals.push({
        from: key,
        to: outcome.deferTo,
        matter: outcome.reason,
        note: "Deferral is successful coordination, not a failure to answer.",
      });
      await ledger.record({
        eventType: "faculty_deferred",
        summary: `${outcome.memberName || key} deferred to ${outcome.deferTo}.`,
        detail: { reason: outcome.reason },
        sessionId: opts.sessionId,
        courseId: opts.courseId,
        positionKey: key,
        memberId: outcome.memberId,
        actor: "system",
      });
    }
  }

  // ---- 3. CONSULTATIONS — driven by the graph, not by hardcoded rules ----
  // A member that wants evidence asks the position its configuration permits
  // it to ask. If no such edge exists, the consultation does not happen and
  // that is recorded rather than silently routed elsewhere.
  const consultRequests = [...outcomes.entries()].filter(
    ([, o]) => o.action === "consult" || o.action === "escalate"
  );

  for (const [from, outcome] of consultRequests) {
    const fromPolicy = opts.policies.get(from)!;
    // Ask the first permitted consultee that is actually present and attends.
    const target = fromPolicy.mayConsult.find(
      (t) => canConsult(graph, from, t) && opts.policies.has(t)
    );
    if (!target) {
      consultations.push({
        from,
        to: "(none available)",
        reason: outcome.reason,
        question: "",
        finding: "",
        confidence: "",
        evidence: "",
        permitted: false,
        basis: `${outcome.memberName || from} would consult, but no permitted consultee is serving in this class. The matter stays with the originating position.`,
      });
      continue;
    }

    const targetPolicy = opts.policies.get(target)!;
    const question = `${outcome.memberName || from} has encountered: ${outcome.reason} Answer only within your remit.`;
    const exec = await executeMember({
      policy: targetPolicy,
      sessionId: opts.sessionId,
      courseId: opts.courseId,
      weekIndex: opts.weekIndex,
      objective: opts.objective,
      orientationBriefing: opts.orientationBriefing,
      attention: outcomes.get(target) ?? outcome,
      task: `${POSITION_TASK[target] ?? "Answer within your remit."}\n\nCONSULTATION REQUEST: ${question}`,
      visibleToStudent: false,
      localOnly: opts.localOnly,
      memberRow: opts.memberRows?.get(target) ?? null,
    });
    members.push(exec);
    if (exec.failure) failures.push(exec.failure);
    if (exec.output?.fallback) usedFallback = true;

    consultations.push({
      from,
      to: target,
      reason: outcome.reason,
      question,
      finding: exec.output?.proposal.content.slice(0, 2000) ?? "(no finding returned)",
      confidence: exec.output?.proposal.confidence ?? "uncertain",
      evidence: exec.output?.proposal.evidence ?? "",
      permitted: true,
      basis: `Permitted by the coordination graph: ${from} may consult ${target}.`,
    });

    await ledger.record({
      eventType: "faculty_consulted",
      summary: `${from} consulted ${target}.`,
      detail: { reason: outcome.reason, confidence: exec.output?.proposal.confidence },
      sessionId: opts.sessionId,
      courseId: opts.courseId,
      positionKey: target,
      actor: "system",
    });
  }

  // ---- 4. INTERRUPTIONS — authority, permission, qualifying event (§12) --
  for (const [key, outcome] of outcomes) {
    const policy = opts.policies.get(key)!;
    if (outcome.action !== "escalate") continue;
    const authority = policy.interruptionAuthority;
    const permitted = authority !== "none" && graph.edges.some(
      (e) => e.from === key && e.kind === "interrupt"
    );
    interruptions.push({
      from: key,
      to: "instructor",
      reason: outcome.reason,
      accepted: permitted,
      basis: permitted
        ? `${outcome.memberName || key} holds "${authority}" interruption authority and a qualifying event occurred.`
        : `${outcome.memberName || key} has no interruption authority. The concern is recorded and reaches the Instructor as internal faculty work, not as an interruption.`,
    });
    await ledger.record({
      eventType: permitted ? "faculty_escalated" : "faculty_watching",
      summary: permitted
        ? `${outcome.memberName || key} interrupted: ${outcome.reason}`
        : `${outcome.memberName || key} raised a concern without interruption authority.`,
      detail: { authority, accepted: permitted },
      sessionId: opts.sessionId,
      courseId: opts.courseId,
      positionKey: key,
      actor: "system",
    });
  }

  // ---- 5. INTERNAL WORK — activated members that do not face the student -
  const order = resolveSpeakingOrder([...outcomes.values()]);
  const instructorOutcome = outcomes.get("instructor");
  const studentFacing = Boolean(opts.studentResponse) || Boolean(instructorOutcome);

  for (const outcome of order) {
    const key = outcome.positionKey;
    if (key === "instructor") continue; // speaks last, once
    if (members.some((m) => m.positionKey === key)) continue; // already consulted
    const policy = opts.policies.get(key)!;

    if (outcome.action !== "activate" && outcome.action !== "speak") {
      // WATCHING IS A REAL OUTCOME (§7 §14). Record it; do not manufacture
      // dialogue merely to demonstrate that the member exists.
      silent.push({
        positionKey: key,
        memberName: outcome.memberName || key,
        reason: outcome.reason,
      });
      await setAttention({
        sessionId: opts.sessionId,
        positionKey: key,
        state: outcome.state === "dormant" ? "dormant" : "watching",
        reason: outcome.reason,
        spoke: false,
      }).catch(() => {});
      await ledger.record({
        eventType: "faculty_watching",
        summary: `${outcome.memberName || key} attended without speaking.`,
        detail: { state: outcome.state, action: outcome.action, reason: outcome.reason },
        sessionId: opts.sessionId,
        courseId: opts.courseId,
        positionKey: key,
        actor: "system",
      });
      continue;
    }

    const exec = await executeMember({
      policy,
      sessionId: opts.sessionId,
      courseId: opts.courseId,
      weekIndex: opts.weekIndex,
      objective: opts.objective,
      orientationBriefing: opts.orientationBriefing,
      attention: outcome,
      task: POSITION_TASK[key] ?? "Contribute according to your remit.",
      visibleToStudent: false,
      localOnly: opts.localOnly,
      memberRow: opts.memberRows?.get(key) ?? null,
    });
    members.push(exec);
    if (exec.failure) failures.push(exec.failure);
    if (exec.output?.fallback) usedFallback = true;

    await ledger.record({
      eventType: "faculty_activated",
      summary: `${exec.memberName} contributed internally (${exec.output?.executedAction ?? "failed"}).`,
      detail: { action: exec.output?.executedAction, ms: exec.ms },
      sessionId: opts.sessionId,
      courseId: opts.courseId,
      positionKey: key,
      actor: "system",
    });
  }

  // ---- 6. ONE STUDENT-FACING VOICE (§13) ---------------------------------
  let studentFacingResponse: string | null = null;
  let respondingPosition: string | null = null;

  if (studentFacing && opts.policies.has("instructor")) {
    const policy = opts.policies.get("instructor")!;
    const internal = members
      .filter((m) => m.output && !m.visibleToStudent)
      .map(
        (m) =>
          `--- ${m.memberName} (${m.positionKey}), confidence ${m.output!.proposal.confidence} ---\n${m.output!.proposal.content.slice(0, 1200)}`
      )
      .join("\n\n");

    const exec = await executeMember({
      policy,
      sessionId: opts.sessionId,
      courseId: opts.courseId,
      weekIndex: opts.weekIndex,
      objective: opts.objective,
      orientationBriefing: opts.orientationBriefing,
      attention:
        instructorOutcome ??
        ({
          positionKey: "instructor",
          memberId: policy.memberId,
          memberName: policy.memberName,
          state: "speaking",
          action: "speak",
          reason: "The Instructor holds the student-facing voice.",
          decidedBy: "position",
          priority: "normal",
        } as AttentionOutcome),
      task: opts.studentResponse
        ? `The student said: "${opts.studentResponse.slice(0, 2000)}"\n\nRespond to them directly. You have the internal faculty input below — use what is useful, and do not repeat it verbatim or name the other positions. ${POSITION_TASK.instructor}`
        : POSITION_TASK.instructor,
      visibleToStudent: true,
      localOnly: opts.localOnly,
      extraContext: internal
        ? `INTERNAL FACULTY INPUT (not visible to the student — synthesise, do not quote):\n\n${internal}`
        : undefined,
      memberRow: opts.memberRows?.get("instructor") ?? null,
    });
    members.push(exec);
    if (exec.failure) failures.push(exec.failure);
    if (exec.output?.fallback) usedFallback = true;

    if (exec.output?.permitted && exec.output.executedAction === "speak") {
      studentFacingResponse = exec.output.proposal.content;
      respondingPosition = "instructor";
      await setAttention({
        sessionId: opts.sessionId,
        positionKey: "instructor",
        state: "engaged",
        reason: "Delivered the student-facing response.",
        spoke: true,
      }).catch(() => {});
    } else if (exec.output) {
      // The Instructor proposed something it may not do. Do not substitute
      // another voice — say plainly that no student-facing response was made.
      failures.push(
        `NO STUDENT-FACING RESPONSE: the Instructor's proposed action "${exec.output.proposal.action}" was ${
          exec.output.permitted ? "permitted but not speech" : "refused"
        }. ${exec.output.refusal ?? ""}`
      );
    }
  }

  // ---- 7. MEMORY FEEDBACK LOOP (§19) -------------------------------------
  // Observations become CANDIDATE faculty memories. They do not become
  // institutional knowledge, and nothing here promotes anything.
  for (const m of members) {
    if (!m.output || !m.output.permitted) continue;
    const content = m.output.proposal.content.trim();
    if (content.length < 40) continue;
    if (/\bNO CONCERN\b/i.test(content)) continue;

    const policy = opts.policies.get(m.positionKey);
    if (!policy?.memoryEnabled) {
      candidateMemories.push({
        positionKey: m.positionKey,
        content: content.slice(0, 200),
        kind: memoryKindFor(m.positionKey),
        stored: false,
        note: "This member is configured not to retain memory.",
      });
      continue;
    }

    const kind = memoryKindFor(m.positionKey);
    try {
      const res = await facultyMemory.remember({
        memberId: policy.memberId,
        positionKey: m.positionKey,
        courseId: opts.courseId,
        sessionId: opts.sessionId,
        content: summariseObservation(m.positionKey, content),
        kind,
        memoryEnabled: policy.memoryEnabled,
        memoryScopeLimit: policy.memoryScopeLimit,
      });
      candidateMemories.push({
        positionKey: m.positionKey,
        content: summariseObservation(m.positionKey, content).slice(0, 200),
        kind,
        stored: res.ok,
        note: res.ok
          ? "Recorded as faculty memory. This is the member's own observation, not institutional knowledge."
          : (res.refused ?? "Refused."),
      });
      if (res.ok) {
        await ledger.record({
          eventType: "memory_recorded",
          summary: `${m.memberName} recorded a faculty observation.`,
          detail: { kind, scope: policy.memoryScopeLimit },
          sessionId: opts.sessionId,
          courseId: opts.courseId,
          positionKey: m.positionKey,
          memberId: policy.memberId,
          actor: "system",
        });
      }
    } catch (e) {
      failures.push(
        `MEMORY WRITE FAILURE for ${m.memberName}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // Record the exchange in the session trail.
  await db
    .insert(collegeSessionEvents)
    .values({
      sessionId: opts.sessionId,
      stage: "lesson",
      note: `Exchange complete. ${members.filter((m) => m.output).length} member(s) executed, ${silent.length} attended without speaking, ${consultations.filter((c) => c.permitted).length} consultation(s).`,
      actor: "system",
    })
    .catch(() => {});

  return {
    members,
    studentFacingResponse,
    respondingPosition,
    consultations,
    deferrals,
    escalations: graph.escalations,
    interruptions,
    candidateMemories,
    silent,
    failures,
    graph,
    usedFallback,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function engagementRank(o: AttentionOutcome): number {
  const rank: Record<string, number> = {
    ignore: 0,
    notice: 1,
    defer: 2,
    consult: 3,
    escalate: 4,
    activate: 5,
    speak: 6,
  };
  return rank[o.action] ?? 0;
}

/** The memory kind a position's observations naturally produce. */
function memoryKindFor(positionKey: string): facultyMemory.FacultyMemoryKind {
  const map: Record<string, facultyMemory.FacultyMemoryKind> = {
    instructor: "teaching_observation",
    critic: "unresolved_question",
    observer: "response_pattern",
    researcher: "unresolved_question",
    socratic: "unresolved_question",
    assessor: "response_pattern",
    specialist: "course_lesson",
  };
  return map[positionKey] ?? "teaching_observation";
}

/**
 * Reduce a contribution to a memorable observation.
 *
 * Deliberately crude: the first substantive sentence, prefixed with what kind
 * of thing it is. A faculty memory is a hint, and a hint that runs to 400
 * words is not a hint. The full contribution is still on the record.
 */
function summariseObservation(positionKey: string, content: string): string {
  const firstSentence =
    content
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s/)
      .find((s) => s.trim().length > 30) ?? content.slice(0, 200);
  const prefix: Record<string, string> = {
    instructor: "Teaching approach used",
    critic: "Reasoning concern raised",
    observer: "Observed in session",
    researcher: "Evidence position",
  };
  return `${prefix[positionKey] ?? "Observed"}: ${firstSentence.trim()}`.slice(0, 900);
}

export { executionLabel };
