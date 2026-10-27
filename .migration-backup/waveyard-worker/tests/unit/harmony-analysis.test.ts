import { describe, expect, it } from "vitest";
import {
  chordLabel,
  harmonyAnalysisProvenanceReason,
  normaliseChordRoot,
  normaliseHarmonyEvents,
  HARMONY_ANALYSIS_ENGINE,
  HARMONY_ANALYSIS_ENGINE_VERSION,
} from "@waveyard/types";
import { harmonyAnalysisIdempotencyKey } from "../../apps/worker/src/harmony";

describe("deterministic source-relative harmony analysis", () => {
  it("normalizes canonical roots and compact chord labels", () => {
    expect(normaliseChordRoot("Db")).toBe("C#");
    expect(normaliseChordRoot("H")).toBeNull();
    expect(chordLabel({ root: "A", quality: "minor" })).toBe("Am");
    expect(chordLabel({ root: null, quality: "unknown" })).toBe("Unknown");
  });

  it("keeps ordered non-overlapping source windows and unknown uncertainty", () => {
    const timeline = [
      { startMs: 0, endMs: 2_000, root: "A", quality: "minor", confidence: 0.7 },
      { startMs: 2_000, endMs: 4_000, root: null, quality: "unknown", confidence: 0.2 },
    ];
    expect(normaliseHarmonyEvents(timeline, 4_000)).toEqual(timeline);
    expect(normaliseHarmonyEvents([{ ...timeline[0], endMs: 2_001 }, timeline[1]], 4_000)).toBeNull();
    expect(normaliseHarmonyEvents([{ ...timeline[0], root: null }], 4_000)).toBeNull();
    expect(normaliseHarmonyEvents([{ ...timeline[1], root: "A" }], 4_000)).toBeNull();
    expect(normaliseHarmonyEvents([], 4_000)).toEqual([]);
  });

  it("is repeatable and requires source checksum/version provenance", () => {
    const timeline = [{ startMs: 0, endMs: 2_000, root: "C", quality: "major", confidence: 0.8 }];
    expect(normaliseHarmonyEvents(timeline, 2_000)).toEqual(normaliseHarmonyEvents(timeline, 2_000));
    const valid = {
      sourceAssetId: "source-a", expectedSourceAssetId: "source-a", sourceChecksumSha256: "sha", expectedSourceChecksumSha256: "sha",
      analysisEngine: HARMONY_ANALYSIS_ENGINE, analysisEngineVersion: HARMONY_ANALYSIS_ENGINE_VERSION,
    };
    expect(harmonyAnalysisProvenanceReason(valid)).toBeNull();
    expect(harmonyAnalysisProvenanceReason({ ...valid, sourceAssetId: "source-b" })).toBe("source_identity_mismatch");
    expect(harmonyAnalysisProvenanceReason({ ...valid, sourceChecksumSha256: "stale" })).toBe("analysis_stale");
    expect(harmonyAnalysisIdempotencyKey("source-a")).toBe(harmonyAnalysisIdempotencyKey("source-a"));
  });
});
