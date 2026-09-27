import { describe, expect, it } from "vitest";
import {
  normalizeSourceSections,
  sourceSectionStatus,
  sourceSectionsAreValid,
} from "@waveyard/types";
import {
  SOURCE_SECTION_ANALYSIS_ENGINE,
  SOURCE_SECTION_ANALYSIS_ENGINE_VERSION,
  sectionAnalysisIdempotencyKey,
  sectionAnalysisQueuePayload,
} from "../../apps/worker/src/sections";

const grid = Array.from({ length: 25 }, (_, index) => index * 500);
const provenance = {
  analysisEngine: SOURCE_SECTION_ANALYSIS_ENGINE,
  analysisEngineVersion: SOURCE_SECTION_ANALYSIS_ENGINE_VERSION,
  sourceChecksumSha256: "checksum-a",
};

describe("source-coordinate structural sections", () => {
  it("normalizes deterministic ordered beat/bar ranges and their provenance", () => {
    const result = normalizeSourceSections([
      { startBeatIndex: 8, endBeatIndex: 16, label: "section", labelConfidence: 0, structuralConfidence: 0.7 },
      { startBeatIndex: 0, endBeatIndex: 8, label: "section", labelConfidence: -2, structuralConfidence: 2 },
      { startBeatIndex: 16, endBeatIndex: 24, label: "section", labelConfidence: 0, structuralConfidence: 0.5 },
    ], grid, provenance, ({ startBeatIndex, endBeatIndex, sectionIndex }) => `stable:${sectionIndex}:${startBeatIndex}:${endBeatIndex}`);
    expect(result).toEqual([
      expect.objectContaining({ id: "stable:0:0:8", sectionIndex: 0, startMs: 0, endMs: 4000, startBar: 1, endBar: 2, label: "section", labelConfidence: 0, structuralConfidence: 1 }),
      expect.objectContaining({ id: "stable:1:8:16", sectionIndex: 1, startMs: 4000, endMs: 8000, startBar: 3, endBar: 4, structuralConfidence: 0.7 }),
      expect.objectContaining({ id: "stable:2:16:24", sectionIndex: 2, startMs: 8000, endMs: 12000, startBar: 5, endBar: 6, structuralConfidence: 0.5 }),
    ]);
    expect(sourceSectionsAreValid(result, grid)).toBe(true);
  });

  it("suppresses duplicate and overlapping candidates without fabricating a whole-song range", () => {
    const result = normalizeSourceSections([
      { startBeatIndex: 0, endBeatIndex: 8, label: "section", labelConfidence: 0, structuralConfidence: 0.4 },
      { startBeatIndex: 0, endBeatIndex: 8, label: "section", labelConfidence: 0, structuralConfidence: 0.9 },
      { startBeatIndex: 7, endBeatIndex: 16, label: "section", labelConfidence: 0, structuralConfidence: 0.7 },
      { startBeatIndex: 16, endBeatIndex: 24, label: "section", labelConfidence: 0, structuralConfidence: 0.6 },
    ], grid, provenance, ({ startBeatIndex, endBeatIndex }) => `${startBeatIndex}:${endBeatIndex}`);
    expect(result.map(({ startBeatIndex, endBeatIndex }) => [startBeatIndex, endBeatIndex])).toEqual([[0, 8], [16, 24]]);
    expect(normalizeSourceSections([], grid, provenance, () => "never")).toEqual([]);
    expect(normalizeSourceSections([{ startBeatIndex: 0, endBeatIndex: 1, label: "section", labelConfidence: 0, structuralConfidence: 1 }], null, provenance, () => "never")).toEqual([]);
  });

  it("reports historical/no-grid inputs explicitly instead of a false complete empty result", () => {
    expect(sourceSectionStatus(undefined, undefined, undefined)).toBe("insufficient_analysis");
    expect(sourceSectionStatus(undefined, "complete", grid)).toBe("not_started");
    expect(sourceSectionStatus("processing", "complete", grid)).toBe("processing");
    expect(sourceSectionStatus("unavailable", "complete", grid)).toBe("unavailable");
    expect(sourceSectionStatus("complete", "failed", grid)).toBe("insufficient_analysis");
  });

  it("uses stable lifecycle idempotency and queue payload provenance on retry", () => {
    const sourceId = "source-a";
    expect(sectionAnalysisIdempotencyKey(sourceId)).toBe(sectionAnalysisIdempotencyKey(sourceId));
    expect(sectionAnalysisQueuePayload({
      id: "section-analysis-a", projectId: "project-a", sourceAssetId: sourceId, sourceAnalysisId: "beat-analysis-a",
      analysisEngine: SOURCE_SECTION_ANALYSIS_ENGINE, analysisEngineVersion: SOURCE_SECTION_ANALYSIS_ENGINE_VERSION,
    })).toEqual({
      sourceSectionAnalysisId: "section-analysis-a", projectId: "project-a", sourceAssetId: sourceId, sourceAnalysisId: "beat-analysis-a",
      analysisEngine: SOURCE_SECTION_ANALYSIS_ENGINE, analysisEngineVersion: SOURCE_SECTION_ANALYSIS_ENGINE_VERSION,
    });
  });
});
