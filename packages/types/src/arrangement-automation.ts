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

/** Linear interpolation, clamped to the first/last point at both lane boundaries. */
export function evaluateAutomation(
  points: AutomationPoint[],
  timelineMs: number,
  defaultValue: number,
) {
  if (!Number.isFinite(timelineMs) || !Number.isFinite(defaultValue) || !points.length) return defaultValue;
  const ordered = [...points].sort((left, right) => left.timelineMs - right.timelineMs);
  if (timelineMs <= ordered[0].timelineMs) return ordered[0].value;
  const final = ordered.at(-1)!;
  if (timelineMs >= final.timelineMs) return final.value;
  const rightIndex = ordered.findIndex((point) => point.timelineMs >= timelineMs);
  const right = ordered[rightIndex];
  const left = ordered[rightIndex - 1];
  const fraction = (timelineMs - left.timelineMs) / (right.timelineMs - left.timelineMs);
  return left.value + (right.value - left.value) * fraction;
}
