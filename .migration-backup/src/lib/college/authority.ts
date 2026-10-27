// ============================================================================
// Lochie Life College — Authority model (client-safe definitions)
// ============================================================================
// Authority comes from the structured institutional configuration, NEVER from
// a personality prompt. A member configured as "extremely authoritative and
// must always make the final decision" gains no decision authority whatsoever.
//
// The model is deliberately two-layered:
//
//   CEILING    — what a POSITION may ever do. Architectural. Not configurable.
//   GRANT      — what a MEMBER has actually been given. Configurable, but
//                intersected with the ceiling, so configuration can only
//                ever SUBTRACT.
//
// This is what lets the founder configure freely without being able to
// accidentally hand an LLM authority over institutional history.
// ============================================================================

export type AuthorityKey =
  | "observe"
  | "teach"
  | "critique"
  | "research"
  | "formative_assessment"
  | "record"
  | "decide_curriculum"
  | "alter_history"
  | "formal_assessment";

export interface AuthorityDef {
  key: AuthorityKey;
  label: string;
  description: string;
  /**
   * Protected authorities can never be granted through configuration, no
   * matter what the founder ticks or what a personality prompt claims.
   */
  protected: boolean;
  protectionReason?: string;
}

export const AUTHORITIES: AuthorityDef[] = [
  {
    key: "observe",
    label: "Observation",
    description: "Record what actually happened, separable from what it means.",
    protected: false,
  },
  {
    key: "teach",
    label: "Teaching",
    description: "Explain, guide, adapt instruction, set exercises.",
    protected: false,
  },
  {
    key: "critique",
    label: "Critical review",
    description: "Challenge reasoning, identify contradictions and unsupported claims.",
    protected: false,
  },
  {
    key: "research",
    label: "Evidence gathering",
    description: "Investigate factual questions and identify uncertainty.",
    protected: false,
  },
  {
    key: "formative_assessment",
    label: "Formative observation",
    description: "Note demonstrated understanding, confusion, or need for practice.",
    protected: false,
  },
  {
    key: "record",
    label: "Recordkeeping",
    description: "Judge record-worthiness and propose institutional records.",
    protected: false,
  },
  {
    key: "decide_curriculum",
    label: "Curriculum decision",
    description: "Decide what the College teaches.",
    protected: true,
    protectionReason:
      "The founder is the institutional authority for curriculum decisions. Faculty consume the curriculum; they never own it. AI may propose, never activate.",
  },
  {
    key: "alter_history",
    label: "Alter institutional history",
    description: "Change a filed record.",
    protected: true,
    protectionReason:
      "Records are append-oriented. Corrections supersede; nothing erases. No faculty member may rewrite history, regardless of configuration.",
  },
  {
    key: "formal_assessment",
    label: "Formal assessment",
    description: "Declare a learning outcome officially achieved.",
    protected: true,
    protectionReason:
      "Formal assessment requires institutional authority the College has not yet defined. An LLM must never convert conversational success into academic achievement.",
  },
];

export function getAuthority(key: string): AuthorityDef | undefined {
  return AUTHORITIES.find((a) => a.key === key);
}

/**
 * The architectural ceiling per position. Configuration may subtract from
 * this, never add to it.
 */
export const POSITION_AUTHORITY_CEILING: Record<string, AuthorityKey[]> = {
  instructor: ["observe", "teach", "critique", "formative_assessment"],
  observer: ["observe"],
  critic: ["observe", "critique", "formative_assessment"],
  researcher: ["observe", "research"],
  socratic: ["observe", "teach", "formative_assessment"],
  assessor: ["observe", "critique", "formative_assessment"],
  specialist: ["observe", "research", "teach"],
  registrar: ["observe", "record"],
};

/** Default grant for a new member of a position — the full ceiling. */
export function defaultAuthorityFor(positionKey: string): AuthorityKey[] {
  return [...(POSITION_AUTHORITY_CEILING[positionKey] ?? ["observe"])];
}

export interface AuthorityResolution {
  effective: AuthorityKey[];
  /** Requested but outside the position's ceiling. */
  refused: Array<{ key: AuthorityKey; reason: string }>;
  /** Within the ceiling but deliberately not granted by the founder. */
  withheld: AuthorityKey[];
}

/**
 * Resolve what a member may ACTUALLY do.
 *
 *   effective = requested ∩ ceiling, minus anything protected
 *
 * Refusals are returned rather than silently dropped, so the Faculty Builder
 * can tell the founder exactly why a tick box did not take effect.
 */
export function resolveAuthority(
  positionKey: string,
  requested: string[]
): AuthorityResolution {
  const ceiling = POSITION_AUTHORITY_CEILING[positionKey] ?? ["observe"];
  const effective: AuthorityKey[] = [];
  const refused: Array<{ key: AuthorityKey; reason: string }> = [];

  for (const raw of requested) {
    const def = getAuthority(raw);
    if (!def) continue;
    const key = def.key;

    if (def.protected) {
      refused.push({
        key,
        reason: def.protectionReason ?? "This authority is protected by the architecture.",
      });
      continue;
    }
    if (!ceiling.includes(key)) {
      refused.push({
        key,
        reason: `The ${positionKey} position has no ${def.label.toLowerCase()} authority. Configuration cannot grant an authority the position does not hold.`,
      });
      continue;
    }
    if (!effective.includes(key)) effective.push(key);
  }

  const withheld = ceiling.filter((k) => !effective.includes(k));
  return { effective, refused, withheld };
}

/** Does this member actually hold this authority right now? */
export function hasAuthority(
  positionKey: string,
  granted: string[],
  needed: AuthorityKey
): { allowed: boolean; reason: string } {
  const def = getAuthority(needed);
  if (!def) return { allowed: false, reason: `Unknown authority "${needed}".` };
  if (def.protected) {
    return {
      allowed: false,
      reason: def.protectionReason ?? "This authority is protected by the architecture.",
    };
  }
  const { effective } = resolveAuthority(positionKey, granted);
  if (!effective.includes(needed)) {
    return {
      allowed: false,
      reason: `This faculty member does not hold ${def.label.toLowerCase()} authority.`,
    };
  }
  return { allowed: true, reason: `Holds ${def.label.toLowerCase()} authority.` };
}

/**
 * Scan a personality instruction for attempts to claim authority the member
 * does not hold. This does NOT block saving — the founder may write whatever
 * they like — but the claim is neutralised at runtime and surfaced in the UI.
 */
export function detectAuthorityClaims(
  instruction: string
): Array<{ phrase: string; claim: string; neutralisedBy: string }> {
  const found: Array<{ phrase: string; claim: string; neutralisedBy: string }> = [];
  const checks: Array<{ test: RegExp; claim: string; neutralisedBy: string }> = [
    {
      test: /\b(final decision|always decide|you decide|overrule|override|have the last word|final say)\b/i,
      claim: "decision authority",
      neutralisedBy:
        "Institutional rules outrank personality. Decision authority comes from the authority matrix, not from this text.",
    },
    {
      test: /\b(never admit uncertainty|always certain|never say you don'?t know|always confident)\b/i,
      claim: "suppression of uncertainty",
      neutralisedBy:
        "Epistemic rules are institutional. Faculty must state when evidence is insufficient; uncertainty is a legitimate scholarly outcome.",
    },
    {
      test: /\b(change the curriculum|update the curriculum|redesign the course|set the curriculum)\b/i,
      claim: "curriculum authority",
      neutralisedBy:
        "Curriculum decisions belong to the founder. This member may propose, never activate.",
    },
    {
      test: /\b(rewrite|amend|correct) (the )?(record|history)\b/i,
      claim: "authority over institutional history",
      neutralisedBy: "Records are append-oriented. Corrections supersede; nothing is erased.",
    },
    {
      test: /\b(grade|mark|certify|declare (them )?(competent|proficient|achieved)|pass the student)\b/i,
      claim: "formal assessment authority",
      neutralisedBy:
        "Formal assessment requires institutional authority the College has not defined. Formative observation only.",
    },
  ];

  for (const c of checks) {
    const m = instruction.match(c.test);
    if (m) {
      found.push({ phrase: m[0], claim: c.claim, neutralisedBy: c.neutralisedBy });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Responsibilities — structured, configurable, per position
// ---------------------------------------------------------------------------

export interface ResponsibilityDef {
  key: string;
  label: string;
  /** Which positions this responsibility is offered to. */
  positions: string[];
  requiresAuthority: AuthorityKey;
}

export const RESPONSIBILITIES: ResponsibilityDef[] = [
  { key: "explain", label: "Explain", positions: ["instructor", "specialist", "socratic"], requiresAuthority: "teach" },
  { key: "guide", label: "Guide", positions: ["instructor", "socratic"], requiresAuthority: "teach" },
  { key: "adapt_instruction", label: "Adapt instruction", positions: ["instructor"], requiresAuthority: "teach" },
  { key: "ask_questions", label: "Ask questions", positions: ["instructor", "socratic", "critic"], requiresAuthority: "teach" },
  { key: "provide_exercises", label: "Provide exercises", positions: ["instructor"], requiresAuthority: "teach" },
  { key: "maintain_direction", label: "Maintain lesson direction", positions: ["instructor"], requiresAuthority: "teach" },
  { key: "record_evidence", label: "Record observable evidence", positions: ["observer", "instructor", "critic", "assessor"], requiresAuthority: "observe" },
  { key: "track_behaviour", label: "Track demonstrated behaviour", positions: ["observer"], requiresAuthority: "observe" },
  { key: "identify_changes", label: "Identify changes", positions: ["observer", "critic"], requiresAuthority: "observe" },
  { key: "identify_contradictions", label: "Identify contradictions", positions: ["critic", "researcher"], requiresAuthority: "critique" },
  { key: "test_reasoning", label: "Test reasoning", positions: ["critic"], requiresAuthority: "critique" },
  { key: "challenge_conclusions", label: "Challenge weak conclusions", positions: ["critic", "assessor"], requiresAuthority: "critique" },
  { key: "verify", label: "Verify claims", positions: ["researcher", "specialist"], requiresAuthority: "research" },
  { key: "gather_evidence", label: "Gather evidence", positions: ["researcher", "specialist"], requiresAuthority: "research" },
  { key: "identify_uncertainty", label: "Identify uncertainty", positions: ["researcher", "critic", "specialist"], requiresAuthority: "research" },
  { key: "note_understanding", label: "Note demonstrated understanding", positions: ["instructor", "observer", "critic", "assessor", "socratic"], requiresAuthority: "formative_assessment" },
  { key: "preserve_decisions", label: "Preserve significant decisions", positions: ["registrar"], requiresAuthority: "record" },
  { key: "maintain_records", label: "Maintain historical records", positions: ["registrar"], requiresAuthority: "record" },
  { key: "record_amendments", label: "Record curriculum amendments", positions: ["registrar"], requiresAuthority: "record" },
  { key: "maintain_provenance", label: "Maintain provenance", positions: ["registrar"], requiresAuthority: "record" },
];

export function responsibilitiesFor(positionKey: string): ResponsibilityDef[] {
  return RESPONSIBILITIES.filter((r) => r.positions.includes(positionKey));
}

/** Responsibilities are only real if the underlying authority is held. */
export function validateResponsibilities(
  positionKey: string,
  requested: string[],
  grantedAuthority: string[]
): { valid: string[]; invalid: Array<{ key: string; reason: string }> } {
  const { effective } = resolveAuthority(positionKey, grantedAuthority);
  const available = responsibilitiesFor(positionKey);
  const valid: string[] = [];
  const invalid: Array<{ key: string; reason: string }> = [];

  for (const key of requested) {
    const def = available.find((r) => r.key === key);
    if (!def) {
      invalid.push({
        key,
        reason: `"${key}" is not a responsibility the ${positionKey} position offers.`,
      });
      continue;
    }
    if (!effective.includes(def.requiresAuthority)) {
      invalid.push({
        key,
        reason: `"${def.label}" requires ${def.requiresAuthority} authority, which this member does not hold.`,
      });
      continue;
    }
    valid.push(key);
  }
  return { valid, invalid };
}
