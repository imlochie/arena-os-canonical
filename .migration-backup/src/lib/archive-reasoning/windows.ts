/**
 * Gate 7, slice 7.3: window extraction and overlap — the honest temporal
 * plumbing that 7.2 deliberately deferred.
 *
 * Windows come FROM THE EVIDENCE, and only from the evidence:
 *   - explicit coverage bounds (startsAt / endsAt), or
 *   - a declared rolling window (coverage.windowDays) anchored at the
 *     item's own derivedAt — arithmetic over declared evidence values,
 *     never over a clock, or
 *   - the producer-declared window on temporal signals
 *     (value.window = {startsAt, endsAt}; upstream 141c789 + 3180bf9,
 *     Gate-6 contract: TemporalSignalValue.window, closed and REQUIRED).
 *     The last branch is pure IDENTIFICATION of contract-typed evidence:
 *     the bounds cross verbatim — no DAY_MS, no anchoring, no
 *     reconstruction, because the producer already did its arithmetic.
 *
 * An item with no window material extracts `null` (not a fabricated
 * span), and a temporal claim over such an item is not formed.
 *
 * DUAL AUTHORITY RULE: coverage-declared and producer-declared windows
 * are two distinct semantic authorities. When exactly one speaks, it is
 * used. When both declare exact same bounds, the single window is taken
 * (coverage representation keeps priority — a stable identity). When
 * both speak and disagree in ANY way — including shapes that cannot be
 * shown identical — the result is an explicit refusal (void_claim),
 * never a silent reconciliation and never a coin flip between
 * authorities.
 */

import { windowIdentity, ReasoningRejectError } from "./lattice";
import type { WindowIdentity } from "./types";

const DAY_MS = 86_400_000;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Window material declared in the item's coverage record — Arena's
 *  7.3-era evidence vocabulary (explicit bounds, or a declared rolling
 *  window composed from coverage.windowDays anchored at the item's own
 *  derivedAt). */
function coverageDeclaredWindow(item: Record<string, unknown>): WindowIdentity | null {
  const coverage = (item.coverage ?? null) as Record<string, unknown> | null;
  let label = coverage ? asString(coverage.label) ?? asString(coverage.window) : undefined;
  let startsAt = coverage ? asString(coverage.startsAt) : undefined;
  let endsAt = coverage ? asString(coverage.endsAt) : undefined;

  if (!startsAt && !endsAt && coverage) {
    const days = coverage.windowDays;
    const derivedAt = asString(item.derivedAt);
    const anchor = derivedAt ? Date.parse(derivedAt) : Number.NaN;
    if (typeof days === "number" && Number.isFinite(days) && days > 0 && Number.isFinite(anchor)) {
      startsAt = new Date(anchor - days * DAY_MS).toISOString();
      endsAt = new Date(anchor).toISOString();
      label ??= `rolling_${days}d`;
    }
  }

  if (!label && !startsAt && !endsAt) return null;
  return {
    ...(label ? { label } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
  };
}

/** The producer-declared window: contract-typed on temporal signals at
 *  value.window with closed shape {startsAt, endsAt}. Identification
 *  only — both bounds must be present, string-typed, and parseable;
 *  anything else never was a declared window. Non-temporal evidence
 *  classes carry no such contract semantics: a same-shaped blob inside
 *  their value is data, not a window declaration. */
function producerDeclaredWindow(item: Record<string, unknown>): WindowIdentity | null {
  if (asString(item.evidenceClass) !== "temporal_signal") return null;
  const value = item.value && typeof item.value === "object"
    ? (item.value as Record<string, unknown>)
    : null;
  const declared = value && value.window && typeof value.window === "object"
    ? (value.window as Record<string, unknown>)
    : null;
  if (!declared) return null;
  const startsAt = asString(declared.startsAt);
  const endsAt = asString(declared.endsAt);
  if (!startsAt || !endsAt) return null;
  if (!Number.isFinite(Date.parse(startsAt)) || !Number.isFinite(Date.parse(endsAt))) return null;
  return { startsAt, endsAt };
}

/** Bounds identity: both instants present, parseable, and equal.
 *  Anything un-comparable (a label-only coverage window against declared
 *  producer bounds, e.g.) is NOT identical — conservatively refused. */
function sameInstant(a: string | undefined, b: string | undefined): boolean {
  if (a == null || b == null) return false;
  const ai = Date.parse(a);
  const bi = Date.parse(b);
  if (!Number.isFinite(ai) || !Number.isFinite(bi)) return false;
  return ai === bi;
}

/** Extract THE declared window of one evidence item, or null. See the
 *  module header for the dual-authority rule: conflicting declared
 *  windows refuse to form an identity (void_claim) rather than picking
 *  one — the conflict propagates through every claim path and through
 *  contradiction surfacing as the same refusal, unchanged. */
export function extractWindow(item: Record<string, unknown>): WindowIdentity | null {
  const coverageWindow = coverageDeclaredWindow(item);
  const producerWindow = producerDeclaredWindow(item);
  if (!producerWindow) return coverageWindow;
  if (!coverageWindow) return producerWindow;
  if (
    sameInstant(coverageWindow.startsAt, producerWindow.startsAt)
    && sameInstant(coverageWindow.endsAt, producerWindow.endsAt)
  ) {
    // Identical dual declaration: one window, stable identity.
    return coverageWindow;
  }
  throw new ReasoningRejectError(
    "void_claim",
    `conflicting declared windows: coverage declares ${windowIdentity(coverageWindow)} but the producer declares value.window ${windowIdentity(producerWindow)}; two semantic authorities are never silently reconciled (§9)`,
  );
}

export type OverlapBasis = "identity" | "interval" | "undetermined";

export type OverlapResult = {
  readonly overlaps: boolean;
  /** Same identity = the SAME window — a re-statement basis, never a
   *  conflict basis and never a trend basis. */
  readonly sameWindow: boolean;
  readonly basis: OverlapBasis;
};

function parseBound(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Do two windows overlap? Answered at three honesty grades:
 *
 *   identity      — literally the same window identity;
 *   interval      — both windows carry at least one parseable bound and
 *                   the intervals genuinely intersect;
 *   undetermined  — the material cannot decide (e.g. label-only windows).
 *                   Conservatively reported as POSSIBLY overlapping: for
 *                   contradiction surfacing we err toward surfacing
 *                   (a false conflict is an explicit uncertainty, a
 *                   missed conflict is a hidden lie), while temporal
 *                   claims independently require genuine non-overlap. */
export function windowsOverlap(a: WindowIdentity, b: WindowIdentity): OverlapResult {
  if (windowIdentity(a) === windowIdentity(b)) {
    return { overlaps: true, sameWindow: true, basis: "identity" };
  }
  const haveBounds =
    (a.startsAt != null || a.endsAt != null) && (b.startsAt != null || b.endsAt != null);
  if (haveBounds) {
    const startA = parseBound(a.startsAt, -Infinity);
    const endA = parseBound(a.endsAt, Infinity);
    const startB = parseBound(b.startsAt, -Infinity);
    const endB = parseBound(b.endsAt, Infinity);
    return {
      overlaps: startA < endB && startB < endA,
      sameWindow: false,
      basis: "interval",
    };
  }
  return { overlaps: true, sameWindow: false, basis: "undetermined" };
}
