import assert from "node:assert/strict";
import test from "node:test";
import {
  compactMusicAnalysisLabel,
  trustedAnalysisBeatGrid,
  trustedAnalysisBpm,
  trustedAnalysisKey,
} from "./analysis-confidence";

test("compact labels avoid presenting weak real-song estimates as facts", () => {
  assert.equal(
    compactMusicAnalysisLabel({
      bpm: 109.957,
      bpmConfidence: 0.512,
      musicalKey: "F minor",
      keyConfidence: 0.034,
    }),
    "≈110.0 BPM · Key uncertain",
  );
  assert.equal(
    compactMusicAnalysisLabel({
      bpm: 172.266,
      bpmConfidence: 0.878,
      musicalKey: "C minor",
      keyConfidence: 0.245,
    }),
    "≈172.3 BPM · Key uncertain",
  );
  assert.equal(
    compactMusicAnalysisLabel({
      bpm: 123.047,
      bpmConfidence: 0.624,
      musicalKey: "A major",
      keyConfidence: 0.573,
    }),
    "≈123.0 BPM · A major",
  );
});

test("low-confidence tempo or key cannot drive automatic mixing", () => {
  assert.equal(trustedAnalysisBpm(156.605, 0.323), null);
  assert.equal(trustedAnalysisKey("D# major", 0.086), null);
  assert.equal(trustedAnalysisBpm(109.957, 0.512), 109.957);
  assert.equal(trustedAnalysisKey("A major", 0.573), "A major");
});

test("beat grid requires both confident BPM and beat-fit evidence", () => {
  assert.equal(trustedAnalysisBeatGrid([0, 500, 1000], 0.323, 0.95), null);
  assert.equal(trustedAnalysisBeatGrid([0, 500, 1000], 0.95, 0.49), null);
  assert.deepEqual(trustedAnalysisBeatGrid([0, 500, 1000], 0.95, 0.95), [0, 500, 1000]);
  assert.equal(trustedAnalysisBeatGrid([0, 500, 400], 0.95, 0.95), null);
});

test("stale local analysis is labeled for refresh instead of as current music data", () => {
  assert.equal(
    compactMusicAnalysisLabel({
      bpm: 124,
      bpmConfidence: 0.9,
      musicalKey: "A major",
      keyConfidence: 0.9,
      analysisEngine: "arena-js-dsp",
      analysisEngineVersion: "1.2.0",
    }),
    "Analysis needs refresh",
  );
});
