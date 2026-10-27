import {
  projectSourceBeatToTimelineMs,
  tempoRatioForBpm,
} from "./beat-grid";

export type CrossSourceAlignmentState =
  | "aligned"
  | "tempo-transformed"
  | "key-transformed"
  | "fully-transformed"
  | "source-only"
  | "analysis-unavailable";

/**
 * The sole source→remix tempo rule for this layer. Tempo sync is explicit:
 * disabled clips retain source timing with a ratio of one.
 */
export function clipTempoRatio(
  tempoSyncEnabled: boolean,
  sourceBpm: number | null | undefined,
  remixBpm: number,
): number | null {
  if (!tempoSyncEnabled) return 1;
  return tempoRatioForBpm(remixBpm, sourceBpm ?? Number.NaN);
}

export type SourceBeatProjectionInput = {
  sourceBeatMs: number;
  sourceOffsetMs: number;
  timelineStartMs: number;
  sourceBpm: number | null | undefined;
  remixBpm: number;
  tempoSyncEnabled: boolean;
};

/**
 * Projects one authoritative source beat into the remix timeline. It delegates
 * the coordinate calculation to Phase 8's source-beat projection and rounds at
 * that persisted millisecond boundary only.
 */
export function projectSourceBeatToRemixMs(input: SourceBeatProjectionInput): number | null {
  const ratio = clipTempoRatio(input.tempoSyncEnabled, input.sourceBpm, input.remixBpm);
  if (!ratio) return null;
  return projectSourceBeatToTimelineMs(
    input.sourceBeatMs,
    input.sourceOffsetMs,
    input.timelineStartMs,
    ratio,
  );
}

/**
 * Solves the same projection equation for the clip's timeline anchor. Source
 * windows remain unchanged; callers persist only the returned timeline start.
 */
export function alignSourceBeatToTimelineMs(input: Omit<SourceBeatProjectionInput, "timelineStartMs"> & {
  timelineTargetMs: number;
}): number | null {
  const ratio = clipTempoRatio(input.tempoSyncEnabled, input.sourceBpm, input.remixBpm);
  if (!ratio || !Number.isFinite(input.timelineTargetMs) || input.timelineTargetMs < 0)
    return null;
  if (![input.sourceBeatMs, input.sourceOffsetMs].every(Number.isFinite)) return null;
  const ideal = input.timelineTargetMs - (input.sourceBeatMs - input.sourceOffsetMs) / ratio;
  // Integer clip anchors can sit on either side of a fractional ideal. Select
  // the nearest candidate whose canonical projection lands on the requested
  // persisted timeline millisecond, rather than accumulating rounding drift.
  const candidates = [...new Set([Math.round(ideal), Math.floor(ideal), Math.ceil(ideal)])]
    .filter((candidate) => candidate >= 0 && Number.isSafeInteger(candidate))
    .filter((candidate) => projectSourceBeatToTimelineMs(
      input.sourceBeatMs,
      input.sourceOffsetMs,
      candidate,
      ratio,
    ) === Math.round(input.timelineTargetMs))
    .sort((left, right) => Math.abs(left - ideal) - Math.abs(right - ideal) || left - right);
  return candidates[0] ?? null;
}

export function crossSourceAlignmentState(input: {
  analysisComplete: boolean;
  beatGridAvailable: boolean;
  tempoSyncEnabled: boolean;
  keySyncEnabled: boolean;
  beatSnapEnabled: boolean;
}): CrossSourceAlignmentState {
  if (!input.analysisComplete || !input.beatGridAvailable) return "analysis-unavailable";
  if (input.tempoSyncEnabled && input.keySyncEnabled) return "fully-transformed";
  if (input.tempoSyncEnabled) return "tempo-transformed";
  if (input.keySyncEnabled) return "key-transformed";
  if (input.beatSnapEnabled) return "aligned";
  return "source-only";
}
