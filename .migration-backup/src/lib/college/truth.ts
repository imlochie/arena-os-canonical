// ============================================================================
// Lochie Life College — truth model (client-safe, no db imports)
// ============================================================================
// Handbook §12. Five categories that must never silently convert into one
// another. This module is the single definition of that vocabulary so the
// state engine, the faculty runtime and the UI cannot drift apart.
// ============================================================================

/** What kind of claim is this? */
export type TruthClass =
  | "fact" // supported observation or filed record
  | "interpretation" // reasoned understanding built on facts
  | "decision" // deliberate institutional choice
  | "expectation" // what should happen (timetable, plan)
  | "unknown" // insufficient information — a legitimate answer
  | "conflict"; // sources disagree — must stay visible

/** How well is the claim supported? */
export type Confidence = "known" | "inferred" | "expected" | "unknown" | "conflicting";

/** Epistemic ladder for educational memory (Handbook §8). */
export type EpistemicStatus = "observation" | "interpretation" | "hypothesis" | "established";

export const TRUTH_CLASSES: TruthClass[] = [
  "fact",
  "interpretation",
  "decision",
  "expectation",
  "unknown",
  "conflict",
];

export const TRUTH_LABEL: Record<TruthClass, string> = {
  fact: "FACT",
  interpretation: "INTERPRETATION",
  decision: "DECISION",
  expectation: "EXPECTATION",
  unknown: "UNKNOWN",
  conflict: "CONFLICT",
};

export const TRUTH_MEANING: Record<TruthClass, string> = {
  fact: "Supported by an observation or a filed record.",
  interpretation: "A reasoned reading of the evidence, not the evidence itself.",
  decision: "A deliberate institutional choice that was actually made.",
  expectation: "What should happen according to plan or timetable.",
  unknown: "The institution does not have enough information. This is legitimate.",
  conflict: "Authoritative sources disagree. Not resolved by the system.",
};

/** Tailwind classes per truth class — one visual language across the UI. */
export const TRUTH_STYLE: Record<TruthClass, string> = {
  fact: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  interpretation: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  decision: "border-violet-500/40 bg-violet-500/10 text-violet-200",
  expectation: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  unknown: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  conflict: "border-rose-500/50 bg-rose-500/10 text-rose-200",
};

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  known: "KNOWN",
  inferred: "INFERRED",
  expected: "EXPECTED",
  unknown: "UNKNOWN",
  conflicting: "CONFLICTING",
};

export const EPISTEMIC_LABEL: Record<EpistemicStatus, string> = {
  observation: "Observation",
  interpretation: "Interpretation",
  hypothesis: "Pedagogical hypothesis",
  established: "Established knowledge",
};

export const EPISTEMIC_ORDER: EpistemicStatus[] = [
  "observation",
  "interpretation",
  "hypothesis",
  "established",
];

/**
 * A claim the institution holds. Every assertion surfaced to the student
 * carries its class, its confidence and where it came from — so the UI can
 * never present an inference as a fact.
 */
export interface Claim<T = unknown> {
  value: T;
  truthClass: TruthClass;
  confidence: Confidence;
  /** Human-readable provenance, e.g. "Academic Calendar (Source of Truth)". */
  provenance: string;
  /** Stable source key when the claim came from a registered source. */
  sourceKey?: string;
  /** Present when truthClass === "conflict": the competing readings. */
  conflictWith?: string[];
  note?: string;
}

export function fact<T>(value: T, provenance: string, sourceKey?: string): Claim<T> {
  return { value, truthClass: "fact", confidence: "known", provenance, sourceKey };
}

export function interpretation<T>(value: T, provenance: string, note?: string): Claim<T> {
  return { value, truthClass: "interpretation", confidence: "inferred", provenance, note };
}

export function decision<T>(value: T, provenance: string): Claim<T> {
  return { value, truthClass: "decision", confidence: "known", provenance };
}

export function expectation<T>(value: T, provenance: string, sourceKey?: string): Claim<T> {
  return { value, truthClass: "expectation", confidence: "expected", provenance, sourceKey };
}

export function unknown(provenance: string, note?: string): Claim<null> {
  return { value: null, truthClass: "unknown", confidence: "unknown", provenance, note };
}

export function conflict<T>(
  value: T,
  provenance: string,
  conflictWith: string[],
  note?: string
): Claim<T> {
  return {
    value,
    truthClass: "conflict",
    confidence: "conflicting",
    provenance,
    conflictWith,
    note,
  };
}

/**
 * Promotion rules for educational memory. The institution must be able to
 * explain WHY a teaching belief changed, so promotion is gated on
 * corroboration and never happens automatically from a single observation.
 */
export const PROMOTION_RULES: Record<
  EpistemicStatus,
  { next: EpistemicStatus | null; minCorroboration: number; rationale: string }
> = {
  observation: {
    next: "interpretation",
    minCorroboration: 1,
    rationale: "A single observation may be interpreted, but interpretation stays labelled.",
  },
  interpretation: {
    next: "hypothesis",
    minCorroboration: 2,
    rationale:
      "Two independent observations are required before a reading becomes a teaching hypothesis.",
  },
  hypothesis: {
    next: "established",
    minCorroboration: 3,
    rationale:
      "Three corroborating observations are required before a hypothesis becomes established practice.",
  },
  established: {
    next: null,
    minCorroboration: 0,
    rationale: "Established knowledge is revised by superseding it, not by further promotion.",
  },
};

export function canPromote(
  status: EpistemicStatus,
  corroborationCount: number
): { allowed: boolean; next: EpistemicStatus | null; reason: string } {
  const rule = PROMOTION_RULES[status];
  if (!rule.next) {
    return { allowed: false, next: null, reason: rule.rationale };
  }
  if (corroborationCount < rule.minCorroboration) {
    return {
      allowed: false,
      next: rule.next,
      reason: `Needs ${rule.minCorroboration} corroborating observations, has ${corroborationCount}. ${rule.rationale}`,
    };
  }
  return { allowed: true, next: rule.next, reason: rule.rationale };
}

/** Render a claim as a labelled line for prompts and exports. */
export function claimLine(label: string, c: Claim): string {
  const v =
    c.value === null || c.value === undefined || c.value === ""
      ? "(no value)"
      : typeof c.value === "object"
        ? JSON.stringify(c.value)
        : String(c.value);
  const base = `[${TRUTH_LABEL[c.truthClass]}] ${label}: ${v} — source: ${c.provenance}`;
  if (c.truthClass === "conflict" && c.conflictWith?.length) {
    return `${base} — CONFLICTS WITH: ${c.conflictWith.join(" | ")}`;
  }
  return c.note ? `${base} — note: ${c.note}` : base;
}
