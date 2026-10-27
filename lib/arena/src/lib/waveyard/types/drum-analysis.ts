import {
  normaliseSourceEvents,
  type BeatProjection,
  type RhythmicClass,
  type SourceEvent,
} from "./musical-events";

export const DRUM_ANALYSIS_ENGINE = "waveyard-numpy-drum-transients";
export const DRUM_ANALYSIS_ENGINE_VERSION = "1.0.0";

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
}) {
  if (input.sourceAssetId !== input.expectedSourceAssetId || input.stemAssetId !== input.expectedStemAssetId) return "source_stem_mismatch" as const;
  if (input.sourceChecksumSha256 !== input.expectedSourceChecksumSha256 || input.stemChecksumSha256 !== input.expectedStemChecksumSha256) return "analysis_stale" as const;
  if (input.analysisEngine !== DRUM_ANALYSIS_ENGINE || input.analysisEngineVersion !== DRUM_ANALYSIS_ENGINE_VERSION) return "analysis_version_mismatch" as const;
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

export type { RhythmicClass };
