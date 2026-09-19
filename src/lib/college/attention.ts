// ============================================================================
// Lochie Life College — Faculty attention policies (client-safe definitions)
// ============================================================================
// A faculty position is not a chatbot that answers everything. It is an
// institutional responsibility that knows:
//
//   WHEN to pay attention · WHAT to pay attention to · WHEN to act
//   WHEN to remain silent · WHEN to cooperate with another position
//
// This module is DECLARATIVE. It states policy. It performs no generation and
// makes no decisions by itself — `orchestrator.ts` evaluates these policies
// against real session events. The separation matters: attention must be
// inspectable and explainable before any model is involved.
//
// Nothing here is hardcoded into the class runner. A course may override the
// defaults through a faculty protocol (see `protocol.ts`).
// ============================================================================

import { getFacultyPosition } from "./faculty";

// ---------------------------------------------------------------------------
// Session phases
// ---------------------------------------------------------------------------
// A phase governs ATTENTION. It is distinct from the session `stage`, which
// records lifecycle position. These are defaults; a course protocol may
// declare a different phase plan.

export interface SessionPhaseDef {
  key: string;
  label: string;
  emoji: string;
  description: string;
  /** Positions expected to act in this phase. */
  defaultPrimary: string[];
  /** Positions expected to attend without speaking. */
  defaultWatching: string[];
}

/**
 * §15. The nine phases the specification names.
 *
 * Existing keys are NOT renamed. "inquiry", "challenge" and
 * "institutional_record" are already written into stored attention rows and
 * protocol configuration; renaming them to match the specification's wording
 * would silently invalidate history to win a vocabulary argument. The
 * specification's PRACTICE/ACTIVITY is this system's "practice", its
 * COORDINATION is "challenge" plus the coordination window, and its
 * POST-CLASS is "institutional_record".
 *
 * §16: not every class uses every phase, and participation is configuration-
 * driven. These lists are DEFAULTS for a position, overridden by member
 * configuration — they are not a fixed running order.
 */
export const SESSION_PHASES: SessionPhaseDef[] = [
  {
    key: "preparation",
    label: "Preparation",
    emoji: "🧾",
    description:
      "Before the student arrives: the runtime resolves slot, curriculum, faculty and memory. No teaching happens here and nothing is said.",
    defaultPrimary: [],
    defaultWatching: ["instructor", "observer"],
  },
  {
    key: "open",
    label: "Open",
    emoji: "🔑",
    description: "The class is declared open and the session record begins.",
    defaultPrimary: ["instructor"],
    defaultWatching: ["observer"],
  },
  {
    key: "orientation",
    label: "Orientation",
    emoji: "🧭",
    description: "The College establishes where it is before teaching begins.",
    defaultPrimary: ["instructor"],
    defaultWatching: ["observer"],
  },
  {
    key: "inquiry",
    label: "Research / Inquiry",
    emoji: "🔬",
    description: "A factual question is open and evidence is required.",
    defaultPrimary: ["instructor", "researcher"],
    defaultWatching: ["observer"],
  },
  {
    key: "teaching",
    label: "Teaching",
    emoji: "📖",
    description: "The objective is being taught.",
    defaultPrimary: ["instructor"],
    defaultWatching: ["observer", "critic"],
  },
  {
    key: "challenge",
    label: "Challenge / Discussion",
    emoji: "🔥",
    description: "Reasoning is being pressure-tested.",
    defaultPrimary: ["instructor", "critic"],
    defaultWatching: ["observer"],
  },
  {
    key: "practice",
    label: "Practice",
    emoji: "🔁",
    description: "The student is attempting the target skill.",
    defaultPrimary: ["instructor"],
    defaultWatching: ["observer"],
  },
  {
    key: "reflection",
    label: "Reflection",
    emoji: "🪞",
    description: "What was learned, what changed, what remains unclear.",
    defaultPrimary: ["instructor", "critic", "observer"],
    defaultWatching: [],
  },
  {
    key: "coordination",
    label: "Coordination",
    emoji: "🔗",
    description:
      "Faculty resolve matters between themselves — consultation, deferral, handoff. The student sees none of this.",
    defaultPrimary: [],
    defaultWatching: ["instructor", "observer", "critic", "researcher"],
  },
  {
    key: "closure",
    label: "Closure",
    emoji: "🔒",
    description:
      "The class ends: what happened, who participated, what remains open. Closure requires evidence, never the clock.",
    defaultPrimary: ["instructor"],
    defaultWatching: ["observer"],
  },
  {
    key: "institutional_record",
    label: "Institutional record (post-class)",
    emoji: "🗂️",
    description:
      "After the class: Administration evaluates whether anything must be recorded. Proposing a record is not filing one.",
    defaultPrimary: ["registrar"],
    defaultWatching: [],
  },
];

export function getPhase(key: string): SessionPhaseDef | undefined {
  return SESSION_PHASES.find((p) => p.key === key);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
// Faculty become active because an event falls within their remit.

export const SESSION_EVENT_TYPES = [
  "lesson_started",
  "learning_objective_changed",
  "student_response_received",
  "misconception_detected",
  "factual_uncertainty_detected",
  "contradiction_detected",
  "research_required",
  "learning_evidence_observed",
  "goal_conflict_detected",
  "timetable_deviation_detected",
  "decision_proposed",
  "decision_accepted",
  "record_worthy_event_detected",
  "session_phase_changed",
  "session_nearing_completion",
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Attention states
// ---------------------------------------------------------------------------
// Faculty participation is STATEFUL. A position can attend without speaking.

export const ATTENTION_STATES = [
  { key: "dormant", label: "Dormant", desc: "Not attending. No context consumed.", speaks: false },
  { key: "watching", label: "Watching", desc: "Attending and analysing, not speaking.", speaks: false },
  { key: "engaged", label: "Engaged", desc: "Acting within remit; may produce output.", speaks: true },
  { key: "consulting", label: "Consulting", desc: "Answering another position's request.", speaks: true },
  { key: "waiting", label: "Waiting", desc: "Awaiting a consultation response.", speaks: false },
  { key: "deferred", label: "Deferred", desc: "Matter belongs to another position.", speaks: false },
  { key: "escalated", label: "Escalated", desc: "Raised a concern requiring attention.", speaks: true },
  { key: "handing_off", label: "Handing off", desc: "Transferring responsibility.", speaks: false },
  { key: "completed", label: "Completed", desc: "Work in this session is finished.", speaks: false },
] as const;

export type AttentionState = (typeof ATTENTION_STATES)[number]["key"];

export function stateSpeaks(state: string): boolean {
  return ATTENTION_STATES.find((s) => s.key === state)?.speaks ?? false;
}

export function attentionStateLabel(state: string): string {
  return ATTENTION_STATES.find((s) => s.key === state)?.label ?? state;
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------
// Semantic, with explainable rules. Deliberately NOT a numerical score.

export type AttentionPriority = "low" | "normal" | "high" | "urgent";

export const PRIORITY_RULE: Record<AttentionPriority, string> = {
  low: "Observe only. Do not intervene.",
  normal: "Participate when the current phase makes this position relevant.",
  high: "Request consultation. Do not interrupt unilaterally.",
  urgent: "Interrupt the current activity — but only if interruption authority permits.",
};

const PRIORITY_ORDER: AttentionPriority[] = ["low", "normal", "high", "urgent"];

export function maxPriority(a: AttentionPriority, b: AttentionPriority): AttentionPriority {
  return PRIORITY_ORDER.indexOf(a) >= PRIORITY_ORDER.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Interruption authority
// ---------------------------------------------------------------------------
// Faculty do NOT all have equal standing to interrupt.

export type InterruptionAuthority =
  /** May never interrupt. Reports through observation or handoff. */
  | "none"
  /** May request attention; the request is queued, not forced. */
  | "request"
  /** May interrupt when the matter materially affects the lesson. */
  | "material"
  /** May interrupt to protect institutional integrity. */
  | "integrity";

// ---------------------------------------------------------------------------
// Attention policy
// ---------------------------------------------------------------------------

export interface AttentionPolicy {
  positionKey: string;
  /** What this position is watching for, in institutional terms. */
  attentionScope: string;
  /** Phases in which this position is relevant at all. */
  relevantPhases: string[];
  /** Events that wake this position. */
  triggers: Array<{ event: SessionEventType; priority: AttentionPriority; because: string }>;
  /** Evidence types this position cares about. */
  relevantEvidence: string[];
  /** Plain-language conditions under which the position activates. */
  activationConditions: string[];
  /** Conditions under which it escalates rather than acting alone. */
  escalationConditions: string[];
  interruptionAuthority: InterruptionAuthority;
  /** Positions this one may consult. */
  mayConsult: string[];
  /** Positions this one may hand responsibility to. */
  mayHandOffTo: string[];
  /** When this position attends but must NOT speak. */
  observationOnly: string[];
  /** When this position must stay quiet or defer entirely. */
  silenceConditions: string[];
  /** Matters that are NOT this position's to answer → defer to whom. */
  deferMatters: Array<{ matter: string; to: string }>;
  /** Default state when a session opens. */
  defaultState: AttentionState;
}

export const ATTENTION_POLICIES: AttentionPolicy[] = [
  // -------------------------------------------------------------------------
  {
    positionKey: "instructor",
    attentionScope:
      "The delivery of the active learning objective and the student's progress against it.",
    relevantPhases: ["orientation", "inquiry", "teaching", "challenge", "practice", "reflection"],
    triggers: [
      { event: "lesson_started", priority: "normal", because: "Teaching is the Instructor's remit." },
      {
        event: "learning_objective_changed",
        priority: "high",
        because: "What is being taught has changed.",
      },
      {
        event: "student_response_received",
        priority: "normal",
        because: "The student's response determines the next instructional move.",
      },
      {
        event: "misconception_detected",
        priority: "high",
        because: "A misunderstanding requires an instructional correction.",
      },
      {
        event: "timetable_deviation_detected",
        priority: "high",
        because: "Available time changes what can be taught.",
      },
      {
        event: "session_nearing_completion",
        priority: "normal",
        because: "The session must close with a named next step.",
      },
    ],
    relevantEvidence: ["demonstrated_understanding", "confusion", "misconception", "needs_practice"],
    activationConditions: [
      "A lesson is being delivered.",
      "The current learning objective is active.",
      "The student is attempting the target skill.",
      "Misunderstanding appears.",
      "The pace needs adjustment.",
      "The session needs instructional direction.",
    ],
    escalationConditions: [
      "The student is struggling and the explanation itself may be the problem — consult the Critic.",
      "A factual point cannot be confirmed — consult the Researcher.",
      "A question concerns the historical record — defer to Administration.",
    ],
    interruptionAuthority: "material",
    mayConsult: ["researcher", "critic", "observer", "specialist", "socratic"],
    mayHandOffTo: ["observer", "critic", "researcher", "registrar"],
    observationOnly: [
      "Another faculty position is conducting research.",
      "The student is independently demonstrating understanding.",
    ],
    silenceConditions: [
      "Registrar-only operations are in progress.",
      "The student is mid-attempt and has not asked for help.",
    ],
    deferMatters: [
      { matter: "What the historical record says or should say", to: "registrar" },
      { matter: "Whether a curriculum change should be made", to: "founder" },
      { matter: "Whether an outcome is formally achieved", to: "institutional authority" },
    ],
    defaultState: "engaged",
  },
  // -------------------------------------------------------------------------
  {
    positionKey: "researcher",
    attentionScope: "Factual accuracy and the sufficiency of evidence available to the session.",
    relevantPhases: ["inquiry", "teaching", "challenge"],
    triggers: [
      {
        event: "factual_uncertainty_detected",
        priority: "high",
        because: "An unverified claim is affecting the lesson.",
      },
      {
        event: "research_required",
        priority: "high",
        because: "The session has an open research question.",
      },
      {
        event: "contradiction_detected",
        priority: "high",
        because: "Conflicting claims require evidence to separate.",
      },
    ],
    relevantEvidence: ["external_source", "verification", "conflicting_claim"],
    activationConditions: [
      "Factual uncertainty appears.",
      "External knowledge is required.",
      "A claim requires verification.",
      "Additional resources may materially improve the lesson.",
    ],
    escalationConditions: [
      "Evidence contradicts what is being taught — escalate to the Instructor immediately.",
      "The College's own records conflict with each other — raise a reconciliation, do not choose a winner.",
    ],
    interruptionAuthority: "material",
    mayConsult: ["specialist", "critic"],
    mayHandOffTo: ["instructor", "critic"],
    observationOnly: ["A factual matter is settled and no verification was requested."],
    silenceConditions: [
      "No research question exists.",
      "The matter is experiential rather than factual.",
      "The student is practising a skill rather than asking about fact.",
    ],
    deferMatters: [
      { matter: "How something should be taught", to: "instructor" },
      { matter: "Whether the student understood", to: "observer" },
      { matter: "Whether the curriculum should change", to: "founder" },
    ],
    defaultState: "dormant",
  },
  // -------------------------------------------------------------------------
  {
    positionKey: "critic",
    attentionScope:
      "The soundness of reasoning — the College's own included — and the gap between claims and evidence.",
    relevantPhases: ["inquiry", "teaching", "challenge", "reflection"],
    triggers: [
      {
        event: "contradiction_detected",
        priority: "high",
        because: "Contradiction is the Critic's core remit.",
      },
      {
        event: "misconception_detected",
        priority: "normal",
        because: "The explanation, not the student, may be the cause.",
      },
      {
        event: "learning_evidence_observed",
        priority: "normal",
        because: "A learning claim must not exceed its evidence.",
      },
      {
        event: "decision_proposed",
        priority: "high",
        because: "A proposed decision should be pressure-tested before acceptance.",
      },
    ],
    relevantEvidence: ["incomplete_understanding", "conflicting_claim", "premature_conclusion"],
    activationConditions: [
      "An important assumption appears.",
      "Reasoning becomes questionable.",
      "Evidence conflicts.",
      "A faculty conclusion may be premature.",
      "A learning claim appears stronger than its evidence.",
    ],
    escalationConditions: [
      "A conclusion is about to become an institutional record on insufficient evidence.",
      "Teaching doctrine is being changed on the strength of a single session.",
    ],
    interruptionAuthority: "request",
    mayConsult: ["observer", "researcher"],
    mayHandOffTo: ["instructor", "registrar"],
    observationOnly: [
      "Ordinary conversation is proceeding without a reasoning problem.",
      "The student is practising rather than arguing.",
    ],
    silenceConditions: [
      "No genuine reasoning problem is present — do not critique ordinary conversation.",
      "The matter is administrative rather than intellectual.",
    ],
    deferMatters: [
      { matter: "Administrative or filing questions", to: "registrar" },
      { matter: "What actually happened in the room", to: "observer" },
    ],
    defaultState: "watching",
  },
  // -------------------------------------------------------------------------
  {
    positionKey: "observer",
    attentionScope: "What actually happened, separable from what it means.",
    relevantPhases: ["orientation", "inquiry", "teaching", "challenge", "practice", "reflection"],
    triggers: [
      {
        event: "student_response_received",
        priority: "normal",
        because: "The response is primary evidence.",
      },
      {
        event: "learning_evidence_observed",
        priority: "normal",
        because: "Evidence must be recorded as it occurred.",
      },
      {
        event: "misconception_detected",
        priority: "low",
        because: "Record where difficulty occurred without interpreting it.",
      },
    ],
    relevantEvidence: [
      "demonstrated_understanding",
      "confusion",
      "successful_explanation",
      "incomplete_understanding",
      "needs_practice",
    ],
    activationConditions: [
      "Relevant learning activity is occurring.",
      "The student demonstrates, attempts, or struggles with something observable.",
    ],
    escalationConditions: [
      "Observed evidence directly contradicts a claim another position is making.",
    ],
    interruptionAuthority: "none",
    mayConsult: [],
    mayHandOffTo: ["critic", "instructor", "registrar"],
    observationOnly: [
      "Throughout teaching — the Observer attends continuously and speaks rarely.",
    ],
    silenceConditions: [
      "An observation would interrupt teaching merely to report it.",
      "The observation is an interpretation rather than an observation.",
    ],
    deferMatters: [
      { matter: "What the evidence means", to: "critic" },
      { matter: "Whether the outcome is achieved", to: "institutional authority" },
      { matter: "Whether it should be filed", to: "registrar" },
    ],
    defaultState: "watching",
  },
  // -------------------------------------------------------------------------
  {
    positionKey: "socratic",
    attentionScope: "The development of independent judgement through questioning.",
    relevantPhases: ["teaching", "challenge", "reflection"],
    triggers: [
      {
        event: "student_response_received",
        priority: "low",
        because: "A response may be better met with a question than an answer.",
      },
      {
        event: "learning_evidence_observed",
        priority: "low",
        because: "Understanding is tested by questioning, not assertion.",
      },
    ],
    relevantEvidence: ["demonstrated_understanding", "incomplete_understanding"],
    activationConditions: [
      "The student would learn more from a question than from an answer.",
      "Independent judgement is the objective.",
    ],
    escalationConditions: [],
    interruptionAuthority: "none",
    mayConsult: [],
    mayHandOffTo: ["instructor"],
    observationOnly: ["The student is receiving direct instruction they asked for."],
    silenceConditions: [
      "The student requested a direct answer — do not turn it into a lecture.",
      "Time is constrained by a timetable deviation.",
    ],
    deferMatters: [{ matter: "Supplying conclusions", to: "instructor" }],
    defaultState: "dormant",
  },
  // -------------------------------------------------------------------------
  {
    positionKey: "assessor",
    attentionScope: "Whether evidence demonstrates the intended capability.",
    relevantPhases: ["reflection", "institutional_record"],
    triggers: [
      {
        event: "learning_evidence_observed",
        priority: "normal",
        because: "Evidence is the Assessor's input.",
      },
    ],
    relevantEvidence: ["demonstrated_understanding", "successful_explanation", "needs_practice"],
    activationConditions: ["Evidence exists and a capability judgement has been requested."],
    escalationConditions: [
      "Evidence is being treated as a formal outcome — that authority does not exist.",
    ],
    interruptionAuthority: "request",
    mayConsult: ["observer", "critic"],
    mayHandOffTo: ["registrar", "instructor"],
    observationOnly: ["Teaching is in progress and no capability judgement was requested."],
    silenceConditions: ["No evidence has been collected yet."],
    deferMatters: [
      { matter: "Declaring an outcome formally achieved", to: "institutional authority" },
    ],
    defaultState: "dormant",
  },
  // -------------------------------------------------------------------------
  {
    positionKey: "specialist",
    attentionScope: "Domain depth for a specific School or subject.",
    relevantPhases: ["inquiry", "teaching"],
    triggers: [
      {
        event: "research_required",
        priority: "normal",
        because: "Domain expertise may be required.",
      },
    ],
    relevantEvidence: ["external_source"],
    activationConditions: ["The session requires depth this domain holds."],
    escalationConditions: [],
    interruptionAuthority: "none",
    mayConsult: ["researcher"],
    mayHandOffTo: ["instructor", "researcher"],
    observationOnly: ["The material is within general instruction."],
    silenceConditions: ["No domain-specific question is open."],
    deferMatters: [{ matter: "General instruction", to: "instructor" }],
    defaultState: "dormant",
  },
  // -------------------------------------------------------------------------
  // ADMINISTRATION. Dormant during ordinary teaching, by institutional design.
  {
    positionKey: "registrar",
    attentionScope:
      "Institutional history: what must be recorded, corrected, or preserved. Not teaching.",
    relevantPhases: ["institutional_record"],
    triggers: [
      {
        event: "record_worthy_event_detected",
        priority: "high",
        because: "A record-worthy event is precisely the Registrar's remit.",
      },
      {
        event: "decision_accepted",
        priority: "high",
        because: "An institutional decision has been made.",
      },
      {
        event: "session_nearing_completion",
        priority: "normal",
        because: "Session close is when worthiness is evaluated.",
      },
    ],
    relevantEvidence: ["institutional_decision", "milestone", "correction"],
    activationConditions: [
      "A record-worthy event occurs.",
      "An institutional decision is made.",
      "A curriculum amendment occurs.",
      "A milestone is reached.",
      "A historical correction is required.",
      "A meaningful institutional state change needs recording.",
    ],
    escalationConditions: ["A previously filed record is found to be wrong — a correction supersedes it."],
    interruptionAuthority: "integrity",
    mayConsult: ["observer"],
    mayHandOffTo: [],
    observationOnly: ["Ordinary teaching — the Registrar does not attend."],
    silenceConditions: [
      "Nothing record-worthy has occurred.",
      "Teaching is in progress and the matter is routine recordkeeping.",
      "Every ordinary conversational turn — the Registrar is not a participant.",
    ],
    deferMatters: [
      { matter: "How to teach something", to: "instructor" },
      { matter: "Whether reasoning is sound", to: "critic" },
      { matter: "What the student understood", to: "observer" },
    ],
    defaultState: "dormant",
  },
];

export function getAttentionPolicy(positionKey: string): AttentionPolicy | undefined {
  return ATTENTION_POLICIES.find((p) => p.positionKey === positionKey);
}

/**
 * Does this event fall within the position's remit, and at what priority?
 * Returns null when the position should NOT wake — silence is a real answer.
 */
export function evaluateTrigger(
  positionKey: string,
  eventType: string
): { priority: AttentionPriority; because: string } | null {
  const policy = getAttentionPolicy(positionKey);
  if (!policy) return null;
  const t = policy.triggers.find((x) => x.event === eventType);
  return t ? { priority: t.priority, because: t.because } : null;
}

/**
 * May this position interrupt, given the urgency and who it would interrupt?
 * Every interruption needs a reason; arbitrary model confidence is not one.
 */
export function mayInterrupt(
  positionKey: string,
  urgency: AttentionPriority,
  opts: { materiallyAffectsLesson?: boolean; institutionalIntegrity?: boolean } = {}
): { allowed: boolean; reason: string } {
  const policy = getAttentionPolicy(positionKey);
  const position = getFacultyPosition(positionKey);
  if (!policy || !position) {
    return { allowed: false, reason: `Unknown position "${positionKey}".` };
  }

  switch (policy.interruptionAuthority) {
    case "none":
      return {
        allowed: false,
        reason: `${position.name} has no interruption authority. It must report through observation or a handoff, not by interrupting teaching.`,
      };
    case "request":
      return {
        allowed: false,
        reason: `${position.name} may request attention but may not interrupt unilaterally. Raise a consultation instead.`,
      };
    case "material":
      if (urgency === "urgent" || opts.materiallyAffectsLesson) {
        return {
          allowed: true,
          reason: `${position.name} may interrupt when the matter materially affects the lesson.`,
        };
      }
      return {
        allowed: false,
        reason: `${position.name} may only interrupt when the matter materially affects the lesson. This does not.`,
      };
    case "integrity":
      if (opts.institutionalIntegrity || urgency === "urgent") {
        return {
          allowed: true,
          reason: `${position.name} may interrupt to protect institutional integrity.`,
        };
      }
      return {
        allowed: false,
        reason: `${position.name} should not interrupt teaching for routine recordkeeping.`,
      };
  }
}

/**
 * Role creep guard. Given a matter, does it belong to this position?
 * Faculty must know: "What is mine? What belongs to another position?"
 */
export function checkRemit(
  positionKey: string,
  matter: string
): { inRemit: boolean; deferTo?: string; reason: string } {
  const policy = getAttentionPolicy(positionKey);
  const position = getFacultyPosition(positionKey);
  if (!policy || !position) {
    return { inRemit: false, reason: `Unknown position "${positionKey}".` };
  }
  const lowered = matter.toLowerCase();
  for (const d of policy.deferMatters) {
    const words = d.matter
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4);
    const hits = words.filter((w) => lowered.includes(w)).length;
    if (hits >= 2) {
      return {
        inRemit: false,
        deferTo: d.to,
        reason: `"${d.matter}" is not ${position.name}'s to answer. Defer to ${d.to}.`,
      };
    }
  }
  return { inRemit: true, reason: `Within ${position.name}'s remit.` };
}

/** May A consult B? Consultation is governed, not ad-hoc. */
export function mayConsult(from: string, to: string): { allowed: boolean; reason: string } {
  const policy = getAttentionPolicy(from);
  const a = getFacultyPosition(from);
  const b = getFacultyPosition(to);
  if (!policy || !a) return { allowed: false, reason: `Unknown position "${from}".` };
  if (!b) return { allowed: false, reason: `Unknown position "${to}".` };
  if (from === to) return { allowed: false, reason: "A position cannot consult itself." };
  if (!policy.mayConsult.includes(to)) {
    return {
      allowed: false,
      reason: `${a.name} may not consult ${b.name}. Permitted: ${
        policy.mayConsult.length ? policy.mayConsult.join(", ") : "none"
      }.`,
    };
  }
  return { allowed: true, reason: `${a.name} may consult ${b.name}.` };
}

/** May A hand responsibility to B? */
export function mayHandOff(from: string, to: string): { allowed: boolean; reason: string } {
  const policy = getAttentionPolicy(from);
  const a = getFacultyPosition(from);
  const b = getFacultyPosition(to);
  if (!policy || !a) return { allowed: false, reason: `Unknown position "${from}".` };
  if (!b) return { allowed: false, reason: `Unknown position "${to}".` };
  if (!policy.mayHandOffTo.includes(to)) {
    return {
      allowed: false,
      reason: `${a.name} may not hand off to ${b.name}. Permitted: ${
        policy.mayHandOffTo.length ? policy.mayHandOffTo.join(", ") : "none"
      }.`,
    };
  }
  return { allowed: true, reason: `${a.name} may hand off to ${b.name}.` };
}
