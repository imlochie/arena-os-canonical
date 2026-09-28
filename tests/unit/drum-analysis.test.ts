import { describe, expect, it } from "vitest";
import {
  classifiedDrumEvent,
  drumAnalysisProvenanceReason,
  nearestBeatProjection,
  normaliseDrumEvents,
  DRUM_ANALYSIS_ENGINE,
  DRUM_ANALYSIS_ENGINE_VERSION,
} from "@waveyard/types";
import { drumAnalysisIdempotencyKey } from "../../apps/worker/src/drums";

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
    expect(drumAnalysisIdempotencyKey("drums-a")).toBe(drumAnalysisIdempotencyKey("drums-a"));
  });
});
