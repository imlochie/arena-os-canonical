import type { ClipFadeShape } from "../fades";
import {
  projectSourceBeatToTimelineMs,
  usableBeatGrid,
} from "./beat-grid";

export type MusicalClipInput = {
  id?: string;
  stemAssetId: string;
  timelineStartMs: number;
  durationMs: number;
  sourceOffsetMs: number;
  gain: number;
  fadeInMs: number;
  fadeOutMs: number;
  // Missing on historical snapshots means "linear" (original behaviour).
  fadeShape?: ClipFadeShape;
  tempoSyncEnabled: boolean;
  keySyncEnabled: boolean;
  beatSnapEnabled: boolean;
};

export type BeatRangeResult =
  | { ok: true; sourceOffsetMs: number; sourceDurationMs: number }
  | { ok: false; reason: "beat_grid_unavailable" | "beat_range_invalid" | "source_bounds_invalid" };

/** Resolves two existing source-grid indices to a bounded immutable-source window. */
export function beatRangeToSourceWindow(
  beatGridMs: unknown,
  startBeatIndex: number,
  endBeatIndex: number,
  sourceDurationMs: number,
): BeatRangeResult {
  const beats = usableBeatGrid(beatGridMs);
  if (!beats) return { ok: false, reason: "beat_grid_unavailable" };
  if (beats.some((beat, index) => index > 0 && beat === beats[index - 1]))
    return { ok: false, reason: "beat_range_invalid" };
  if (!Number.isInteger(startBeatIndex) || !Number.isInteger(endBeatIndex) ||
    startBeatIndex < 0 || endBeatIndex <= startBeatIndex || endBeatIndex >= beats.length)
    return { ok: false, reason: "beat_range_invalid" };
  const sourceOffsetMs = beats[startBeatIndex];
  const sourceEndMs = beats[endBeatIndex];
  if (sourceEndMs <= sourceOffsetMs)
    return { ok: false, reason: "beat_range_invalid" };
  if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0 || sourceEndMs > sourceDurationMs)
    return { ok: false, reason: "source_bounds_invalid" };
  return { ok: true, sourceOffsetMs, sourceDurationMs: sourceEndMs - sourceOffsetMs };
}

export type SliceResult =
  | { ok: true; clip: MusicalClipInput }
  | { ok: false; reason: "beat_grid_unavailable" | "beat_range_invalid" | "source_bounds_invalid" };

/**
 * Creates independent arrangement metadata for a beat-defined source window.
 * A Phase 6 tempo ratio maps source duration to persisted output duration;
 * source beat positions themselves remain in source coordinates.
 */
export function sliceClipToBeatRange(
  clip: MusicalClipInput,
  beatGridMs: unknown,
  startBeatIndex: number,
  endBeatIndex: number,
  sourceDurationMs: number,
  tempoRatio = 1,
): SliceResult {
  const window = beatRangeToSourceWindow(
    beatGridMs,
    startBeatIndex,
    endBeatIndex,
    sourceDurationMs,
  );
  if (!window.ok) return window;
  if (!Number.isFinite(tempoRatio) || tempoRatio <= 0)
    return { ok: false, reason: "source_bounds_invalid" };
  const durationMs = Math.max(1, Math.round(window.sourceDurationMs / tempoRatio));
  const fadeOutMs = Math.min(clip.fadeOutMs, durationMs);
  return {
    ok: true,
    clip: {
      ...clip,
      id: undefined,
      // A slice remains at its selected clip's timeline placement. Projection
      // stays available for callers that want an explicit source→timeline view.
      timelineStartMs: clip.timelineStartMs,
      sourceOffsetMs: window.sourceOffsetMs,
      durationMs,
      fadeOutMs,
      fadeInMs: Math.min(clip.fadeInMs, durationMs - fadeOutMs),
    },
  };
}

/** Returns independent ordinary clips positioned directly after the selected region. */
export function createLoopClips(
  clip: MusicalClipInput,
  repetitions: number,
  maximumRepetitions = 64,
): MusicalClipInput[] | null {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > maximumRepetitions)
    return null;
  return Array.from({ length: repetitions }, (_, index) => ({
    ...clip,
    id: undefined,
    timelineStartMs: Math.round(clip.timelineStartMs + clip.durationMs * (index + 1)),
  }));
}

/** Exposes the same Phase 8 projection without letting slices redefine source beats. */
export function projectSliceSourceBeat(
  clip: Pick<MusicalClipInput, "sourceOffsetMs" | "timelineStartMs">,
  sourceBeatMs: number,
  tempoRatio = 1,
) {
  return projectSourceBeatToTimelineMs(
    sourceBeatMs,
    clip.sourceOffsetMs,
    clip.timelineStartMs,
    tempoRatio,
  );
}
