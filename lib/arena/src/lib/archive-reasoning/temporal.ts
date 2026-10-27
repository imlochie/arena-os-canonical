/**
 * Gate 7, slice 7.3: temporal synthesis (design §3.3).
 *
 * Temporal claims live strictly inside windows extracted FROM THE
 * EVIDENCE (windows.ts), carry the evidence's own derivedAt as their
 * as-of (no clock here), and inherit `derived` at best — the lattice
 * computes, as always.
 *
 * A window comparison ("trend", in the most boring sense) requires ≥2
 * genuinely NON-overlapping windows of the same subject and is emitted
 * as arithmetic: per-window numbers plus adjacent-pair
 * delta/relation ("greater" | "less" | "equal"). Nothing here can say
 * "increasing interest" — the claim type has no fields for adjectives.
 */

import { buildConclusion, windowIdentity, ReasoningRejectError } from "./lattice";
import { extractWindow, windowsOverlap } from "./windows";
import { resolveEvidence } from "./evidence";
import type {
  Conclusion,
  EvidencePack,
  EvidenceRef,
  TemporalClaim,
  WindowComparison,
  WindowComparisonClaim,
  WindowComparisonPoint,
} from "./types";

/** One signal, stated inside its own evidence window, as-of evidence time. */
export function temporalClaim(
  pack: EvidencePack,
  ref: EvidenceRef,
  options: { readonly rule?: string; readonly scopeIdentity?: string } = {},
): Conclusion<TemporalClaim> {
  const item = resolveEvidence(pack, ref);
  const window = extractWindow(item);
  if (!window) {
    throw new ReasoningRejectError(
      "lineage_incomplete",
      `temporal claim over ${ref.collection}[${ref.index}] needs the item's own evidence window (C3); the coverage record carries none`,
    );
  }
  const subject = typeof item.subjectIdentity === "string" && item.subjectIdentity ? item.subjectIdentity : null;
  const asOf = typeof item.derivedAt === "string" && Number.isFinite(Date.parse(item.derivedAt)) ? item.derivedAt : null;

  return buildConclusion<TemporalClaim>({
    kind: "temporal_synthesis",
    pack,
    rule: options.rule ?? "temporal.asof.v1",
    loadBearing: [{ ...ref }],
    window,
    ...(options.scopeIdentity != null ? { scopeIdentity: options.scopeIdentity } : {}),
    claim: {
      signal: { ...ref },
      subject,
      window,
      windowKey: windowIdentity(window),
      asOf,
      metric: item.value ?? null,
    },
  });
}

/** Compare one numeric metric across ≥2 non-overlapping windows of the
 *  same subject. Pure arithmetic; sorted by window start for
 *  determinism. */
export function compareWindows(
  pack: EvidencePack,
  members: readonly EvidenceRef[],
  options: { readonly metricKey: string; readonly rule?: string; readonly scopeIdentity?: string },
): Conclusion<WindowComparisonClaim> {
  if (members.length < 2) {
    throw new ReasoningRejectError(
      "lineage_incomplete",
      "a window comparison needs at least two windows of the same subject (§3.3)",
    );
  }
  const collection = members[0].collection;
  if (!members.every((ref) => ref.collection === collection)) {
    throw new ReasoningRejectError(
      "mixed_class",
      "window comparison is same-class only: members come from more than one evidence collection",
    );
  }

  const items = members.map((ref) => ({ ref, item: resolveEvidence(pack, ref) }));
  const subjects = new Set(
    items.map(({ item }) => (typeof item.subjectIdentity === "string" ? item.subjectIdentity : null)),
  );
  if (subjects.size !== 1) {
    throw new ReasoningRejectError(
      "void_claim",
      "window comparison requires a single subject across all members",
    );
  }

  const points: WindowComparisonPoint[] = items.map(({ ref, item }) => {
    const window = extractWindow(item);
    if (!window) {
      throw new ReasoningRejectError(
        "lineage_incomplete",
        `window comparison member ${ref.collection}[${ref.index}] has no extractable evidence window`,
      );
    }
    const value = (item.value as Record<string, unknown> | null)?.[options.metricKey];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ReasoningRejectError(
        "void_claim",
        `metric "${options.metricKey}" is missing or non-numeric on ${ref.collection}[${ref.index}]; comparisons do not interpolate`,
      );
    }
    return { member: { ...ref }, window, windowKey: windowIdentity(window), value };
  });

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (windowsOverlap(points[i].window, points[j].window).overlaps) {
        throw new ReasoningRejectError(
          "void_claim",
          "window comparison requires genuinely non-overlapping windows; overlapping or undetermined windows cannot ground a trend (§3.3)",
        );
      }
    }
  }

  points.sort((a, b) =>
    (a.window.startsAt ?? "").localeCompare(b.window.startsAt ?? "")
    || (a.window.endsAt ?? "").localeCompare(b.window.endsAt ?? "")
    || a.windowKey.localeCompare(b.windowKey),
  );

  const comparisons: WindowComparison[] = points.slice(1).map((point, index) => {
    const prior = points[index];
    const delta = point.value - prior.value;
    return {
      aWindowKey: prior.windowKey,
      bWindowKey: point.windowKey,
      delta,
      relation: delta > 0 ? "greater" : delta < 0 ? "less" : "equal",
    };
  });

  // Envelope window for a comparison: the evidence-derived span of the
  // members (the per-window identities stay authoritative in the claim).
  const span = {
    label: "comparison_span",
    ...(points[0].window.startsAt ? { startsAt: points[0].window.startsAt } : {}),
    ...(points[points.length - 1].window.endsAt ? { endsAt: points[points.length - 1].window.endsAt } : {}),
  };

  return buildConclusion<WindowComparisonClaim>({
    kind: "temporal_synthesis",
    pack,
    rule: options.rule ?? `temporal.compare.v1:${options.metricKey}`,
    loadBearing: members.map((ref) => ({ ...ref })),
    window: span,
    ...(options.scopeIdentity != null ? { scopeIdentity: options.scopeIdentity } : {}),
    claim: {
      subject: [...subjects][0],
      metricKey: options.metricKey,
      perWindow: points,
      comparisons,
      members: members.map((ref) => ({ ...ref })),
    },
  });
}
