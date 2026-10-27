/**
 * Gate 7, slice 7.3: contradiction surfacing (design §3.4) — the owner's
 * knife-edge: surface the disagreement, preserve both pieces of evidence,
 * never manufacture a reconciliation merely because a cleaner story
 * would render better.
 *
 * A contradiction is emitted when two same-subject, same-scope evidence
 * items carry materially different values over possibly-overlapping
 * windows. The output is the disagreement itself: both refs, both
 * windows, both values, the overlap basis — and NOTHING ELSE. No winner,
 * no chosen value, no merged number; not even resolution advice.
 *
 * Two honest exemptions, by rule:
 *   - identical lineage (same provider/event/batch handles) is ONE chain
 *     restating itself — recompute drift, not two truths;
 *   - genuinely non-overlapping windows both stand, each in its own time.
 * Zero output means "no contradiction surfaced in this collection of this
 * pack" — never "no contradictions exist" (absence stays qualified).
 */

import { buildConclusion, windowIdentity, ReasoningRejectError } from "./lattice";
import { extractWindow, windowsOverlap, type OverlapBasis } from "./windows";
import { resolveEvidence } from "./evidence";
import { EVIDENCE_COLLECTION_KEYS } from "./types";
import type {
  Conclusion,
  ContradictionClaim,
  EvidenceCollectionKey,
  EvidencePack,
  EvidenceRef,
} from "./types";

function subjectKeyOf(item: Record<string, unknown>): string | null {
  const subject = item.subjectIdentity ?? item.factType;
  return typeof subject === "string" && subject ? subject : null;
}

/** Lineage identity: the upstream handles that make two items the SAME
 *  evidence chain. Missing lineage is NOT shared lineage — two lineage-
 *  less items remain two independent witnesses. */
function lineageKeyOf(item: Record<string, unknown>): string | null {
  const provenance = (item.provenance ?? null) as Record<string, unknown> | null;
  if (!provenance) return null;
  const parts: string[] = [];
  for (const key of ["eventIds", "providerEventIds", "batchIds"] as const) {
    const ids = provenance[key];
    if (Array.isArray(ids) && ids.length > 0) parts.push(`${key}:${ids.map(String).sort().join(",")}`);
  }
  return parts.length ? parts.join("|") : null;
}

/** Canonical deep-stringify (key order-insensitive) for value equality. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function surfaceContradictions(
  pack: EvidencePack,
  collection: EvidenceCollectionKey,
  options: { readonly rule?: string } = {},
): Conclusion<ContradictionClaim>[] {
  if (!(EVIDENCE_COLLECTION_KEYS as readonly string[]).includes(collection)) {
    throw new ReasoningRejectError(
      "bad_reference",
      `contradiction surfacing examines the seven evidence collections; "${String(collection)}" is not one`,
    );
  }

  const items = (pack.evidence[collection] as readonly Record<string, unknown>[]) ?? [];
  type Entry = { ref: EvidenceRef; item: Record<string, unknown> };
  const entries: Entry[] = items.map((item, index) => ({
    ref: {
      collection,
      index,
      ...(typeof item.signalId === "string" ? { signalId: item.signalId } : {}),
    } as EvidenceRef,
    item,
  }));

  // Group by (subject, declared scope): conflicts live inside one
  // subject AND one scope. Cross-scope differences both stand.
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const subject = subjectKeyOf(entry.item);
    if (subject === null) continue;
    const scope = typeof entry.item.scopeIdentity === "string" ? entry.item.scopeIdentity : "∅";
    const key = `${scope}${subject}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const conclusions: Conclusion<ContradictionClaim>[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];

        // One chain, restated: identical lineage → never two truths.
        const lineageA = lineageKeyOf(a.item);
        const lineageB = lineageKeyOf(b.item);
        if (lineageA !== null && lineageA === lineageB) continue;

        // Material difference required.
        if (canonical(a.item.value) === canonical(b.item.value)) continue;

        // Window relation.
        const windowA = extractWindow(a.item);
        const windowB = extractWindow(b.item);
        let basis: OverlapBasis;
        let sameWindow = false;
        let overlaps: boolean;
        if (windowA === null || windowB === null) {
          basis = "undetermined";
          overlaps = true; // undecidable → err toward surfacing
        } else {
          const relation = windowsOverlap(windowA, windowB);
          basis = relation.basis;
          sameWindow = relation.sameWindow;
          overlaps = relation.overlaps;
        }
        if (!overlaps) continue; // both stand, each in its own time

        const envelopeWindow = sameWindow && windowA
          ? windowA
          : { label: basis === "interval" ? "overlapping_span" : "undetermined_window" };

        const conclusion = buildConclusion<ContradictionClaim>({
          kind: "contradiction",
          pack,
          rule: options.rule ?? "contradiction.surface.v1",
          loadBearing: [{ ...a.ref }, { ...b.ref }],
          window: envelopeWindow,
          ...(typeof a.item.scopeIdentity !== "string" && typeof b.item.scopeIdentity !== "string"
            ? { scopeIdentity: "undeclared" }
            : {}),
          claim: {
            collection,
            conflictingField: "value",
            a: { ref: { ...a.ref }, window: windowA, value: a.item.value ?? null },
            b: { ref: { ...b.ref }, window: windowB, value: b.item.value ?? null },
            overlapBasis: basis,
          },
        });
        conclusions.push(conclusion);
      }
    }
  }
  return conclusions;
}
