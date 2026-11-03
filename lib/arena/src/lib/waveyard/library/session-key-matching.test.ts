import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionKeyMatch, shiftMusicalKey } from "./session-key-matching";

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
