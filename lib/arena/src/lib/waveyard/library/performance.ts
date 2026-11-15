/** Source-clock stem performance controls. These are not sample-locked. */
export const PERFORMANCE_SNAPS = ["off", "quarter", "half", "beat", "bar"] as const;
export const PERFORMANCE_MINIMUM_LEAD_SECONDS = 0.18;
export type PerformanceSnap = (typeof PERFORMANCE_SNAPS)[number];
export type StemLevels = Record<string, number>;

export interface PerformanceSettings {
  snap: PerformanceSnap;
  instantRestore: boolean;
  recall: StemLevels;
  isolatedStem: string | null;
  beforeIsolation: StemLevels | null;
}

export const defaultPerformance = (): PerformanceSettings => ({
  snap: "off",
  instantRestore: true,
  recall: {},
  isolatedStem: null,
  beforeIsolation: null,
});

function isLevels(value: unknown): value is StemLevels {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length <= 64
    && Object.entries(value).every(([key, level]) =>
      key.length > 0
      && key.length <= 64
      && !["__proto__", "constructor", "prototype"].includes(key)
      && typeof level === "number"
      && Number.isFinite(level)
      && level >= 0
      && level <= 2,
    );
}

export function normalizePerformance(raw: unknown): PerformanceSettings | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    !PERFORMANCE_SNAPS.includes(value.snap as PerformanceSnap)
    || typeof value.instantRestore !== "boolean"
    || !isLevels(value.recall)
    || !(value.beforeIsolation === null || isLevels(value.beforeIsolation))
    || !(value.isolatedStem === null
      || (typeof value.isolatedStem === "string" && value.isolatedStem.length > 0 && value.isolatedStem.length <= 64))
    || ((value.isolatedStem === null) !== (value.beforeIsolation === null))
  ) return null;
  return {
    snap: value.snap as PerformanceSnap,
    instantRestore: value.instantRestore,
    recall: { ...value.recall },
    isolatedStem: value.isolatedStem as string | null,
    beforeIsolation: value.beforeIsolation === null ? null : { ...value.beforeIsolation },
  };
}

export type PerformanceAction =
  | { kind: "mute" | "isolate"; stem: string }
  | { kind: "restore" };

/** Apply an explicit mute/isolate/restore action and retain exact fader recall. */
export function performMix(
  mix: StemLevels,
  settings: PerformanceSettings,
  action: PerformanceAction,
  stems: readonly string[],
): { mix: StemLevels; performance: PerformanceSettings } {
  const next = Object.fromEntries(stems.map((stem) => [stem, mix[stem] ?? 1]));
  const performance: PerformanceSettings = { ...settings, recall: { ...settings.recall } };
  if (action.kind !== "restore" && !stems.includes(action.stem)) {
    throw new Error("Unknown performance stem.");
  }

  const restore = () => {
    for (const stem of stems) {
      next[stem] = performance.beforeIsolation?.[stem]
        ?? (next[stem] > 0 ? next[stem] : performance.recall[stem] ?? 1);
    }
    performance.isolatedStem = null;
    performance.beforeIsolation = null;
  };

  if (action.kind === "restore" || (action.kind === "isolate" && settings.isolatedStem === action.stem)) {
    restore();
  } else if (action.kind === "isolate") {
    performance.beforeIsolation = settings.beforeIsolation ?? { ...next };
    performance.isolatedStem = action.stem;
    for (const stem of stems) {
      if (next[stem] > 0) performance.recall[stem] = next[stem];
      next[stem] = stem === action.stem ? next[stem] || performance.recall[stem] || 1 : 0;
    }
  } else {
    if (performance.isolatedStem !== null) restore();
    if (next[action.stem] > 0) {
      performance.recall[action.stem] = next[action.stem];
      next[action.stem] = 0;
    } else {
      next[action.stem] = performance.recall[action.stem] ?? 1;
    }
    performance.isolatedStem = null;
    performance.beforeIsolation = null;
  }

  return { mix: next, performance };
}

/** Return the next strictly-future measured boundary; never extrapolate BPM. */
export function nextPerformanceBoundary(
  positionSeconds: number,
  grid: unknown,
  snap: PerformanceSnap,
  downbeats?: unknown,
  minimumLeadSeconds = 0,
): number | null {
  if (
    !Number.isFinite(positionSeconds)
    || positionSeconds < 0
    || !Number.isFinite(minimumLeadSeconds)
    || minimumLeadSeconds < 0
  ) return null;
  if (snap === "off") return positionSeconds;
  if (snap === "bar") return nextPerformanceBoundary(positionSeconds, downbeats, "beat", undefined, minimumLeadSeconds);
  if (
    !Array.isArray(grid)
    || grid.length < 2
    || grid.some((beat, index) =>
      !Number.isSafeInteger(beat)
      || beat < 0
      || (index > 0 && beat <= grid[index - 1]),
    )
  ) return null;

  const positionMs = (positionSeconds + minimumLeadSeconds) * 1000;
  let low = 0;
  let high = grid.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (grid[middle] <= positionMs + 0.001) low = middle + 1;
    else high = middle;
  }
  if (low >= grid.length) return null;
  if (snap === "beat" || low === 0) return grid[low] / 1000;

  const divisions = snap === "half" ? 2 : 4;
  const start = grid[low - 1];
  const step = (grid[low] - start) / divisions;
  const subdivision = Math.min(divisions, Math.floor((positionMs - start + 0.001) / step) + 1);
  return (start + subdivision * step) / 1000;
}

export type LiveStemSwapBoundaryPlan = {
  requested: boolean;
  status: "off" | "unavailable" | "scheduled";
  targetPositionSeconds: number | null;
  activationTime: number | null;
};

/**
 * Plan a live donor activation against the receiving track's measured clock.
 * The callback maps that media position to the AudioContext clock so the audio
 * source and its crossfade can be scheduled by Web Audio, not a UI timer.
 */
export function planLiveStemSwapBoundary(input: {
  snap: PerformanceSnap;
  playing: boolean;
  beatEvidenceReliable: boolean;
  downbeatEvidenceReliable: boolean;
  positionSeconds: number;
  beatGridMs: unknown;
  downbeatGridMs: unknown;
  contextTimeAtPosition: (positionSeconds: number) => number | null;
  minimumLeadSeconds?: number;
}): LiveStemSwapBoundaryPlan {
  const requested = input.playing && input.snap !== "off";
  const base = {
    requested,
    targetPositionSeconds: null,
    activationTime: null,
  } as const;
  if (!requested) return { ...base, status: "off" };
  if (!input.beatEvidenceReliable) return { ...base, status: "unavailable" };
  if (input.snap === "bar" && !input.downbeatEvidenceReliable) {
    return { ...base, status: "unavailable" };
  }

  const lead = input.minimumLeadSeconds ?? PERFORMANCE_MINIMUM_LEAD_SECONDS;
  const target = input.snap === "bar"
    ? nextPerformanceBoundary(input.positionSeconds, input.beatGridMs, "bar", input.downbeatGridMs, lead)
    : nextPerformanceBoundary(input.positionSeconds, input.beatGridMs, input.snap, undefined, lead);
  if (target === null) return { ...base, status: "unavailable" };

  const activationTime = input.contextTimeAtPosition(target);
  if (activationTime === null || !Number.isFinite(activationTime)) {
    return { ...base, status: "unavailable" };
  }
  return {
    requested,
    status: "scheduled",
    targetPositionSeconds: target,
    activationTime,
  };
}

/** A delayed/backgrounded callback is rejected rather than applied late. */
export function performanceTick(
  target: number,
  previous: number,
  position: number,
  playing: boolean,
): "wait" | "apply" | "cancel" {
  if (
    !playing
    || ![target, previous, position].every(Number.isFinite)
    || position < previous - 0.005
    || position > target + 0.08
  ) return "cancel";
  return position >= target ? "apply" : "wait";
}
