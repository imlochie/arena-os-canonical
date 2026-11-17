import { describe, it } from "node:test";
import { expect } from "./test-shim";
import {
  classifiedDrumEvent,
  drumAnalysisProvenanceReason,
  nearestBeatProjection,
  normaliseDrumEvents,
  drumAnalysisIdempotencyKey,
  DRUM_ANALYSIS_ENGINE,
  DRUM_ANALYSIS_ENGINE_VERSION,
  LOCAL_DRUM_ANALYSIS_ENGINE,
  LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
  normaliseIsolatedDrumTempoEvidence,
} from "./types/drum-analysis";

const kick = { timestampMs: 100, strength: 0.9, confidence: 0.85, rhythmicClass: "kick" } as const;

describe("deterministic isolated-drum transient analysis", () => {
  it("orders reusable event evidence, bounds confidence, and retains unclassified evidence", () => {
    expect(normaliseDrumEvents([kick, { timestampMs: 50, strength: 0.4, confidence: 0.4, rhythmicClass: null }], 1_000)).toEqual([
      { timestampMs: 50, strength: 0.4, confidence: 0.4, rhythmicClass: null },
      kick,
    ]);
    expect(normaliseDrumEvents([{ ...kick, confidence: 1.1 }], 1_000)).toBeNull();
    expect(normaliseDrumEvents([{ ...kick, rhythmicClass: "tom" }], 1_000)).toBeNull();
    expect(normaliseDrumEvents([], 1_000)).toEqual([]);
  });

  it("projects events only onto the existing source beat grid", () => {
    expect(nearestBeatProjection(490, [0, 500, 1_000])).toEqual({ nearestBeatIndex: 1, beatOffsetMs: -10 });
    expect(nearestBeatProjection(750, [0, 500, 1_000])).toEqual({ nearestBeatIndex: 1, beatOffsetMs: 250 });
    expect(nearestBeatProjection(100, null)).toBeNull();
    expect(classifiedDrumEvent(kick, nearestBeatProjection(kick.timestampMs, [0, 500]))).toMatchObject({ nearestBeatIndex: 0, beatOffsetMs: 100 });
  });

  it("is repeatable and rejects stale/mismatched stem provenance", () => {
    const result = normaliseDrumEvents([kick], 1_000);
    expect(result).toEqual(normaliseDrumEvents([kick], 1_000));
    const valid = {
      sourceAssetId: "source-a", expectedSourceAssetId: "source-a", stemAssetId: "drums-a", expectedStemAssetId: "drums-a",
      sourceChecksumSha256: "source-sha", expectedSourceChecksumSha256: "source-sha", stemChecksumSha256: "stem-sha", expectedStemChecksumSha256: "stem-sha",
      analysisEngine: DRUM_ANALYSIS_ENGINE, analysisEngineVersion: DRUM_ANALYSIS_ENGINE_VERSION,
    };
    expect(drumAnalysisProvenanceReason(valid)).toBeNull();
    expect(drumAnalysisProvenanceReason({ ...valid, stemAssetId: "mixed-a" })).toBe("source_stem_mismatch");
    expect(drumAnalysisProvenanceReason({ ...valid, stemChecksumSha256: "old" })).toBe("analysis_stale");
    expect(drumAnalysisIdempotencyKey("drums-a")).toBe(`drums:drums-a:${DRUM_ANALYSIS_ENGINE}:${DRUM_ANALYSIS_ENGINE_VERSION}`);
  });

  it("accepts only confident, duration-bounded drum beat grids that agree with measured tempo", () => {
    const grid = [0, 500, 1_000, 1_500, 2_000, 2_500];
    expect(normaliseIsolatedDrumTempoEvidence({
      bpm: 120,
      bpmConfidence: 0.8,
      beatGrid: grid,
      beatConfidence: 0.75,
      durationMs: 3_000,
    })).toEqual({
      bpm: 120,
      bpmConfidence: 0.8,
      beatGridMs: grid,
      beatConfidence: 0.75,
    });
    expect(normaliseIsolatedDrumTempoEvidence({
      bpm: 110,
      bpmConfidence: 0.9,
      beatGrid: grid,
      beatConfidence: 0.9,
      durationMs: 3_000,
    })).toBeNull();
    expect(normaliseIsolatedDrumTempoEvidence({
      bpm: 120,
      bpmConfidence: 0.49,
      beatGrid: grid,
      beatConfidence: 0.9,
      durationMs: 3_000,
    })).toBeNull();
    expect(normaliseIsolatedDrumTempoEvidence({
      bpm: 120,
      bpmConfidence: 0.9,
      beatGrid: [...grid, 3_000],
      beatConfidence: 0.9,
      durationMs: 3_000,
    })).toBeNull();
    expect(LOCAL_DRUM_ANALYSIS_ENGINE).toBe("arena-js-stem-analysis");
    expect(LOCAL_DRUM_ANALYSIS_ENGINE_VERSION).not.toBe(DRUM_ANALYSIS_ENGINE_VERSION,
      "the new tempo payload requires its own version without invalidating unrelated analysis engines");
  });
});
