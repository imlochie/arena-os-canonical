import {
  normaliseSourceEvents,
  nearestBeatProjection,
  type BeatProjection,
  type RhythmicClass,
  type SourceEvent,
} from "./musical-events";

export const DRUM_ANALYSIS_ENGINE = "waveyard-numpy-drum-transients";
export const DRUM_ANALYSIS_ENGINE_VERSION = "1.0.0";
export { DESKTOP_STEM_ANALYSIS_ENGINE as LOCAL_DRUM_ANALYSIS_ENGINE, DESKTOP_STEM_ANALYSIS_ENGINE_VERSION as LOCAL_DRUM_ANALYSIS_ENGINE_VERSION } from "./analysis-provenance";

export function drumAnalysisIdempotencyKey(stemAssetId: string, engine = DRUM_ANALYSIS_ENGINE, version = DRUM_ANALYSIS_ENGINE_VERSION) {
  return `drums:${stemAssetId}:${engine}:${version}`;
}

export type DrumEvent = SourceEvent & {
  nearestBeatIndex: number | null;
  beatOffsetMs: number | null;
};

/**
 * Drum events use the same source-relative event evidence as Phase 17. The
 * optional beat projection is derived from, not a replacement for, its source grid.
 */
export function normaliseDrumEvents(input: unknown, durationMs: number): Omit<DrumEvent, "nearestBeatIndex" | "beatOffsetMs">[] | null {
  return normaliseSourceEvents(input, durationMs);
}

export function drumAnalysisProvenanceReason(input: {
  sourceAssetId: string; expectedSourceAssetId: string;
  stemAssetId: string; expectedStemAssetId: string;
  sourceChecksumSha256: string; expectedSourceChecksumSha256: string;
  stemChecksumSha256: string; expectedStemChecksumSha256: string;
  analysisEngine: string; analysisEngineVersion: string;
}, expected = { engine: DRUM_ANALYSIS_ENGINE, version: DRUM_ANALYSIS_ENGINE_VERSION }) {
  if (input.sourceAssetId !== input.expectedSourceAssetId || input.stemAssetId !== input.expectedStemAssetId) return "source_stem_mismatch" as const;
  if (input.sourceChecksumSha256 !== input.expectedSourceChecksumSha256 || input.stemChecksumSha256 !== input.expectedStemChecksumSha256) return "analysis_stale" as const;
  if (input.analysisEngine !== expected.engine || input.analysisEngineVersion !== expected.version) return "analysis_version_mismatch" as const;
  return null;
}

export function isSupportedDrumStemType(stemType: string) {
  return stemType === "drums" || stemType === "percussion";
}

export function classifiedDrumEvent(
  event: Omit<DrumEvent, "nearestBeatIndex" | "beatOffsetMs">,
  projection: BeatProjection | null,
): DrumEvent {
  return {
    ...event,
    nearestBeatIndex: projection?.nearestBeatIndex ?? null,
    beatOffsetMs: projection?.beatOffsetMs ?? null,
  };
}

export { nearestBeatProjection };
export type { RhythmicClass };
