import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionKeyMatch, resolveLiveStemKeyCorrection, shiftMusicalKey } from "./session-key-matching";

test("swapped tonal stems match the audible lead rather than inheriting the receiving track's correction", () => {
  assert.equal(resolveLiveStemKeyCorrection("match", "C major", "D major", 0, "vocals"), -2);
  assert.equal(resolveLiveStemKeyCorrection("match", "C major", "D major", 2, "bass"), -2,
    "the donor already matches the shifted lead D; cancel the deck's additional +2 correction");
  assert.equal(resolveLiveStemKeyCorrection("camelot", "C major", "G major", 0, "other"), 0);
  assert.equal(resolveLiveStemKeyCorrection("match", "C major", null, 0, "vocals"), null);
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
