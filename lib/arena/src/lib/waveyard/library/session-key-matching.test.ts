import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSessionKeyMatch,
  resolveLiveStemKeyCorrection,
  resolveInstrumentalBedVocalCorrection,
  shiftMusicalKey,
} from "./session-key-matching";

test("swapped tonal stems match the audible lead rather than inheriting the receiving track's correction", () => {
  assert.equal(resolveLiveStemKeyCorrection("match", "C major", "D major", 0, "vocals"), -2);
  assert.equal(resolveLiveStemKeyCorrection("match", "C major", "D major", 2, "bass"), -2,
    "the donor already matches the shifted lead D; cancel the deck's additional +2 correction");
  assert.equal(resolveLiveStemKeyCorrection("camelot", "C major", "G major", 0, "other"), 0);
  assert.equal(resolveLiveStemKeyCorrection("match", "C major", null, 2, "vocals"), -2,
    "missing key analysis leaves a donor at its original pitch instead of inheriting the deck shift");
  assert.equal(resolveLiveStemKeyCorrection("camelot", null, "A minor", -3, "bass"), 3,
    "Camelot mode leaves a donor at its original pitch when the lead key is unknown");
  assert.equal(resolveLiveStemKeyCorrection("preserve", "C major", "D major", 2, "vocals"), -2);
  assert.equal(resolveLiveStemKeyCorrection("off", "C major", "D major", 2, "bass"), -2);
  assert.equal(resolveLiveStemKeyCorrection("match", "C major", "D major", 2, "drums"), -2,
    "drum donors are not harmonically transposed, including compensation for a shifted recipient deck");
  assert.equal(resolveLiveStemKeyCorrection("match", null, null, 0, "drums"), 0);
});

test("match mode transposes the complement tonic but reports an unchangeable mode difference", () => {
  assert.deepEqual(resolveSessionKeyMatch("match", "C major", "A minor"), {
    semitones: 3,
    sourceKey: "A minor",
    targetKey: "C minor",
    reason: "Match the lead tonic; the incoming track stays minor.",
  });
});

test("Camelot mode chooses the nearest compatible key without changing major/minor mode", () => {
  const result = resolveSessionKeyMatch("camelot", "G major", "A minor");
  assert.equal(result.targetKey, "E minor");
  assert.equal(result.semitones, -5);
  assert.match(result.reason, /nearest compatible Camelot key/);
});

test("preserve and off do not shift, while unknown match analysis is not reported as active", () => {
  assert.equal(resolveSessionKeyMatch("preserve", "C major", "A minor").semitones, 0);
  assert.equal(resolveSessionKeyMatch("off", "C major", "A minor").semitones, 0);
  assert.equal(resolveSessionKeyMatch("match", null, "A minor").semitones, null);
  assert.equal(shiftMusicalKey("B major", 1), "C major");
});

test("a complete instrumental bed becomes vocal key reference only when both keys are confident", () => {
  const confident = resolveInstrumentalBedVocalCorrection("match", "C minor", 0.85, "A major", 0.8);
  assert.equal(confident.semitones, 3);
  assert.equal(confident.bedKey, "C minor");
  assert.equal(confident.applied, true);

  const weakSeptemberQueenEvidence = resolveInstrumentalBedVocalCorrection(
    "match",
    "C minor",
    0.165,
    "A major",
    0.406,
  );
  assert.equal(weakSeptemberQueenEvidence.semitones, 0);
  assert.equal(weakSeptemberQueenEvidence.applied, false);
  assert.match(weakSeptemberQueenEvidence.reason, /below 0\.50 confidence/);

  assert.equal(resolveInstrumentalBedVocalCorrection("off", "C minor", 0.9, "A major", 0.9).semitones, 0);
  assert.equal(resolveInstrumentalBedVocalCorrection("preserve", "C minor", 0.9, "A major", 0.9).semitones, 0);
});
