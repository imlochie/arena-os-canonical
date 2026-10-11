/**
 * Composer tests — the "knows exactly when and how" guarantees:
 * diatonic to the analyzed key, quantized to the analyzed beat grid,
 * scoped to the analyzed sections, deterministic per seed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  composeArrangementLayer,
  scaleForKey,
  usedPitchClasses,
  validateArrangementInstruction,
  type ArrangementInstruction,
  type ComposerEvidence,
} from "./composer";

const BPM = 90;
const FS_MS = 60000 / BPM; // 666.67 ms per beat

function evidence(): ComposerEvidence {
  // 16 beats (4 bars), two sections of 8 beats each.
  const beatGridMs = Array.from({ length: 16 }, (_, i) => Math.round(i * FS_MS));
  return {
    musicalKey: "A minor",
    bpm: BPM,
    beatGridMs,
    sections: [
      { sectionIndex: 0, startMs: 0, endMs: Math.round(8 * FS_MS), startBeatIndex: 0, endBeatIndex: 8 },
      { sectionIndex: 1, startMs: Math.round(8 * FS_MS), endMs: Math.round(16 * FS_MS), startBeatIndex: 8, endBeatIndex: 16 },
    ],
  };
}

function instruction(patch: Partial<ArrangementInstruction> = {}): ArrangementInstruction {
  return {
    format: "waveyard-arrangement-instruction-v1",
    instrument: "strings",
    mood: "sinister",
    targetSections: "all",
    density: "medium",
    register: "low",
    level: 0.6,
    seed: 42,
    ...patch,
  };
}

test("scaleForKey resolves major and minor correctly", () => {
  assert.deepEqual(scaleForKey("C major"), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual(scaleForKey("A minor"), [9, 11, 0, 2, 4, 5, 7]);
  // F minor: F G Ab Bb C Db Eb
  assert.deepEqual(scaleForKey("F minor"), [5, 7, 8, 10, 0, 1, 3]);
  assert.equal(scaleForKey("not a key"), null);
});

test("composed notes are diatonic to the analyzed key", () => {
  const layer = composeArrangementLayer(instruction(), evidence());
  assert.ok(layer.events.length > 0);
  const scale = new Set(scaleForKey("A minor"));
  for (const event of layer.events)
    assert.ok(scale.has(((event.midi % 12) + 12) % 12), `midi ${event.midi} is out of key`);
});

test("note starts are quantized to the analyzed beat grid", () => {
  const beats = evidence().beatGridMs;
  const layer = composeArrangementLayer(instruction(), evidence());
  const beatSet = new Set(beats);
  for (const event of layer.events)
    assert.ok(beatSet.has(event.startMs), `start ${event.startMs} ms is off-grid`);
});

test("section scoping: targeted sections only", () => {
  const layer = composeArrangementLayer(
    instruction({ targetSections: [1] }),
    evidence(),
  );
  const sectionOneStart = evidence().sections[1].startMs;
  assert.ok(layer.events.length > 0);
  for (const event of layer.events)
    assert.ok(event.startMs >= sectionOneStart, `event at ${event.startMs} leaked into section 0`);

  const layerZero = composeArrangementLayer(instruction({ targetSections: [0] }), evidence());
  for (const event of layerZero.events)
    assert.ok(event.startMs < sectionOneStart, "section-0 layer must stay in section 0");
});

test("density changes the number of placements", () => {
  const sparse = composeArrangementLayer(instruction({ density: "sparse" }), evidence());
  const dense = composeArrangementLayer(instruction({ density: "dense", mood: "bright" }), evidence());
  assert.ok(dense.events.length > sparse.events.length, `dense ${dense.events.length} vs sparse ${sparse.events.length}`);
});

test("sinister in a major key darkens to PARALLEL minor (documented behavior)", () => {
  const majorEvidence = { ...evidence(), musicalKey: "C major" };
  const layer = composeArrangementLayer(instruction({ mood: "sinister" }), majorEvidence);
  const used = new Set(usedPitchClasses(layer));
  // Parallel minor of C major = C minor: Eb(3), Ab(8), Bb(10) appear;
  // the major-only E natural(4), A natural(9), B natural(11) must NOT.
  assert.ok(!used.has(4) && !used.has(9) && !used.has(11), `used classes: ${[...used]}`);
  const cMinor = new Set(scaleForKey("C minor"));
  for (const cls of used) assert.ok(cMinor.has(cls), `class ${cls} outside C minor`);
  assert.ok(layer.realizationNotes.some((note) => note.includes("darkens")));
});

test("register anchor snaps to the key tonic", () => {
  const layer = composeArrangementLayer(instruction({ register: "low" }), evidence());
  // A minor in low register: tonic A ≈ MIDI 45 (A2), events near it.
  const lowest = Math.min(...layer.events.map((event) => event.midi));
  const highest = Math.max(...layer.events.map((event) => event.midi));
  assert.ok(lowest >= 45 - 1 && highest <= 45 + 24, `range ${lowest}-${highest} not anchored on A2=45`);
  const classes = new Set(layer.events.map((event) => ((event.midi % 12) + 12) % 12));
  assert.ok(classes.has(9), "tonic A must be present in the chord material");
});

test("deterministic: same seed ⇒ same composition", () => {
  const one = composeArrangementLayer(instruction(), evidence());
  const two = composeArrangementLayer(instruction(), evidence());
  assert.deepEqual(one.events, two.events);
  const other = composeArrangementLayer(instruction({ seed: 43 }), evidence());
  assert.notDeepEqual(one.events, other.events);
});

test("missing evidence is an honest error, never a guess", () => {
  assert.throws(() => composeArrangementLayer(instruction(), { ...evidence(), musicalKey: "?" }), /key/i);
  assert.throws(() => composeArrangementLayer(instruction(), { ...evidence(), beatGridMs: [] }), /beat grid/i);
  assert.throws(() => composeArrangementLayer(instruction(), { ...evidence(), sections: [] }), /section/i);
  assert.throws(
    () => composeArrangementLayer(instruction({ targetSections: [9] }), evidence()),
    /none match/i,
  );
});

test("instruction validation rejects malformed input strictly", () => {
  assert.notEqual(validateArrangementInstruction(instruction()), null);
  assert.equal(validateArrangementInstruction({ ...instruction(), mood: "happy" }), null);
  assert.equal(validateArrangementInstruction({ ...instruction(), level: 2 }), null);
  assert.equal(validateArrangementInstruction({ ...instruction(), targetSections: [] }), null);
  assert.equal(validateArrangementInstruction({ ...instruction(), format: "v0" }), null);
});
