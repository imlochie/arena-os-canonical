export type BeatGridAvailability = "available" | "low-confidence" | "unavailable";

/**
 * Returns a sorted copy of usable, integer source-millisecond beats. The
 * original analyzed grid is never changed. Invalid/empty input is unavailable.
 */
export function usableBeatGrid(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.some((beat) => !Number.isSafeInteger(beat) || beat < 0)) return null;
  return [...value].sort((left, right) => left - right);
}

/** Nearest source beat, clamped at boundaries; equal distances choose the earlier beat. */
export function nearestBeat(sourceOffsetMs: number, beatGridMs: unknown): number | null {
  const beats = usableBeatGrid(beatGridMs);
  if (!beats || !Number.isFinite(sourceOffsetMs)) return null;
  const offset = Math.round(sourceOffsetMs);
  if (offset <= beats[0]) return beats[0];
  if (offset >= beats[beats.length - 1]) return beats[beats.length - 1];
  let low = 0;
  let high = beats.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (beats[middle] <= offset) low = middle;
    else high = middle;
  }
  return offset - beats[low] <= beats[high] - offset ? beats[low] : beats[high];
}

export function beatGridAvailability(
  analysisStatus: unknown,
  beatGridMs: unknown,
  beatConfidence: unknown,
): BeatGridAvailability {
  if (analysisStatus !== "complete" || !usableBeatGrid(beatGridMs)) return "unavailable";
  return typeof beatConfidence === "number" && Number.isFinite(beatConfidence) && beatConfidence < 0.5
    ? "low-confidence"
    : "available";
}

/**
 * Resolves both source-window boundaries to analyzed beats. ratio is the
 * existing target/source tempo ratio; it is 1 for an untransformed clip.
 */
export function snapSourceWindowToBeats(
  sourceOffsetMs: number,
  durationMs: number,
  beatGridMs: unknown,
  ratio = 1,
): { sourceOffsetMs: number; durationMs: number } | null {
  if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(durationMs) || durationMs <= 0)
    return null;
  const start = nearestBeat(sourceOffsetMs, beatGridMs);
  const end = nearestBeat(sourceOffsetMs + Math.round(durationMs * ratio), beatGridMs);
  if (start === null || end === null || end <= start) return null;
  return { sourceOffsetMs: start, durationMs: Math.max(1, Math.round((end - start) / ratio)) };
}

/** Existing Phase 6 target/source ratio, shared for source-beat projection. */
export function tempoRatioForBpm(targetBpm: number, sourceBpm: number): number | null {
  if (!Number.isFinite(targetBpm) || !Number.isFinite(sourceBpm) || targetBpm <= 0 || sourceBpm <= 0)
    return null;
  return targetBpm / sourceBpm;
}

/** Projects one source-space beat into a clip's remix timeline coordinate. */
export function projectSourceBeatToTimelineMs(
  sourceBeatMs: number,
  sourceOffsetMs: number,
  timelineStartMs: number,
  tempoRatio = 1,
): number | null {
  if (![sourceBeatMs, sourceOffsetMs, timelineStartMs, tempoRatio].every(Number.isFinite) || tempoRatio <= 0)
    return null;
  return Math.round(timelineStartMs + (sourceBeatMs - sourceOffsetMs) / tempoRatio);
}
