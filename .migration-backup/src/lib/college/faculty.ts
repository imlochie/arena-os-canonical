// ============================================================================
// Lochie Life College — Faculty positions (client-safe definitions)
// ============================================================================
// Faculty are institutional RESPONSIBILITIES, not interchangeable chat
// personalities. Each position has a remit, an authority boundary, a bounded
// context scope, and an output type. Positions may disagree; disagreement is
// preserved rather than collapsed into one synthetic answer.
//
// Derivation is marked honestly:
//   canon-derived → named or directly implied by handbook/Faculty instructions
//   inferred      → a reasonable reading of canon, not stated verbatim
//   proposed      → suggested by the build brief, awaiting ratification
// ============================================================================

export type FacultyDerivation = "canon-derived" | "inferred" | "proposed";

/**
 * Institutional branch. Correction accepted from the founder: Administration
 * is NOT a teaching faculty member.
 *
 *   Faculty teach, observe and interpret.
 *   Administration classifies, verifies and files.
 *
 * The Registrar is therefore an administrative FUNCTION invoked when a session
 * produces something record-worthy — not a participant in every class.
 */
export type InstitutionalBranch = "faculty" | "administration";

/**
 * Authority to make statements about learning. Split per founder correction:
 * an AI teacher must be able to observe learning without being able to declare
 * a learning outcome officially achieved.
 */
export type AssessmentAuthority =
  | "none" // may not make statements about attainment at all
  | "formative" // may record observed evidence of learning
  | "formal"; // may declare an outcome officially assessed — institutional authority only

export interface FacultyPosition {
  key: string;
  name: string;
  emoji: string;
  /** faculty = educational actor · administration = record-keeping function */
  branch: InstitutionalBranch;
  remit: string;
  /** What this position may NOT do. Enforced by the runtime, not just prose. */
  authorityBoundary: string;
  /** Registrar proposes records; only filing makes them institutional. */
  mayFileRecords: boolean;
  /**
   * Replaces the old coarse `mayAssess: false`. Faculty may record formative
   * observations about learning; nobody may issue a FORMAL assessment without
   * institutional authority the College has not yet defined.
   */
  assessmentAuthority: AssessmentAuthority;
  /** Does this position participate in teaching sessions at all? */
  participatesInClass: boolean;
  outputType: string;
  /** Which context packet keys this position receives (bounded context). */
  contextScope: string[];
  /** Maps onto an existing Workforce role where one genuinely fits. */
  workforceRoleId: string;
  derivation: FacultyDerivation;
  sourceKey: string;
  /** The question this position exists to answer. */
  question: string;
}

export const FACULTY_POSITIONS: FacultyPosition[] = [
  {
    key: "instructor",
    name: "Instructor",
    emoji: "🎓",
    branch: "faculty",
    remit:
      "Teach principles before techniques, build understanding, adapt to the student's current level and stated intent.",
    authorityBoundary:
      "May teach and recommend. May not change curriculum, file records, or declare institutional decisions.",
    mayFileRecords: false,
    assessmentAuthority: "formative",
    participatesInClass: true,
    outputType: "lesson / explanation / tutorial",
    contextScope: ["position", "course", "objective", "prior_learning", "context_signals", "goals"],
    workforceRoleId: "editor",
    derivation: "canon-derived",
    sourceKey: "faculty_teaching_standard",
    question: "What should be taught?",
  },
  {
    key: "researcher",
    name: "Researcher",
    emoji: "🔬",
    branch: "faculty",
    remit: "Establish what information is relevant, accurate and sufficient for the session.",
    authorityBoundary:
      "May supply evidence and cite limits. May not assess the student or file records.",
    mayFileRecords: false,
    assessmentAuthority: "none",
    participatesInClass: true,
    outputType: "evidence brief",
    contextScope: ["position", "course", "objective", "open_questions"],
    workforceRoleId: "researcher",
    derivation: "canon-derived",
    sourceKey: "faculty_ai_instructions",
    question: "What information is relevant?",
  },
  {
    key: "critic",
    name: "Critic",
    emoji: "🔥",
    branch: "faculty",
    remit:
      "Pressure-test the current understanding. Surface assumptions, counter-evidence and overstated confidence.",
    authorityBoundary:
      "May dissent and must be recorded when it does. May not overrule the Instructor or file records.",
    mayFileRecords: false,
    assessmentAuthority: "formative",
    participatesInClass: true,
    outputType: "critique / dissent",
    contextScope: ["position", "course", "objective", "prior_learning", "teaching_memory"],
    workforceRoleId: "critic",
    derivation: "canon-derived",
    sourceKey: "faculty_ai_instructions",
    question: "Is the current understanding actually sound?",
  },
  {
    key: "registrar",
    name: "Registrar",
    emoji: "🗂️",
    branch: "administration",
    remit:
      "Identify what is record-worthy, propose institutional records with provenance, and preserve chronology.",
    authorityBoundary:
      "PROPOSES records only. Filing is a separate institutional act requiring explicit approval. Never rewrites history — corrections supersede.",
    mayFileRecords: false,
    assessmentAuthority: "none",
    participatesInClass: false,
    outputType: "record proposal",
    contextScope: ["position", "session_outcome", "institutional_state", "prior_records"],
    workforceRoleId: "operator",
    derivation: "canon-derived",
    sourceKey: "information_flow_protocol",
    question: "What historical fact needs to be recorded?",
  },
  {
    key: "observer",
    name: "Observer",
    emoji: "👁️",
    branch: "faculty",
    remit:
      "Record what actually happened during the session without interpreting it: evidence, friction, what was produced.",
    authorityBoundary:
      "Records observations only. May not interpret, assess, or file. Observation must stay separable from interpretation.",
    mayFileRecords: false,
    assessmentAuthority: "formative",
    participatesInClass: true,
    outputType: "observation log",
    contextScope: ["position", "session_outcome"],
    workforceRoleId: "",
    derivation: "proposed",
    sourceKey: "build_brief",
    question: "What actually happened?",
  },
  {
    key: "assessor",
    name: "Assessor",
    emoji: "📐",
    branch: "faculty",
    remit:
      "Judge whether evidence demonstrates the intended capability, against authentic-project criteria.",
    authorityBoundary:
      "Produces RECOMMENDED assessments only. Formal academic judgement requires human acceptance — an open decision the founder has not yet resolved.",
    mayFileRecords: false,
    assessmentAuthority: "formative",
    participatesInClass: true,
    outputType: "recommended assessment",
    contextScope: ["position", "course", "objective", "evidence", "capabilities"],
    workforceRoleId: "strategist",
    derivation: "inferred",
    sourceKey: "academic_course_design_standards",
    question: "Does the evidence demonstrate capability?",
  },
  {
    key: "specialist",
    name: "Specialist",
    emoji: "🧪",
    branch: "faculty",
    remit: "Provide domain depth for a specific School or subject when a session needs it.",
    authorityBoundary: "Advisory within its domain. No institutional authority.",
    mayFileRecords: false,
    assessmentAuthority: "none",
    participatesInClass: true,
    outputType: "domain guidance",
    contextScope: ["position", "course", "objective"],
    workforceRoleId: "engineer",
    derivation: "proposed",
    sourceKey: "build_brief",
    question: "What does this domain require?",
  },
  {
    key: "socratic",
    name: "Socratic Faculty",
    emoji: "❓",
    branch: "faculty",
    remit:
      "Develop independent judgement by questioning rather than answering. Encourage reflection.",
    authorityBoundary: "Asks questions. Does not supply conclusions or file records.",
    mayFileRecords: false,
    assessmentAuthority: "formative",
    participatesInClass: true,
    outputType: "questions",
    contextScope: ["position", "objective", "prior_learning"],
    workforceRoleId: "critic",
    derivation: "canon-derived",
    sourceKey: "faculty_ai_instructions",
    question: "What question would develop understanding?",
  },
];

export function getFacultyPosition(key: string): FacultyPosition | undefined {
  return FACULTY_POSITIONS.find((p) => p.key === key);
}

// ---------------------------------------------------------------------------
// Session kinds → required faculty composition
// ---------------------------------------------------------------------------
// Composition is contextual. Nothing is hardcoded to "always these four".
export interface SessionKindDef {
  key: string;
  name: string;
  emoji: string;
  description: string;
  requiredPositions: string[];
  optionalPositions: string[];
  /** Lifecycle stages this kind actually uses — not every class uses all. */
  stages: string[];
}

export const SESSION_KINDS: SessionKindDef[] = [
  {
    key: "lesson",
    name: "Lesson",
    emoji: "📖",
    description: "Standard teaching session against a weekly objective.",
    requiredPositions: ["instructor", "observer"],
    optionalPositions: ["socratic", "researcher"],
    stages: ["orientation", "context_check", "lesson", "practice", "reflection", "close"],
  },
  {
    key: "practice",
    name: "Practice",
    emoji: "🔁",
    description: "Skill repetition. Light on instruction, heavy on doing.",
    requiredPositions: ["instructor", "observer"],
    optionalPositions: [],
    stages: ["context_check", "practice", "reflection", "close"],
  },
  {
    key: "research",
    name: "Research Session",
    emoji: "🔬",
    description: "Investigation-heavy session requiring evidence and scrutiny.",
    requiredPositions: ["instructor", "researcher", "critic"],
    optionalPositions: [],
    stages: ["orientation", "context_check", "inquiry", "understanding", "reflection", "close"],
  },
  {
    key: "retrospective",
    name: "Retrospective",
    emoji: "🪞",
    description: "Looking back over delivered work to consolidate and correct.",
    requiredPositions: ["instructor", "critic"],
    optionalPositions: ["observer"],
    stages: ["orientation", "understanding", "reflection", "faculty_record", "close"],
  },
  {
    key: "assessment",
    name: "Assessment Review",
    emoji: "📐",
    description: "Reviewing evidence against intended capability.",
    requiredPositions: ["assessor", "observer"],
    optionalPositions: ["critic"],
    stages: ["context_check", "understanding", "faculty_record", "close"],
  },
  {
    key: "direct_support",
    name: "Direct Support",
    emoji: "🛟",
    description:
      "Efficient factual help or a completed task. Not every interaction must become a lecture.",
    requiredPositions: ["instructor"],
    optionalPositions: [],
    stages: ["close"],
  },
];

export function getSessionKind(key: string): SessionKindDef {
  return SESSION_KINDS.find((s) => s.key === key) ?? SESSION_KINDS[0];
}

/**
 * Determine which faculty positions a session requires, with the reason for
 * each. Derived from the session kind, then adjusted for actual circumstances.
 */
/**
 * Determine which FACULTY positions a session requires, with the reason for
 * each.
 *
 * Administration is deliberately excluded. Per the institutional correction,
 * the Registrar does not attend class; it is invoked afterwards, only if the
 * session produced something record-worthy. See `registrar.ts`.
 */
export function deriveFacultyComposition(
  sessionKind: string,
  signals: { hasOpenDeviation?: boolean; isRevisit?: boolean; needsEvidence?: boolean } = {}
): Array<{ positionKey: string; reason: string; required: boolean }> {
  const kind = getSessionKind(sessionKind);
  const teachingOnly = (k: string) => {
    const p = getFacultyPosition(k);
    return Boolean(p && p.branch === "faculty" && p.participatesInClass);
  };

  const out: Array<{ positionKey: string; reason: string; required: boolean }> = kind.requiredPositions
    .filter(teachingOnly)
    .map((p) => ({
      positionKey: p,
      reason: `Required by session kind "${kind.name}".`,
      required: true,
    }));
  const has = (k: string) => out.some((o) => o.positionKey === k);

  if (signals.isRevisit && !has("critic") && teachingOnly("critic")) {
    out.push({
      positionKey: "critic",
      reason: "Revisiting prior material; previous understanding should be pressure-tested.",
      required: false,
    });
  }
  if (signals.needsEvidence && !has("researcher") && teachingOnly("researcher")) {
    out.push({
      positionKey: "researcher",
      reason: "Session requires supporting evidence.",
      required: false,
    });
  }
  if (signals.hasOpenDeviation && !has("observer") && teachingOnly("observer")) {
    out.push({
      positionKey: "observer",
      reason: "An open deviation exists; what actually happens should be recorded carefully.",
      required: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
export const SESSION_STAGES = [
  { key: "scheduled", label: "Scheduled", desc: "Exists on the timetable; not yet begun." },
  { key: "orientation", label: "Orientation", desc: "Where we are, what this session is for." },
  { key: "context_check", label: "Context check", desc: "Real-world conditions affecting today." },
  { key: "lesson", label: "Lesson", desc: "Principles and explanation." },
  { key: "practice", label: "Practice", desc: "Applied work." },
  { key: "inquiry", label: "Inquiry", desc: "Questions, investigation, Socratic pressure." },
  { key: "understanding", label: "Understanding", desc: "What is now understood, and what is not." },
  { key: "reflection", label: "Reflection", desc: "Student reflection and honest self-report." },
  { key: "close", label: "Close", desc: "Session ends; next smallest step named." },
  { key: "faculty_record", label: "Faculty record", desc: "Faculty writes what it observed." },
  { key: "institutional_update", label: "Institutional update", desc: "Registrar proposes records." },
] as const;

export type SessionStage = (typeof SESSION_STAGES)[number]["key"];

export function stageLabel(key: string): string {
  return SESSION_STAGES.find((s) => s.key === key)?.label ?? key;
}
