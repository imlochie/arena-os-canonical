/**
 * Gate-7 reasoning types (slice 7.1): the bounded conclusion envelope.
 *
 * Design authority: docs/archive-reasoning-layer.md §0–§4. These types are
 * deliberately CLOSED — the unions below are exhaustive, and the envelope
 * carries no index signature. Adding a seventh conclusion kind, an eighth
 * evidence collection, or a spare envelope key is a compile-time change
 * with a tripwire test (lattice.test.ts) behind it, never a casual edit.
 */

import type { PersonalisationFact } from "../personalisation/generated/types";
import type { PersonalisationEvidenceReception } from "../personalisation/types";

/** The upstream epistemic-status union, taken from the generated contract
 *  (never paraphrased by hand). */
export type EpistemicStatus = PersonalisationFact["epistemicStatus"];

/** The reasoning input: the Gate-6 frozen reception. Nothing else is input. */
export type EvidencePack = PersonalisationEvidenceReception;

/** The five bounded conclusion types (§3). Closed union — five, forever. */
export const CONCLUSION_KINDS = [
  "restatement",
  "aggregation",
  "temporal_synthesis",
  "contradiction",
  "absence_qualified",
] as const;
export type ConclusionKind = (typeof CONCLUSION_KINDS)[number];

/** Conclusion kinds that assert something about the world. These are the
 *  kinds C2 forbids to stand on `unknown`. The remaining kinds
 *  (contradiction, absence_qualified) are uncertainty-shaped: they REPORT
 *  what is not known, so unknown ground is their native soil. */
export const POSITIVE_KINDS = ["restatement", "aggregation", "temporal_synthesis"] as const;
export type PositiveKind = (typeof POSITIVE_KINDS)[number];

/** Evidence that can be load-bearing: the seven object-bearing collections
 *  of the pack. `constraints` are transport constraints, not evidence;
 *  `domain` is a label, not evidence. */
export const EVIDENCE_COLLECTION_KEYS = [
  "facts",
  "observedSignals",
  "temporalSignals",
  "collectionFacts",
  "interpretations",
  "uncertainties",
  "explicitPreferences",
] as const;
export type EvidenceCollectionKey = (typeof EVIDENCE_COLLECTION_KEYS)[number];

/** A stable reference to one evidence item inside the pack. signalId is
 *  carried when the item has one (provenance readability) and verified on
 *  resolution. */
export type EvidenceRef = {
  readonly collection: EvidenceCollectionKey;
  readonly index: number;
  readonly signalId?: string;
};

/** Window identity: the temporal extent a conclusion is allowed to speak
 *  within. At least one field must be present. Windows are never merged —
 *  C3 makes union a same-identity check, not a min/max operation. */
export type WindowIdentity = {
  readonly label?: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
};

/** The inspectable derivation path (§0.4, C4): who built this conclusion
 *  (which deterministic rule) and on what exactly it stands. */
export type DerivationRecord = {
  readonly rule: string;
  readonly loadBearing: readonly EvidenceRef[];
  readonly notes?: string;
};

/** The bounded conclusion envelope. `epistemicStatus` is COMPUTED by the
 *  lattice (C1) — there is no constructor path that accepts one. No index
 *  signature: what Gate 7 emits is exactly these six fields. */
export type Conclusion<TClaim = Record<string, unknown>> = {
  readonly kind: ConclusionKind;
  readonly epistemicStatus: EpistemicStatus;
  readonly scopeIdentity: string;
  readonly window: WindowIdentity;
  readonly derivation: DerivationRecord;
  readonly claim: TClaim;
};

/** The calculator's refusal taxonomy. */
export type RejectKind =
  | "void_claim"         // C2: positive claim grounded on unknown / content the rule cannot honestly form
  | "lineage_incomplete" // C4: no evidence / no rule / dangling lineage
  | "bad_reference"      // C5/C4: ref outside the seven collections, out of range, or signalId mismatch
  | "window_merge"       // C3: differing windows cannot be silently merged
  | "mixed_class"        // §3.2: aggregation over more than one evidence collection
  | "scope_merge";       // C3: conclusion scope exceeds the evidence's scope

/* ------------------------- 7.2 claim payloads ---------------------------- */

/** Restatement (§3.1): the structural re-voicing of ONE evidence item —
 *  class, subject, value verbatim. Deliberately data, not prose: phrasing
 *  belongs to the renderer (7.4), and nothing here may wear affect
 *  vocabulary. */
export type RestatementClaim = {
  readonly restates: EvidenceRef;
  readonly evidenceClass: string;
  readonly subject: string | null;
  readonly value: unknown;
};

/** Aggregation modes (§3.2): the three honest things a same-class,
 *  same-scope, same-window union may compute. */
export type AggregationMode = "count" | "sum" | "subjects";

export type AggregationClaim =
  | { readonly mode: "count"; readonly count: number; readonly members: readonly EvidenceRef[] }
  | { readonly mode: "sum"; readonly count: number; readonly sum: number; readonly members: readonly EvidenceRef[] }
  | { readonly mode: "subjects"; readonly count: number; readonly subjects: readonly string[]; readonly members: readonly EvidenceRef[] };
