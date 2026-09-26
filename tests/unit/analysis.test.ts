import { describe, expect, it } from "vitest";
import { analysisDisplayState } from "../../apps/web/src/components/studio/SourceAnalysisSummary";
import {
  analysisIdempotencyKey,
  analysisQueuePayload,
  beatConfidenceFromGrid,
  bpmConfidenceFromEvidence,
  keyConfidenceFromProfiles,
  normaliseAnalysisResult,
  normaliseBeatGrid,
  normaliseBpm,
  normaliseMusicalKey,
  SOURCE_ANALYSIS_ENGINE,
  SOURCE_ANALYSIS_ENGINE_VERSION,
} from "../../apps/worker/src/analysis";

const engineResult = {
  analysisEngine: SOURCE_ANALYSIS_ENGINE,
  analysisEngineVersion: SOURCE_ANALYSIS_ENGINE_VERSION,
  bpm: 120.0004,
  bpmConfidence: 0.82,
  musicalKey: "Db minor",
  keyConfidence: 0.47,
  beatGridMs: [0, 500, 1000, 1500],
  beatConfidence: 0.91,
};

describe("worker-owned musical analysis normalization", () => {
  it("normalizes BPM and keeps unknown BPM unknown", () => {
    expect(normaliseBpm(120.0004)).toBe(120);
    expect(normaliseBpm(39.9)).toBeNull();
    expect(normaliseBpm("120")).toBeNull();
    expect(
      normaliseAnalysisResult(
        { ...engineResult, bpm: null, bpmConfidence: null },
        24,
      ).bpm,
    ).toBeNull();
  });

  it("uses documented tracker evidence for BPM confidence", () => {
    expect(bpmConfidenceFromEvidence(1, 0, 1)).toBe(1);
    expect(bpmConfidenceFromEvidence(1, 1, 1)).toBe(0.35);
    expect(bpmConfidenceFromEvidence(1, 0.5, 0.5)).toBeCloseTo(0.5, 6);
  });

  it("normalizes enharmonic keys and scores profile separation", () => {
    expect(normaliseMusicalKey(" Db MINOR ")).toBe("C# minor");
    expect(normaliseMusicalKey("H major")).toBeNull();
    expect(keyConfidenceFromProfiles(0.8, 0.4)).toBe(0.5);
    expect(keyConfidenceFromProfiles(0.8, 0.8)).toBe(0);
  });

  it("rounds canonical beat milliseconds, scores regularity, and rejects unordered timing", () => {
    expect(normaliseBeatGrid([0.2, 500.6, 1000.4], 2)).toEqual([
      0,
      501,
      1000,
    ]);
    expect(beatConfidenceFromGrid(0.8, [0, 500, 1000])).toBe(0.89);
    expect(normaliseBeatGrid([0, 500, 500], 2)).toBeNull();
    expect(normaliseBeatGrid([0, 2_001], 2)).toBeNull();
  });

  it("persists engine provenance and refuses malformed analysis rather than fabricating values", () => {
    expect(normaliseAnalysisResult(engineResult, 24)).toEqual({
      ...engineResult,
      bpm: 120,
      musicalKey: "C# minor",
    });
    expect(() =>
      normaliseAnalysisResult(
        { ...engineResult, analysisEngineVersion: "unknown" },
        24,
      ),
    ).toThrow("provenance");
    expect(() =>
      normaliseAnalysisResult(
        { ...engineResult, bpm: null, bpmConfidence: 0.8 },
        24,
      ),
    ).toThrow("without a BPM");
    expect(() =>
      normaliseAnalysisResult(
        { ...engineResult, beatGridMs: [0, 500, 400] },
        24,
      ),
    ).toThrow("beat grid");
  });

  it("keeps legacy/no-analysis sources unknown and makes retry payloads idempotent", () => {
    const unknown = normaliseAnalysisResult(
      {
        analysisEngine: SOURCE_ANALYSIS_ENGINE,
        analysisEngineVersion: SOURCE_ANALYSIS_ENGINE_VERSION,
        bpm: null,
        bpmConfidence: null,
        musicalKey: null,
        keyConfidence: null,
        beatGridMs: null,
        beatConfidence: null,
      },
      24,
    );
    expect(unknown).toMatchObject({
      bpm: null,
      musicalKey: null,
      beatGridMs: null,
    });
    expect(analysisDisplayState(null)).toBe("legacy");
    expect(
      analysisDisplayState({
        id: "legacy",
        status: "failed",
        stage: "failed",
        attempts: 1,
        analysisEngine: unknown.analysisEngine,
        analysisEngineVersion: unknown.analysisEngineVersion,
        bpm: unknown.bpm,
        bpmConfidence: unknown.bpmConfidence,
        musicalKey: unknown.musicalKey,
        keyConfidence: unknown.keyConfidence,
        beatGrid: unknown.beatGridMs,
        beatConfidence: unknown.beatConfidence,
        analysisError: "failed",
        analyzedAt: null,
      }),
    ).toBe("failed");
    const sourceId = "source-legacy-or-retry";
    expect(analysisIdempotencyKey(sourceId)).toBe(
      analysisIdempotencyKey(sourceId),
    );
    expect(
      analysisQueuePayload({
        id: "analysis-id",
        projectId: "project-id",
        sourceAssetId: sourceId,
        analysisEngine: SOURCE_ANALYSIS_ENGINE,
        analysisEngineVersion: SOURCE_ANALYSIS_ENGINE_VERSION,
      }),
    ).toEqual({
      sourceAnalysisId: "analysis-id",
      projectId: "project-id",
      sourceAssetId: sourceId,
      analysisEngine: SOURCE_ANALYSIS_ENGINE,
      analysisEngineVersion: SOURCE_ANALYSIS_ENGINE_VERSION,
    });
  });
});
