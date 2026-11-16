import assert from "node:assert/strict";
import test from "node:test";

import { decideDonorBassBed } from "../donor-bass-bed-decision";
import type { BassHarmonyChord, BassLineNote } from "../bass-harmony-fit";

const cMajor: BassHarmonyChord[] = [{ startMs: 0, endMs: 4000, root: 0, pitchClasses: [0, 4, 7] }];
const line = (midiNote: number): BassLineNote[] => [{ startMs: 0, endMs: 4000, midiNote, confidence: 0.95 }];

test("recommends donor bass replacement only when it avoids a contradiction the bed bass has", () => {
  const result = decideDonorBassBed({
    donorBass: line(36), // C, the chord root
    retainedBedBass: line(42), // F#, unresolved against C major
    bedChords: cMajor,
    fromMs: 0,
    toMs: 4000,
  });
  assert.equal(result.outcome, "replace");
  assert.equal(result.measurements.donorBass.status, "measured");
  assert.equal(result.measurements.retainedBedBass.status, "measured");
});

test("keeps the retained bass when the donor contradicts the bed harmony", () => {
  const result = decideDonorBassBed({
    donorBass: line(42),
    retainedBedBass: line(36),
    bedChords: cMajor,
    fromMs: 0,
    toMs: 4000,
  });
  assert.equal(result.outcome, "reject");
});

test("does not recommend layering or replacement when both bass lines fit", () => {
  const result = decideDonorBassBed({
    donorBass: line(43), // G, a chord tone
    retainedBedBass: line(36),
    bedChords: cMajor,
    fromMs: 0,
    toMs: 4000,
  });
  assert.equal(result.outcome, "retain");
});

test("refuses to choose when both bass lines contradict or the evidence is insufficient", () => {
  const bothConflict = decideDonorBassBed({
    donorBass: line(42),
    retainedBedBass: line(46),
    bedChords: cMajor,
    fromMs: 0,
    toMs: 4000,
  });
  assert.equal(bothConflict.outcome, "unavailable");

  const tooShort = decideDonorBassBed({
    donorBass: [{ startMs: 0, endMs: 600, midiNote: 36, confidence: 0.9 }],
    retainedBedBass: line(36),
    bedChords: cMajor,
    fromMs: 0,
    toMs: 4000,
  });
  assert.equal(tooShort.outcome, "unavailable");
});
