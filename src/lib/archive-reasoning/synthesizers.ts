/**
 * Gate 7, slice 7.2: restatement + aggregation synthesizers.
 *
 * Deliberately no smarter than the lattice beneath them (owner: "7.2 must
 * not be smarter than 7.1"). They perform exactly two honest operations
 * over the frozen evidence pack —
 *
 *   restatement : re-voice ONE evidence item structurally (§3.1);
 *   aggregation : count / sum / enumerate subjects across a same-class,
 *                 same-scope membership (§3.2) —
 *
 * and they delegate every epistemic decision to buildConclusion: ceilings
 * are computed there, void claims are refused there, scopes and lineage
 * are checked there. These functions add no semantics: claim payloads are
 * structural data (class / subject / value / count / sum / subjects /
 * members), never prose and never affect vocabulary. The renderer (7.4)
 * is where certified structure may become careful words.
 *
 * Window note (honest limitation, per design): per-item window extraction
 * from evidence coverage records is 7.3 (temporal) territory. Until then,
 * the calling rule declares the single window the synthesis speaks within
 * — unionWindow already refuses to merge differing windows, and 7.3 wires
 * that refusal to real per-item window identities.
 */

import {
  buildConclusion,
  ReasoningRejectError,
} from "./lattice";
import type {
  AggregationClaim,
  AggregationMode,
  Conclusion,
  EvidencePack,
  EvidenceRef,
  RestatementClaim,
  WindowIdentity,
} from "./types";

export type SynthesisOptions = {
  /** The single window this synthesis speaks within (see window note). */
  readonly window: WindowIdentity;
  /** Optional explicit scope (e.g. for scope-less fact evidence). */
  readonly scopeIdentity?: string;
  /** Override the deterministic rule name recorded in the derivation. */
  readonly rule?: string;
};

function resolve(pack: EvidencePack, ref: EvidenceRef): Record<string, unknown> {
  const items = pack.evidence[ref.collection] as readonly Record<string, unknown>[];
  const item = items?.[ref.index];
  if (!item || typeof item !== "object") {
    // buildConclusion performs the authoritative check; this only guards
    // the synthesizer's own reads.
    throw new ReasoningRejectError(
      "bad_reference",
      `no evidence item at ${ref.collection}[${ref.index}] in this pack`,
    );
  }
  return item;
}

/* ------------------------------ restatement ------------------------------ */

/** Re-voice exactly one evidence item. Same class, same subject, same
 *  value — the calculus computes the ceiling, and C2 voids restatements
 *  of unknown evidence automatically. */
export function restateEvidence(
  pack: EvidencePack,
  ref: EvidenceRef,
  options: SynthesisOptions,
): Conclusion<RestatementClaim> {
  const item = resolve(pack, ref);
  const subject =
    typeof item.subjectIdentity === "string" && item.subjectIdentity
      ? item.subjectIdentity
      : typeof item.factType === "string" && item.factType
        ? item.factType
        : null;

  return buildConclusion<RestatementClaim>({
    kind: "restatement",
    pack,
    rule: options.rule ?? "restate.v1",
    loadBearing: [ref],
    window: options.window,
    ...(options.scopeIdentity != null ? { scopeIdentity: options.scopeIdentity } : {}),
    claim: {
      restates: { ...ref },
      evidenceClass: typeof item.evidenceClass === "string" ? item.evidenceClass : "unknown",
      subject,
      value: item.value ?? null,
    },
  });
}

/* ------------------------------ aggregation ------------------------------ */

/** Union over same-class evidence. Three modes, each structural:
 *
 *  count    — how many members are in this set (members listed);
 *  sum      — the arithmetic total of finite numeric `value`s — every
 *             member must contribute a number; nothing is skipped or
 *             zero-filled (incomplete evidence is not folded into a
 *             false precision);
 *  subjects — the unique, sorted subject identities across members. */
export function aggregateEvidence(
  pack: EvidencePack,
  members: readonly EvidenceRef[],
  options: SynthesisOptions & { readonly mode: AggregationMode },
): Conclusion<AggregationClaim> {
  if (members.length === 0) {
    throw new ReasoningRejectError(
      "lineage_incomplete",
      "an aggregation needs at least one member (C4)",
    );
  }
  const collection = members[0].collection;
  if (!members.every((ref) => ref.collection === collection)) {
    throw new ReasoningRejectError(
      "mixed_class",
      "aggregation is same-class only: members come from more than one evidence collection (§3.2)",
    );
  }

  const rule = options.rule ?? `aggregate.v1:${options.mode}`;
  const base = {
    kind: "aggregation" as const,
    pack,
    rule,
    loadBearing: members.map((ref) => ({ ...ref })),
    window: options.window,
    ...(options.scopeIdentity != null ? { scopeIdentity: options.scopeIdentity } : {}),
  };

  if (options.mode === "count") {
    return buildConclusion<AggregationClaim>({
      ...base,
      claim: { mode: "count", count: members.length, members: members.map((ref) => ({ ...ref })) },
    });
  }

  if (options.mode === "sum") {
    const values = members.map((ref) => resolve(pack, ref).value);
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new ReasoningRejectError(
        "void_claim",
        "sum requires a finite numeric value from every member; skipping or zero-filling would be fabricated precision",
      );
    }
    const sum = (values as number[]).reduce((a, b) => a + b, 0);
    return buildConclusion<AggregationClaim>({
      ...base,
      claim: { mode: "sum", count: members.length, sum, members: members.map((ref) => ({ ...ref })) },
    });
  }

  // subjects
  const subjects = [
    ...new Set(
      members
        .map((ref) => resolve(pack, ref).subjectIdentity)
        .filter((s): s is string => typeof s === "string" && s.length > 0),
    ),
  ].sort();
  if (subjects.length === 0) {
    throw new ReasoningRejectError(
      "void_claim",
      "subjects aggregation found no subject identities to enumerate",
    );
  }
  return buildConclusion<AggregationClaim>({
    ...base,
    claim: { mode: "subjects", count: members.length, subjects, members: members.map((ref) => ({ ...ref })) },
  });
}
