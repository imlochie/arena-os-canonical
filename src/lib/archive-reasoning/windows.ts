/**
 * Gate 7, slice 7.3: window extraction and overlap — the honest temporal
 * plumbing that 7.2 deliberately deferred.
 *
 * Windows come FROM THE EVIDENCE, and only from the evidence:
 *   - explicit coverage bounds (startsAt / endsAt), or
 *   - a declared rolling window (coverage.windowDays) anchored at the
 *     item's own derivedAt — arithmetic over declared evidence values,
 *     never over a clock.
 * An item with no window material extracts `null` (not a fabricated
 * span), and a temporal claim over such an item is not formed.
 */

import { windowIdentity } from "./lattice";
import type { WindowIdentity } from "./types";

const DAY_MS = 86_400_000;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Extract the declared window of one evidence item, or null. */
export function extractWindow(item: Record<string, unknown>): WindowIdentity | null {
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
