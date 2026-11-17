import {
  currentBpmConfidence,
  isCurrentDesktopAnalysis,
} from "../types/analysis-provenance";
import { trustedAnalysisBpmFromBeatGrid } from "../types/analysis-confidence";
import {
  createPersistedClipTempoMap,
  donorClipTempoMap,
  type PersistedClipTempoMap,
} from "./local-tempo-map";

const SHA256 = /^[a-f\d]{64}$/i;

export type AutomaticRemixTempoMapInput = {
  clip: {
    id: string;
    remixTrackId: string;
    stemAssetId: string;
    sourceOffsetMs: number;
    timelineStartMs: number;
    durationMs: number;
    tempoSyncEnabled: boolean;
  };
  stem: {
    id: string;
    sourceAssetId: string;
    checksumSha256: string | null;
    durationSeconds: number;
    channels: number;
    format: string | null;
  };
  source: {
    id: string;
    checksumSha256: string;
  };
  analysis: {
    status: string;
    analysisEngine: string | null;
    analysisEngineVersion: string | null;
    sourceChecksumSha256: string | null;
    bpm: number | null;
    bpmConfidence: number | null;
    beatConfidence?: number | null;
    beatGridMs?: unknown;
    durationMs?: number;
  } | null;
  sessionTempoBpm: number;
};

export type AutomaticRemixTempoMapResult =
  | { ok: true; map: PersistedClipTempoMap }
  | { ok: false; reason: string };

/**
 * Turns an automatic-remix BPM decision into the exact clip-bound WSOLA map
 * consumed by Studio preview and export. The source span is derived from the
 * target timeline duration and the source/target BPM ratio, then checked
 * against the actual stem duration and current source/stem provenance.
 */
export function automaticRemixTempoMap(
  input: AutomaticRemixTempoMapInput,
): AutomaticRemixTempoMapResult {
  const { clip, stem, source, analysis } = input;
  if (!clip.tempoSyncEnabled) return { ok: false, reason: "This clip does not request tempo sync." };
  if (!clip.id || !clip.remixTrackId || clip.stemAssetId !== stem.id
    || stem.sourceAssetId !== source.id) {
    return { ok: false, reason: "Clip, stem and source identities do not agree." };
  }
  if (!Number.isFinite(clip.sourceOffsetMs) || clip.sourceOffsetMs < 0
    || !Number.isFinite(clip.timelineStartMs) || clip.timelineStartMs < 0
    || !Number.isFinite(clip.durationMs) || clip.durationMs <= 0
    || !Number.isFinite(stem.durationSeconds) || stem.durationSeconds <= 0
    || !Number.isFinite(input.sessionTempoBpm) || input.sessionTempoBpm < 20 || input.sessionTempoBpm > 300) {
    return { ok: false, reason: "Clip duration or remix tempo is invalid." };
  }
  if (stem.channels !== 2 || stem.format?.toLowerCase() !== "wav"
    || !SHA256.test(source.checksumSha256) || !stem.checksumSha256 || !SHA256.test(stem.checksumSha256)) {
    return { ok: false, reason: "The exact stereo WAV source and stem checksums are required for a persisted timing map." };
  }
  if (!analysis || analysis.status !== "complete" || !isCurrentDesktopAnalysis(analysis)
    || analysis.sourceChecksumSha256 !== source.checksumSha256) {
    return { ok: false, reason: "Current checksum-matched BPM evidence or beat-grid tempo evidence is unavailable." };
  }
  const sourceBpm = trustedAnalysisBpmFromBeatGrid({
    bpm: analysis.bpm,
    bpmConfidence: currentBpmConfidence(analysis),
    beatConfidence: analysis.beatConfidence,
    beatGridMs: analysis.beatGridMs,
    analysisEngine: analysis.analysisEngine,
    analysisEngineVersion: analysis.analysisEngineVersion,
    durationMs: analysis.durationMs ?? 0,
  });
  if (sourceBpm === null) return { ok: false, reason: "Source BPM or trusted beat-grid evidence is insufficient for tempo sync." };

  // Playback rate is target/source. A WSOLA map records output/source duration,
  // so its slope is the inverse: source/target.
  const baseStretchRatio = sourceBpm / input.sessionTempoBpm;
  if (!Number.isFinite(baseStretchRatio) || baseStretchRatio < 0.1 || baseStretchRatio > 10) {
    return { ok: false, reason: "The requested tempo ratio is outside the supported range." };
  }
  const sourceSpanMs = clip.durationMs / baseStretchRatio;
  const stemDurationMs = stem.durationSeconds * 1_000;
  if (!Number.isFinite(sourceSpanMs) || sourceSpanMs <= 0
    || clip.sourceOffsetMs + sourceSpanMs > stemDurationMs + 1) {
    return { ok: false, reason: "The donor stem does not contain the source audio required for this synced clip." };
  }

  const map = donorClipTempoMap(sourceSpanMs, clip.durationMs, baseStretchRatio);
  if (!map) return { ok: false, reason: "Could not construct a bounded timing map for this clip." };
  const persisted = createPersistedClipTempoMap({
    clipId: clip.id,
    remixTrackId: clip.remixTrackId,
    stemAssetId: stem.id,
    sourceAssetId: source.id,
    sourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: stem.checksumSha256,
    sourceOffsetMs: clip.sourceOffsetMs,
    timelineStartMs: clip.timelineStartMs,
    durationMs: clip.durationMs,
    sessionTempoBpm: input.sessionTempoBpm,
    baseStretchRatio,
    map,
  });
  return persisted
    ? { ok: true, map: persisted }
    : { ok: false, reason: "The generated timing map failed clip and provenance validation." };
}
