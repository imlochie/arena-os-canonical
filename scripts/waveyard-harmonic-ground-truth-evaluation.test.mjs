import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapSongMacroF1, evaluateStudy, scoreSong } from "./waveyard-harmonic-ground-truth-evaluation.mjs";

test("adjudicated matching chord timeline scores exact chord, root and quality", () => {
  const metrics = scoreSong({ intervals: [{ startMs: 0, endMs: 1000, root: "C", quality: "major", certainty: "confident" }], changePoints: [] },
    { events: [{ startMs: 0, endMs: 1000, root: "C", quality: "major", confidence: 0.2 }] }, 1000);
  assert.equal(metrics.chord.macroF1, 1);
  assert.equal(metrics.chord.precision, 1);
  assert.equal(metrics.chord.recall, 1);
  assert.equal(metrics.rootAccuracy, 1);
  assert.equal(metrics.chordQualityAccuracyGivenCorrectRoot, 1);
  assert.equal(metrics.abstentionRateOnLabeledBins, 0);
});

test("unknown references expose unsupported named predictions without inventing accuracy", () => {
  const metrics = scoreSong({ intervals: [{ startMs: 0, endMs: 1000, root: null, quality: "unknown", certainty: "confident" }], changePoints: [] },
    { events: [{ startMs: 0, endMs: 1000, root: "D", quality: "minor", confidence: 0.5 }] }, 1000);
  assert.equal(metrics.chord, null);
  assert.equal(metrics.unsupportedPredictionRate, 1);
  assert.equal(metrics.unsupportedPredictionBins, 10);
});

test("a wrong root with the right quality is not counted as a correct chord", () => {
  const metrics = scoreSong({ intervals: [{ startMs: 0, endMs: 1000, root: "C", quality: "major" }], changePoints: [] },
    { events: [{ startMs: 0, endMs: 1000, root: "F", quality: "major", confidence: 0.5 }] }, 1000);
  assert.equal(metrics.chord.macroF1, 0);
  assert.equal(metrics.rootAccuracy, 0);
});

test("change timing uses one-to-one nearest matches within the declared tolerance", () => {
  const metrics = scoreSong({ intervals: [], changePoints: [{ timeMs: 1000, certainty: "confident" }] },
    { events: [
      { startMs: 0, endMs: 1100, root: "C", quality: "major", confidence: 0.2 },
      { startMs: 1100, endMs: 2000, root: "F", quality: "major", confidence: 0.2 },
    ] }, 2000, 200);
  assert.equal(metrics.chordChangeTiming.matchedChanges, 1);
  assert.equal(metrics.chordChangeTiming.meanAbsoluteErrorMs, 100);
});

test("bootstrap resamples songs deterministically and refuses a one-song interval", () => {
  assert.equal(bootstrapSongMacroF1([{ metrics: { chord: { macroF1: 1 } } }]).lower95, null);
  const songs = [{ metrics: { chord: { macroF1: 0.25 } } }, { metrics: { chord: { macroF1: 0.75 } } }];
  assert.deepEqual(bootstrapSongMacroF1(songs), bootstrapSongMacroF1(songs));
  assert.equal(bootstrapSongMacroF1(songs).songCount, 2);
});

test("unreviewed or non-adjudicated sources remain blocked with null scores", () => {
  const template = { annotationProtocol: {}, recordings: [{ id: "song", sourceSha256: "a".repeat(64), durationMs: 1000, partition: "held-out" }], annotations: [] };
  const predictions = { status: "measured", measurements: [{ trackId: "song", sourceDomain: "original-source", assetSha256: "a".repeat(64), candidate: { events: [] } }] };
  const report = evaluateStudy(template, predictions);
  assert.equal(report.status, "blocked-reference-annotations-incomplete");
  assert.equal(report.metrics, null);
  assert.ok(report.blockers[0].reasons.some((reason) => reason.includes("adjudicated")));
});
