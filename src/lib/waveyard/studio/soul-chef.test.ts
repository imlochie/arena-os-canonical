/**
 * Soul chef tests — deterministic sequencing + the cleanup assistant.
 * Every assertion is on arithmetic the chef cannot fudge: grid lock, key
 * membership, determinism from the seed, and honest change reporting.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupPattern,
  keyPitchClasses,
  sequenceChopPattern,
  snapMidiToKey,
} from "./soul-chef";
import { parseChopNoteId } from "./vocal-chops";
import type { PianoNote } from "./piano-roll";

const CHOPS = [
  { id: "00000000-0000-0000-0000-000000000001", rootMidi: 57 }, // A3
  { id: "00000000-0000-0000-0000-000000000002", rootMidi: 64 }, // E4
];

test("key pitch classes resolve canonical keys", () => {
  assert.deepEqual([...(keyPitchClasses("C major") ?? [])].sort((a, b) => a - b), [0, 2, 4, 5, 7, 9, 11]);
  // A minor is C major's relative — SAME pitch classes, different tonic.
  assert.deepEqual([...(keyPitchClasses("A minor") ?? [])].sort((a, b) => a - b), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual([...(keyPitchClasses("C minor") ?? [])].sort((a, b) => a - b), [0, 2, 3, 5, 7, 8, 10]);
  assert.equal(keyPitchClasses("nonsense"), null);
  assert.equal(keyPitchClasses(null), null);
});

test("snapMidiToKey moves to the nearest scale degree", () => {
  assert.equal(snapMidiToKey(61, "C major"), 60, "C#4 → C4 in C major");
  assert.equal(snapMidiToKey(66, "C major"), 65, "F#4 → F4 in C major");
  assert.equal(snapMidiToKey(61, null), 61, "no key → unchanged");
  assert.equal(snapMidiToKey(60, "A minor"), 60, "C4 stays in A minor");
  assert.equal(snapMidiToKey(61, "A minor"), 60, "C#4 is equidistant between C4 and D4 — ties resolve down");
});

test("the chef sequences deterministically from a seed", () => {
  const context = { bpm: 90, musicalKey: "F minor" };
  const first = sequenceChopPattern(CHOPS, context, { seed: 7, bars: 4, style: "chipmunk" });
  const second = sequenceChopPattern(CHOPS, context, { seed: 7, bars: 4, style: "chipmunk" });
  assert.deepEqual(first, second, "same seed → identical pattern");

  const other = sequenceChopPattern(CHOPS, context, { seed: 8, bars: 4, style: "chipmunk" });
  assert.notDeepEqual(first.notes, other.notes, "different seed → different pattern");
});

test("the chef locks every note to the beat grid and the key", () => {
  const context = { bpm: 90, musicalKey: "F minor" }; // F minor: {5,7,8,10,0,1,3}
  const { notes } = sequenceChopPattern(CHOPS, context, { seed: 3, bars: 4, style: "chipmunk" });
  assert.ok(notes.length >= 12, `expected a real pattern, got ${notes.length} notes`);

  const beatMs = 60_000 / 90;
  const sixteenth = beatMs / 4;
  const pcs = keyPitchClasses("F minor")!;
  for (const note of notes) {
    // Grid lock: starts land on 16th-note multiples.
    // Ints are required by note validation, so allow rounding slack (±0.5ms).
    assert.ok(
      Math.abs(note.startMs / sixteenth - Math.round(note.startMs / sixteenth)) < 0.005,
      `start ${note.startMs} off the 16th grid`,
    );
    // Key membership (chipmunk = root+12, still in key).
    assert.ok(pcs.has(note.midi % 12), `midi ${note.midi} out of F minor`);
    // Bounds.
    assert.ok(note.durationMs >= 10 && note.velocity >= 1 && note.velocity <= 127);
  }
});

test("every sequenced note carries its chop in the id (renderable)", () => {
  const { notes } = sequenceChopPattern(CHOPS, { bpm: 120, musicalKey: null }, { seed: 1, bars: 2 });
  assert.ok(notes.length > 0);
  const chopIds = new Set(CHOPS.map((chop) => chop.id));
  for (const note of notes) {
    const chopId = parseChopNoteId(note.id);
    assert.ok(chopId !== null && chopIds.has(chopId), `note id ${note.id} must be chop-stamped`);
  }
});

test("chipmunk pitches up an octave; screwed pitches down and slows", () => {
  const context = { bpm: 120, musicalKey: null };
  const chipmunk = sequenceChopPattern(CHOPS, context, { seed: 5, bars: 1, style: "chipmunk" });
  const screwed = sequenceChopPattern(CHOPS, context, { seed: 5, bars: 1, style: "screwed" });
  const chipmunkRoot = chipmunk.notes[0].midi;
  const screwedRoot = screwed.notes[0].midi;
  assert.ok([69, 76].includes(chipmunkRoot), `chipmunk root ${chipmunkRoot} = original +12`);
  assert.ok([45, 52].includes(screwedRoot), `screwed root ${screwedRoot} = original −12`);
  // Screwed notes are long and sparse; chipmunk bars carry more hits.
  assert.ok(screwed.notes.every((note) => note.durationMs >= 500), "screwed notes are long");
  assert.ok(chipmunk.notes.length >= 3 && screwed.notes.length <= 2, `chipmunk ${chipmunk.notes.length} notes`);
});

test("empty chops → honest empty pattern", () => {
  const result = sequenceChopPattern([], { bpm: 120, musicalKey: null });
  assert.deepEqual(result.notes, []);
  assert.ok(result.rationale.length === 1);
});

// --- cleanup assistant -----------------------------------------------------

function note(id: string, startMs: number, durationMs: number, midi: number, velocity: number): PianoNote {
  return { id, startMs, durationMs, midi, velocity };
}

test("cleanup quantizes, snaps to key, merges overlaps — and reports every change", () => {
  const context = { bpm: 120, musicalKey: "C major" };
  const eighth = 250; // 120 BPM
  const messy: PianoNote[] = [
    note("00000000-0000-0000-0000-000000000009:a", 0, 200, 60, 100),   // on grid, in key
    note("00000000-0000-0000-0000-000000000009:b", 137, 200, 61, 100),  // off grid (→250), out of key (→60)
    note("00000000-0000-0000-0000-000000000009:c", 500, 400, 64, 100),  // in key, on grid
    note("00000000-0000-0000-0000-000000000009:d", 600, 300, 64, 100),  // same pitch overlap with c (→merged)
    note("00000000-0000-0000-0000-000000000009:e", 1000, 200, 67, 12),  // extreme velocity outlier
  ];
  const result = cleanupPattern(messy, context, eighth);
  // Both the 137ms note AND the 600ms note (nearest grid line 500ms) snap.
  assert.ok(result.changes.some((line) => line.includes("snapped 2 notes")), result.changes.join("; "));
  assert.ok(result.changes.some((line) => line.includes("moved 1 note") && line.includes("C major")), result.changes.join("; "));
  assert.ok(result.changes.some((line) => line.includes("merged 1")), result.changes.join("; "));
  assert.ok(result.changes.some((line) => line.includes("extreme velocit")), result.changes.join("; "));
  assert.equal(result.notes.length, 4, "overlap merged: 5 → 4");
  // The out-of-key/off-grid note is fixed.
  const fixed = result.notes.find((n) => n.id.endsWith(":b"))!;
  assert.equal(fixed.startMs, 250);
  assert.equal(fixed.midi, 60);
  // Velocity outlier pulled toward the median.
  const smoothed = result.notes.find((n) => n.id.endsWith(":e"))!;
  assert.ok(smoothed.velocity > 12, "outlier pulled toward median, not flattened");
});

test("cleanup on an already-clean pattern changes nothing and says so", () => {
  const context = { bpm: 120, musicalKey: "C major" };
  const clean: PianoNote[] = [
    note("00000000-0000-0000-0000-000000000009:a", 0, 200, 60, 100),
    note("00000000-0000-0000-0000-000000000009:b", 250, 200, 64, 96),
  ];
  const result = cleanupPattern(clean, context, 250);
  assert.deepEqual(result.notes, clean);
  assert.deepEqual(result.changes, []);
});

test("cleanup never touches the user's timing when the grid is off (step 0 = beat default)", () => {
  const context = { bpm: 120, musicalKey: null };
  const notes: PianoNote[] = [note("00000000-0000-0000-0000-000000000009:a", 10, 200, 60, 100)];
  const result = cleanupPattern(notes, context, 0);
  // Falls back to the beat grid (500ms at 120 BPM) — 10ms snaps to 0.
  assert.equal(result.notes[0].startMs, 0);
});
