import {
  normaliseSourceEvents,
  nearestBeatProjection,
  type BeatProjection,
  type RhythmicClass,
  type SourceEvent,
} from "./musical-events";
import { usableBeatGrid } from "./beat-grid";

export const DRUM_ANALYSIS_ENGINE = "waveyard-numpy-drum-transients";
export const DRUM_ANALYSIS_ENGINE_VERSION = "1.0.0";
export { DESKTOP_STEM_ANALYSIS_ENGINE as LOCAL_DRUM_ANALYSIS_ENGINE } from "./analysis-provenance";
/** Tempo/phase evidence is a versioned extension of the original transient analysis. */
export const LOCAL_DRUM_ANALYSIS_ENGINE_VERSION = "1.1.0";

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

export type IsolatedDrumTempoEvidence = {
  bpm: number;
  bpmConfidence: number;
  beatGridMs: number[];
  beatConfidence: number;
  stemAssetId: string;
  sourceChecksumSha256: string;
  stemChecksumSha256: string;
  analysisEngine: string;
  analysisEngineVersion: string;
};

/** Accept only finite, bounded beat evidence from the exact isolated stem. */
export function normaliseIsolatedDrumTempoEvidence(input: {
  bpm: unknown;
  bpmConfidence: unknown;
  beatGrid: unknown;
  beatConfidence: unknown;
  durationMs: number;
}): Pick<IsolatedDrumTempoEvidence, "bpm" | "bpmConfidence" | "beatGridMs" | "beatConfidence"> | null {
  const bpm = input.bpm;
  const bpmConfidence = input.bpmConfidence;
  const beatConfidence = input.beatConfidence;
  const grid = usableBeatGrid(input.beatGrid);
  if (
    typeof bpm !== "number" || !Number.isFinite(bpm) || bpm < 40 || bpm > 300
    || typeof bpmConfidence !== "number" || !Number.isFinite(bpmConfidence) || bpmConfidence < 0.5 || bpmConfidence > 1
    || typeof beatConfidence !== "number" || !Number.isFinite(beatConfidence) || beatConfidence < 0.5 || beatConfidence > 1
    || !Number.isFinite(input.durationMs) || input.durationMs <= 0
    || !grid || grid.length < 4 || grid.some((time) => !Number.isSafeInteger(time) || time < 0 || time >= input.durationMs)
  ) return null;

  const intervals = grid.slice(1).map((time, index) => time - grid[index]!);
  const orderedIntervals = [...intervals].sort((a, b) => a - b);
  const medianInterval = orderedIntervals[Math.floor(orderedIntervals.length / 2)]!;
  const expectedInterval = 60_000 / bpm;
  if (Math.abs(medianInterval - expectedInterval) / expectedInterval > 0.08) return null;

  return {
    bpm,
    bpmConfidence,
    beatGridMs: grid,
    beatConfidence,
  };
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
