/**
 * Automatic passage adaptation is deliberately narrower than the renderer's
 * general-purpose WSOLA range. Beyond this envelope, timing distortion is too
 * large to treat as an automatic remix decision.
 */
export const MIN_AUTOMATIC_TEMPO_RATIO = 0.5;
export const MAX_AUTOMATIC_TEMPO_RATIO = 2;

export type AutomaticTempoTransform = {
  /** WSOLA output-time / source-time slope, matching the persisted clip map. */
  baseStretchRatio: number;
  /** Donor source milliseconds consumed for each target-timeline millisecond. */
  sourcePerTimelineRatio: number;
};

/**
 * Resolve the exact constant-tempo transform used by automatic-remix clips.
 * `sourceBpm / targetBpm` is the renderer's output/source time slope; its
 * reciprocal converts a target timeline span back into the donor source span.
 */
export function automaticTempoTransform(
  sourceBpm: number,
  targetBpm: number,
): AutomaticTempoTransform | null {
  if (![sourceBpm, targetBpm].every((value) => Number.isFinite(value) && value > 0)) return null;
  const baseStretchRatio = sourceBpm / targetBpm;
  if (baseStretchRatio < MIN_AUTOMATIC_TEMPO_RATIO
    || baseStretchRatio > MAX_AUTOMATIC_TEMPO_RATIO) return null;
  return { baseStretchRatio, sourcePerTimelineRatio: 1 / baseStretchRatio };
}

/** Source audio consumed by a target-timeline span at the automatic BPM ratio. */
export function automaticTempoSourceSpanMs(
  timelineDurationMs: number,
  sourceBpm: number,
  targetBpm: number,
): number | null {
  if (!Number.isFinite(timelineDurationMs) || timelineDurationMs <= 0) return null;
  const transform = automaticTempoTransform(sourceBpm, targetBpm);
  if (!transform) return null;
  const sourceSpanMs = timelineDurationMs * transform.sourcePerTimelineRatio;
  return Number.isFinite(sourceSpanMs) && sourceSpanMs > 0 ? sourceSpanMs : null;
}
