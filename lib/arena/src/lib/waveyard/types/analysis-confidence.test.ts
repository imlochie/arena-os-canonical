import assert from "node:assert/strict";
import test from "node:test";
import {
  compactMusicAnalysisLabel,
  combineBeatGridConfidence,
  recoverBeatGridAlignmentConfidence,
  trustedAnalysisBeatGrid,
  trustedAnalysisBpm,
  trustedAnalysisBpmFromBeatGrid,
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

test("persisted beat confidence can recover its current-version phase-fit component", () => {
  const persisted = combineBeatGridConfidence(0.426, 0.905, 408);
  assert.equal(persisted, 0.642);
  assert.equal(recoverBeatGridAlignmentConfidence(0.426, persisted), 0.906,
    "rounding in the persisted combined score is retained honestly");
  assert.equal(recoverBeatGridAlignmentConfidence(0.426, null), null);
  assert.equal(recoverBeatGridAlignmentConfidence(null, 0.642), null);
  assert.equal(recoverBeatGridAlignmentConfidence(0.9, 0.01), null,
    "inconsistent evidence must not produce a clipped confidence");
});

test("trusted current beat-grid fit recovers a usable tempo when autocorrelation confidence is weak", () => {
  const beatGridMs = Array.from({ length: 41 }, (_, index) => Math.round(index * 60_000 / 110));
  const input = {
    bpm: 109.957,
    bpmConfidence: 0.426,
    beatConfidence: 0.642,
    beatGridMs,
    analysisEngine: "arena-js-dsp",
    analysisEngineVersion: "1.4.0",
    durationMs: 22_000,
  };

  assert.equal(trustedAnalysisBpm(input.bpm, input.bpmConfidence), null,
    "the autocorrelation estimate alone remains below the mixing threshold");
  assert.ok(Math.abs(trustedAnalysisBpmFromBeatGrid(input)! - 110) < 0.1,
    "the separately measured, stable full-span beat grid recovers the tempo");
  assert.equal(trustedAnalysisBpmFromBeatGrid({ ...input, analysisEngineVersion: "1.3.0" }), null,
    "the v1.4 confidence formula must not be applied to another analyzer version");
  assert.equal(trustedAnalysisBpmFromBeatGrid({ ...input, bpm: 130 }), null,
    "a stable grid cannot override a disagreeing BPM candidate");
  assert.equal(trustedAnalysisBpmFromBeatGrid({ ...input, beatGridMs: beatGridMs.slice(0, 20), durationMs: 22_000 }), null,
    "short evidence cannot establish a stable whole-span tempo");
  assert.equal(trustedAnalysisBpmFromBeatGrid({
    ...input,
    beatGridMs: beatGridMs.map((beat, index) => beat + (index % 2 ? 110 : 0)),
  }), null, "a materially unstable grid must not establish tempo");
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
