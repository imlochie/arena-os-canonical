import { describe, it } from "node:test";
import { expect } from "../../test-shim";
import {
  eventAnalysisProvenanceReason,
  normaliseSourceEvents,
  SOURCE_EVENT_ANALYSIS_ENGINE,
  SOURCE_EVENT_ANALYSIS_ENGINE_VERSION,
} from "../index";

describe("deterministic source-relative musical events", () => {
  it("orders events and keeps the strongest near-duplicate evidence", () => {
    expect(normaliseSourceEvents([
      { timestampMs: 100, strength: 0.3 },
      { timestampMs: 90, strength: 0.8 },
      { timestampMs: 500, strength: 0.4 },
    ], 1_000)).toEqual([
      { timestampMs: 90, strength: 0.8, confidence: 0.8, rhythmicClass: null },
      { timestampMs: 500, strength: 0.4, confidence: 0.4, rhythmicClass: null },
    ]);
  });

  it("represents silence/no-event audio as an empty, repeatable result", () => {
    expect(normaliseSourceEvents([], 1_000)).toEqual([]);
    const evidence = [{ timestampMs: 1_000, strength: 0.5 }, { timestampMs: 2_000, strength: 1 }];
    expect(normaliseSourceEvents(evidence, 3_000)).toEqual(normaliseSourceEvents(evidence, 3_000));
  });

  it("rejects non-source-relative timestamps and invalid confidence", () => {
    expect(normaliseSourceEvents([{ timestampMs: -1, strength: 0.5 }], 1_000)).toBeNull();
    expect(normaliseSourceEvents([{ timestampMs: 1_001, strength: 0.5 }], 1_000)).toBeNull();
    expect(normaliseSourceEvents([{ timestampMs: 1, strength: 1.1 }], 1_000)).toBeNull();
  });

  it("keeps analysis provenance tied to source identity and engine version", () => {
    const valid = {
      sourceAssetId: "source-a", expectedSourceAssetId: "source-a",
      sourceChecksumSha256: "sha", expectedSourceChecksumSha256: "sha",
      analysisEngine: SOURCE_EVENT_ANALYSIS_ENGINE,
      analysisEngineVersion: SOURCE_EVENT_ANALYSIS_ENGINE_VERSION,
    };
    expect(eventAnalysisProvenanceReason(valid)).toBeNull();
    expect(eventAnalysisProvenanceReason({ ...valid, sourceAssetId: "source-b" })).toBe("source_identity_mismatch");
    expect(eventAnalysisProvenanceReason({ ...valid, sourceChecksumSha256: "other" })).toBe("source_checksum_mismatch");
    expect(eventAnalysisProvenanceReason({ ...valid, analysisEngineVersion: "0" })).toBe("analysis_version_mismatch");
  });
});
