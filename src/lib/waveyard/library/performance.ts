/** Source-clock performance controls. Deterministic, not inference or a sample clock. */
export const PERFORMANCE_SNAPS = ["off", "quarter", "half", "beat", "bar", "four-beats"] as const;
export type PerformanceSnap = typeof PERFORMANCE_SNAPS[number];
export type Levels = Record<string, number>;
export type PerformanceSettings = {
  snap: PerformanceSnap;
  instantRestore: boolean;
  recall: Levels;
  isolatedStem: string | null;
  beforeIsolation: Levels | null;
};
export const defaultPerformance = (): PerformanceSettings => ({ snap: "off", instantRestore: true, recall: {}, isolatedStem: null, beforeIsolation: null });
function levels(value: unknown): value is Levels {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 64 &&
    Object.entries(value).every(([k, v]) => k.length > 0 && k.length <= 64 && !["__proto__", "constructor", "prototype"].includes(k) && typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 2);
}
export function normalizePerformance(raw: unknown): PerformanceSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as PerformanceSettings;
  if (!PERFORMANCE_SNAPS.includes(v.snap) || typeof v.instantRestore !== "boolean" || !levels(v.recall) ||
    !(v.beforeIsolation === null || levels(v.beforeIsolation)) ||
    !(v.isolatedStem === null || (typeof v.isolatedStem === "string" && v.isolatedStem.length > 0 && v.isolatedStem.length <= 64))) return null;
  if ((v.isolatedStem === null) !== (v.beforeIsolation === null)) return null;
  return { snap: v.snap, instantRestore: v.instantRestore, recall: { ...v.recall }, isolatedStem: v.isolatedStem, beforeIsolation: v.beforeIsolation && { ...v.beforeIsolation } };
}
export type PerformanceAction = { kind: "mute" | "isolate"; stem: string } | { kind: "restore" };
export function performMix(mix: Levels, settings: PerformanceSettings, action: PerformanceAction, stems: string[]) {
  const next: Levels = Object.fromEntries(stems.map(stem => [stem, mix[stem] ?? 1]));
  const performance = { ...settings, recall: { ...settings.recall } };
  if (action.kind !== "restore" && !stems.includes(action.stem)) throw new Error("Unknown performance stem.");
  const restore = () => {
    for (const stem of stems) next[stem] = performance.beforeIsolation?.[stem] ?? (next[stem] > 0 ? next[stem] : performance.recall[stem] ?? 1);
    performance.isolatedStem = null; performance.beforeIsolation = null;
  };
  if (action.kind === "restore" || (action.kind === "isolate" && settings.isolatedStem === action.stem)) restore();
  else if (action.kind === "isolate") {
    performance.beforeIsolation = settings.beforeIsolation ?? { ...next };
    performance.isolatedStem = action.stem;
    for (const stem of stems) {
      if (next[stem] > 0) performance.recall[stem] = next[stem];
      next[stem] = stem === action.stem ? next[stem] || performance.recall[stem] || 1 : 0;
    }
  } else if (action.kind === "mute") {
    if (next[action.stem] > 0) { performance.recall[action.stem] = next[action.stem]; next[action.stem] = 0; }
    else next[action.stem] = performance.recall[action.stem] ?? 1;
    performance.isolatedStem = null; performance.beforeIsolation = null;
  }
  return { mix: next, performance };
}
/** Strictly future boundary, only within measured grid; never extrapolate BPM.
 * four-beats is anchored to the first analyzed beat, NOT a detected downbeat.
 */
export function nextPerformanceBoundary(positionSeconds: number, grid: unknown, snap: PerformanceSnap, downbeats?: unknown): number | null {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return null;
  if (snap === "off") return positionSeconds;
  // Bar requires separately supplied downbeat evidence, never grid index % 4.
  if (snap === "bar") return nextPerformanceBoundary(positionSeconds, downbeats, "beat");
  if (!Array.isArray(grid) || grid.length < 2 || grid.some((v, i) => !Number.isSafeInteger(v) || v < 0 || (i > 0 && v <= grid[i - 1]))) return null;
  const ms = positionSeconds * 1000;
  let lo = 0, hi = grid.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (grid[mid] <= ms + 0.001) lo = mid + 1; else hi = mid; }
  if (lo >= grid.length) return null;
  if (snap === "four-beats") { const index = Math.ceil(lo / 4) * 4; return index < grid.length ? grid[index] / 1000 : null; }
  if (lo === 0 || snap === "beat") return grid[lo] / 1000;
  const divisions = snap === "half" ? 2 : 4;
  const start = grid[lo - 1], step = (grid[lo] - start) / divisions;
  return (start + Math.min(divisions, Math.floor((ms - start + 0.001) / step) + 1) * step) / 1000;
}
/** A late/backgrounded callback is rejected, never applied off-beat on return. */
export function performanceTick(target: number, previous: number, position: number, playing: boolean): "wait" | "apply" | "cancel" {
  if (!playing || ![target, previous, position].every(Number.isFinite) || position < previous - 0.005 || position > target + 0.08) return "cancel";
  return position >= target ? "apply" : "wait";
}
