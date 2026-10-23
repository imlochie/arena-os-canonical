export const AUTOMATION_PARAMETERS = ["volume", "pan"] as const;
export type AutomationParameter = (typeof AUTOMATION_PARAMETERS)[number];
export type AutomationPoint = { id?: string; timelineMs: number; value: number };
export type RemixAutomationLane = {
  remixTrackId: string;
  parameter: AutomationParameter;
  points: AutomationPoint[];
};

export const MAX_AUTOMATION_POINTS_PER_LANE = 1024;

export function automationValueIsValid(parameter: AutomationParameter, value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    && (parameter === "volume" ? value >= 0 && value <= 2 : value >= -1 && value <= 1);
}

/** Sorts a lane and resolves duplicate timestamps with a deterministic last-write-wins policy. */
export function normaliseAutomationPoints(
  parameter: AutomationParameter,
  input: unknown,
): AutomationPoint[] | null {
  if (!Array.isArray(input) || input.length > MAX_AUTOMATION_POINTS_PER_LANE) return null;
  const byTimeline = new Map<number, AutomationPoint>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const point = raw as Partial<AutomationPoint>;
    const timelineMs = point.timelineMs;
    const value = point.value;
    if (typeof timelineMs !== "number" || typeof value !== "number"
      || !Number.isSafeInteger(timelineMs) || timelineMs < 0 || timelineMs > 86_400_000
      || !automationValueIsValid(parameter, value)) return null;
    byTimeline.set(timelineMs, point.id ? { id: String(point.id), timelineMs, value } : { timelineMs, value });
  }
  return [...byTimeline.values()].sort((left, right) => left.timelineMs - right.timelineMs);
}

export function upsertAutomationPoint(
  parameter: AutomationParameter,
  current: AutomationPoint[],
  point: AutomationPoint,
) {
  const points = normaliseAutomationPoints(parameter, [...current.filter((item) => item.id !== point.id), point]);
  return points;
}

export type AutomationLinearSegment = {
  startMs: number;
  endMs: number;
  startValue: number;
  endValue: number;
};

/** Canonical V1 linear pieces shared by UI evaluation and authoritative render construction. */
export function automationLinearSegments(points: AutomationPoint[]) {
  const ordered = [...points].sort((left, right) => left.timelineMs - right.timelineMs);
  return ordered.slice(1).map((right, index): AutomationLinearSegment => ({
    startMs: ordered[index].timelineMs,
    endMs: right.timelineMs,
    startValue: ordered[index].value,
    endValue: right.value,
  })).filter((segment) => segment.endMs > segment.startMs);
}

/** Compile once per prepared lane, not once per audio sample.
 * Sorted-breakpoint lookup adapted from SoundCraft AutomationLane::value_at,
 * crates/model/src/automation.rs at 25d52c646aea780c8076ff966076f994ad256221.
 * Copyright (c) 2026 ArtCraft Team and SoundCraft contributors, MIT.
 * See docs/licenses/soundcraft-MIT.txt. Retains Waveyard's historical boundary
 * and duplicate-point semantics; normalization remains the write-time contract.
 */
export function createAutomationEvaluator(points: AutomationPoint[], defaultValue: number) {
  const ordered = [...points].sort((left, right) => left.timelineMs - right.timelineMs);
  return (timelineMs: number): number => {
    if (!Number.isFinite(timelineMs) || !Number.isFinite(defaultValue) || !ordered.length) return defaultValue;
    if (timelineMs <= ordered[0].timelineMs) return ordered[0].value;
    const final = ordered[ordered.length - 1];
    if (timelineMs >= final.timelineMs) return final.value;
    // Lower bound preserves the first point AT a duplicate timestamp, just as
    // the old first-ending-segment search did. Beyond it, the last duplicate
    // supplies the next segment's left endpoint. No per-sample allocations.
    let low = 1, high = ordered.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ordered[middle].timelineMs < timelineMs) low = middle + 1;
      else high = middle;
    }
    const left = ordered[low - 1], right = ordered[low];
    const fraction = (timelineMs - left.timelineMs) / (right.timelineMs - left.timelineMs);
    return left.value + (right.value - left.value) * fraction;
  };
}

/** Convenience API for isolated queries; renderers should compile once. */
export function evaluateAutomation(points: AutomationPoint[], timelineMs: number, defaultValue: number) {
  return createAutomationEvaluator(points, defaultValue)(timelineMs);
}
