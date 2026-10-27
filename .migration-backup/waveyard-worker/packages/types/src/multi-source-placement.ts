import { normaliseMusicalKey, semitoneShift, type MusicalKey } from "./musical-key";
import { tempoRatioForBpm, usableBeatGrid } from "./beat-grid";

export const MULTI_SOURCE_PLACEMENT_MODES = ["overlay", "hard-cut", "beat-handoff", "bar-handoff", "crossfade"] as const;
export type MultiSourcePlacementMode = (typeof MULTI_SOURCE_PLACEMENT_MODES)[number];
export type MultiSourcePlacementState = "ready" | "possible" | "experimental";

export type MultiSourcePlacementSource = {
  sourceAssetId: string;
  stemAssetId: string;
  sourceChecksumSha256: string;
  startMs: number;
  endMs: number;
  analysis: { status: string; sourceChecksumSha256: string; bpm: number | null; musicalKey: string | null; beatGridMs: unknown } | null;
};

export type MultiSourcePlacementAnchor = {
  clipId: string;
  timelineStartMs: number;
  durationMs: number;
  beatAlignedEnd: boolean;
  barAlignedEnd: boolean;
};

export type MultiSourcePlacement = {
  id: string;
  mode: MultiSourcePlacementMode;
  state: MultiSourcePlacementState;
  source: Pick<MultiSourcePlacementSource, "sourceAssetId" | "stemAssetId" | "startMs" | "endMs">;
  anchorClipId: string;
  timelineStartMs: number;
  durationMs: number;
  tempoRatio: number;
  tempoSyncEnabled: boolean;
  sourceKey: MusicalKey | null;
  targetKey: MusicalKey | null;
  keyShiftSemitones: number | null;
  keySyncEnabled: boolean;
  beatSnapEnabled: boolean;
  fadeInMs: number;
  fadeOutMs: number;
  reasons: string[];
};

function verified(source: MultiSourcePlacementSource) {
  return source.analysis?.status === "complete"
    && source.analysis.sourceChecksumSha256 === source.sourceChecksumSha256
    && usableBeatGrid(source.analysis.beatGridMs)
    && Number.isSafeInteger(source.startMs) && Number.isSafeInteger(source.endMs) && source.endMs > source.startMs;
}

/**
 * Proposes an intentional overlay or handoff from a chosen source region to a
 * chosen existing clip. It returns metadata only; acceptance writes standard
 * RemixClip/fade fields and never creates a special overlay/transition clip.
 */
export function proposeMultiSourcePlacement(input: {
  source: MultiSourcePlacementSource;
  anchor: MultiSourcePlacementAnchor;
  mode: MultiSourcePlacementMode;
  remixBpm: number;
  targetKey: string | null;
}): MultiSourcePlacement | null {
  if (!verified(input.source) || !Number.isFinite(input.remixBpm) || input.remixBpm < 20 || input.remixBpm > 300 || input.anchor.durationMs <= 0) return null;
  const ratio = tempoRatioForBpm(input.remixBpm, input.source.analysis!.bpm ?? Number.NaN);
  if (!ratio) return null;
  const sourceKey = normaliseMusicalKey(input.source.analysis?.musicalKey);
  const projectKey = normaliseMusicalKey(input.targetKey);
  const shift = sourceKey && projectKey ? semitoneShift(sourceKey, projectKey) : null;
  const tempoSyncEnabled = Math.abs(ratio - 1) > 0.0001;
  const keySyncEnabled = shift !== null && shift !== 0;
  const sourceTimelineDuration = Math.max(1, Math.round((input.source.endMs - input.source.startMs) / ratio));
  const anchorEnd = input.anchor.timelineStartMs + input.anchor.durationMs;
  const crossfadeMs = input.mode === "crossfade" ? Math.min(Math.round(60_000 / input.remixBpm), Math.floor(input.anchor.durationMs / 2), Math.floor(sourceTimelineDuration / 2)) : 0;
  const timelineStartMs = input.mode === "overlay" ? input.anchor.timelineStartMs
    : input.mode === "crossfade" ? anchorEnd - crossfadeMs
      : anchorEnd;
  const boundaryReady = input.mode === "bar-handoff" ? input.anchor.barAlignedEnd
    : input.mode === "beat-handoff" ? input.anchor.beatAlignedEnd
      : true;
  const reasons = [
    input.mode === "overlay" ? "user-selected material is stacked with the selected arrangement region" : "user-selected material begins at the selected clip handoff",
    tempoSyncEnabled ? `tempo transform required (${ratio.toFixed(4)}×)` : "native tempo matches the remix",
    projectKey && sourceKey ? keySyncEnabled ? `key transform required (${shift! >= 0 ? "+" : ""}${shift} semitones)` : "native key matches the remix" : "key relationship unavailable; no key shift will be applied",
  ];
  if (input.mode === "crossfade") reasons.push(`one-beat crossfade (${crossfadeMs} ms)`);
  if (!boundaryReady) reasons.push("selected handoff is not aligned to the requested remix boundary");
  const state: MultiSourcePlacementState = boundaryReady && Boolean(sourceKey && projectKey) ? "ready"
    : boundaryReady ? "possible" : "experimental";
  return {
    id: `placement:${input.mode}:${input.source.stemAssetId}:${input.anchor.clipId}:${timelineStartMs}:${sourceTimelineDuration}`,
    mode: input.mode,
    state,
    source: { sourceAssetId: input.source.sourceAssetId, stemAssetId: input.source.stemAssetId, startMs: input.source.startMs, endMs: input.source.endMs },
    anchorClipId: input.anchor.clipId,
    timelineStartMs,
    durationMs: sourceTimelineDuration,
    tempoRatio: ratio,
    tempoSyncEnabled,
    sourceKey,
    targetKey: projectKey,
    keyShiftSemitones: shift,
    keySyncEnabled,
    beatSnapEnabled: true,
    fadeInMs: crossfadeMs,
    fadeOutMs: crossfadeMs,
    reasons,
  };
}
