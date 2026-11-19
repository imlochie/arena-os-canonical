import { normaliseIsolatedDrumTempoEvidence } from "../types/drum-analysis";
import { usableBeatGrid } from "../types/beat-grid";

export type SectionBeatGridSelection = {
  beatGridMs: number[];
  source: "source" | "isolated-drums";
  beatConfidence: number | null;
};

/**
 * Prefer the current source grid when it is trusted. If it is missing or
 * low-confidence, use only a validated isolated-drum grid; otherwise preserve
 * the source grid as a conservative fallback.
 */
export function selectSectionBeatGrid(input: {
  sourceBeatGrid: unknown;
  sourceBeatConfidence: unknown;
  isolatedDrum?: {
    bpm: unknown;
    bpmConfidence: unknown;
    beatGrid: unknown;
    beatConfidence: unknown;
  } | null;
  durationMs: number;
}): SectionBeatGridSelection | null {
  const sourceBeatGridMs = usableBeatGrid(input.sourceBeatGrid);
  const sourceConfidence = typeof input.sourceBeatConfidence === "number"
    && Number.isFinite(input.sourceBeatConfidence)
    && input.sourceBeatConfidence >= 0
    && input.sourceBeatConfidence <= 1
    ? input.sourceBeatConfidence
    : null;
  if (sourceBeatGridMs && sourceConfidence !== null && sourceConfidence >= 0.5) {
    return {
      beatGridMs: sourceBeatGridMs,
      source: "source",
      beatConfidence: sourceConfidence,
    };
  }

  const isolatedDrum = input.isolatedDrum
    ? normaliseIsolatedDrumTempoEvidence({
      ...input.isolatedDrum,
      durationMs: input.durationMs,
    })
    : null;
  if (isolatedDrum) {
    return {
      beatGridMs: isolatedDrum.beatGridMs,
      source: "isolated-drums",
      beatConfidence: isolatedDrum.beatConfidence,
    };
  }
  return sourceBeatGridMs
    ? { beatGridMs: sourceBeatGridMs, source: "source", beatConfidence: sourceConfidence }
    : null;
}
