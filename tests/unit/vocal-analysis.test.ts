import { describe, expect, it } from "vitest";
import {
  frequencyToMidi,
  normaliseVocalPitchFrames,
  segmentVocalPhrases,
  vocalAnalysisProvenanceReason,
  VOCAL_ANALYSIS_ENGINE,
  VOCAL_ANALYSIS_ENGINE_VERSION,
} from "@waveyard/types";
import { vocalAnalysisIdempotencyKey } from "../../apps/worker/src/vocal";

describe("deterministic isolated-vocal analysis V1", () => {
  const voiced = { timestampMs: 0, frequencyHz: 440, midiFloat: 69, nearestMidiNote: 69, confidence: 0.8, voiced: true };
  const silent = { timestampMs: 100, frequencyHz: null, midiFloat: null, nearestMidiNote: null, confidence: 0, voiced: false };

  it("keeps explicit unvoiced frames null and derives mathematically consistent pitch", () => {
    expect(frequencyToMidi(440)).toBe(69);
    expect(normaliseVocalPitchFrames([voiced, silent], 1_000)).toEqual([voiced, silent]);
    expect(normaliseVocalPitchFrames([{ ...voiced, frequencyHz: 440, midiFloat: 68.4 }], 1_000)).toBeNull();
    expect(normaliseVocalPitchFrames([{ ...silent, frequencyHz: 0 }], 1_000)).toBeNull();
  });

  it("rejects out-of-range, unordered, and malformed voiced evidence", () => {
    expect(normaliseVocalPitchFrames([{ ...voiced, frequencyHz: 1_201 }], 1_000)).toBeNull();
    expect(normaliseVocalPitchFrames([voiced, { ...voiced, timestampMs: 0 }], 1_000)).toBeNull();
    expect(normaliseVocalPitchFrames([{ ...voiced, confidence: 1.1 }], 1_000)).toBeNull();
  });

  it("segments only voiced continuity with a deterministic silence gap", () => {
    const frames = normaliseVocalPitchFrames([
      voiced,
      { ...voiced, timestampMs: 100, confidence: 0.6 },
      { ...silent, timestampMs: 200 },
      { ...voiced, timestampMs: 500, confidence: 1 },
    ], 1_000)!;
    expect(segmentVocalPhrases(frames)).toEqual([
      { startMs: 0, endMs: 100, confidence: 0.7 },
      { startMs: 500, endMs: 500, confidence: 1 },
    ]);
  });

  it("requires source, isolated stem, checksums, and engine provenance", () => {
    const valid = {
      sourceAssetId: "source-a", expectedSourceAssetId: "source-a", stemAssetId: "vocals-a", expectedStemAssetId: "vocals-a",
      sourceChecksumSha256: "source-sha", expectedSourceChecksumSha256: "source-sha", stemChecksumSha256: "stem-sha", expectedStemChecksumSha256: "stem-sha",
      analysisEngine: VOCAL_ANALYSIS_ENGINE, analysisEngineVersion: VOCAL_ANALYSIS_ENGINE_VERSION,
    };
    expect(vocalAnalysisProvenanceReason(valid)).toBeNull();
    expect(vocalAnalysisProvenanceReason({ ...valid, stemAssetId: "drums-a" })).toBe("source_stem_mismatch");
    expect(vocalAnalysisProvenanceReason({ ...valid, stemChecksumSha256: "changed" })).toBe("analysis_stale");
    expect(vocalAnalysisProvenanceReason({ ...valid, analysisEngineVersion: "0" })).toBe("analysis_version_mismatch");
    expect(vocalAnalysisIdempotencyKey("vocals-a")).toBe(vocalAnalysisIdempotencyKey("vocals-a"));
    expect(vocalAnalysisIdempotencyKey("vocals-a")).not.toBe(vocalAnalysisIdempotencyKey("vocals-b"));
  });
});
