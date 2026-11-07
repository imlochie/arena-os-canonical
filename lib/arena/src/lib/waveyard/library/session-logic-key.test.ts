/**
 * Key-relationship regressions for `keyCompatibility`.
 *
 * Recovered from PR #27 (see waveyard/studio/mashup-regression.test.ts for the
 * full provenance note). Split out beside the module under test rather than
 * living in the mashup folder.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { keyCompatibility } from "./session-logic";

test("relative pairs are compatible: C major / A minor", () => {
  const relative = keyCompatibility("C major", "A minor");
  assert.ok(relative.compatible, "C major / A minor should be compatible");
  assert.equal(relative.relationship, "relative", "C major / A minor should be a relative pair");
});

test("relative pairs are compatible: A major / F# minor", () => {
  const relative = keyCompatibility("A major", "F# minor");
  assert.ok(relative.compatible, "A major / F# minor should be compatible");
  assert.equal(relative.relationship, "relative", "A major / F# minor should be a relative pair");
});

test("C major / E minor is not relative, and reports its ±4 semitone shift", () => {
  const notRelative = keyCompatibility("C major", "E minor");
  assert.ok(notRelative.relationship !== "relative", "C major / E minor should NOT be relative");
  // C major to E minor is a shift of 4 semitones (or -8).
  assert.ok(
    Math.abs(notRelative.shiftSemitones) === 4,
    "C major / E minor should have a shift of ±4 semitones",
  );
});
