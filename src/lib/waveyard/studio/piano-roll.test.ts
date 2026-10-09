/**
 * Piano roll model tests — every editor behavior proven as a pure function:
 * snap grid math, hit testing, move/resize clamping at the edges, duplicate
 * and quantize semantics, overlap normalization, strict validation, and the
 * velocity conversions for the synth renderer + SMF interchange.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { PianoNote } from "./piano-roll";

import {
  addNote,
  clampMidi,
  clampVelocity,
  deleteNotes,
  duplicateNotes,
  fitPitchRange,
  fromSynthEvents,
  gridHeight,
  hitTest,
  isBlackKey,
  midiToNoteName,
  midiToY,
  moveNotes,
  normalizeOverlaps,
  quantizeNotes,
  resizeNote,
  selectionBounds,
  snapMs,
  snapStepMs,
  toMidiNoteEvents,
  toSynthEvents,
  transposeNotes,
  validatePianoNotes,
  yToMidi,
} from "./piano-roll";

const GEOMETRY = { pixelsPerSecond: 100, rowHeight: 12, midiLow: 48, midiHigh: 84 };
const ids = (notes: readonly PianoNote[]) => new Set(notes.map((note) => note.id));
const byId = (notes: readonly PianoNote[], id: string) => notes.find((note) => note.id === id);

test("snap grid: bar/beat/subdivision steps derive from real tempo; off is null", () => {
  assert.equal(snapStepMs("off", 120), null);
  assert.equal(snapStepMs("beat", 120), 500);
  assert.equal(snapStepMs("bar", 120, 4), 2000);
  assert.equal(snapStepMs("1/4", 120), 125);
  assert.equal(snapStepMs("1/16", 120), 31.25);
  assert.equal(snapStepMs("beat", 90), 2000 / 3);
  assert.equal(snapStepMs("beat", 10), null, "tempo outside 20..300 has no grid");
  assert.equal(snapMs(1234, 500), 1000, "nearest grid line, not ceiling");
  assert.equal(snapMs(1300, 500), 1500, "rounds up across the halfway point");
  assert.equal(snapMs(249, 125), 250);
  assert.equal(snapMs(-100, 500), 0, "never negative");
  assert.equal(snapMs(249, null), 249, "off passes through");
});

test("pitch helpers: names, black keys, clamping", () => {
  assert.equal(midiToNoteName(60), "C4");
  assert.equal(midiToNoteName(69), "A4");
  assert.equal(midiToNoteName(21), "A0");
  assert.equal(midiToNoteName(108), "C8");
  assert.equal(isBlackKey(61), true);
  assert.equal(isBlackKey(60), false);
  assert.equal(clampMidi(-5), 0);
  assert.equal(clampMidi(200), 127);
  assert.equal(clampVelocity(0), 1);
  assert.equal(clampVelocity(999), 127);
});

test("geometry: y↔midi inverses; pitch fit bounds include every note", () => {
  for (let midi = GEOMETRY.midiLow; midi <= GEOMETRY.midiHigh; midi += 1) {
    assert.equal(yToMidi(midiToY(midi, GEOMETRY) + 1, GEOMETRY), midi, `row ${midi}`);
  }
  assert.equal(yToMidi(0, GEOMETRY), GEOMETRY.midiHigh, "top row is the highest pitch");
  assert.equal(gridHeight(GEOMETRY), 37 * 12);
  const notes = [
    { id: "a", startMs: 0, durationMs: 100, midi: 55, velocity: 100 },
    { id: "b", startMs: 0, durationMs: 100, midi: 76, velocity: 100 },
  ];
  const fit = fitPitchRange(notes, 4);
  assert.equal(fit.midiLow, 51);
  assert.equal(fit.midiHigh, 80);
  const empty = fitPitchRange([], 4);
  assert.ok(empty.midiLow < 60 && empty.midiHigh > 60, "empty roll centers around middle C");
});

test("hitTest: body vs the resize zone at the right edge; topmost note wins", () => {
  const overlapped: PianoNote[] = [
    { id: "lower", startMs: 0, durationMs: 1000, midi: 60, velocity: 100 }, // x 0..100
    { id: "upper", startMs: 500, durationMs: 1000, midi: 60, velocity: 100 }, // x 50..150
  ];
  const at = (notes: PianoNote[], ms: number, midi: number) => hitTest(notes, { ms, y: midiToY(midi, GEOMETRY) + 1 }, GEOMETRY);
  assert.deepEqual(at(overlapped, 60, 60), { kind: "body", noteId: "lower" });
  assert.deepEqual(at(overlapped, 600, 60), { kind: "body", noteId: "upper" }, "later note wins the overlap");
  assert.deepEqual(at(overlapped, 1495, 60), { kind: "resize", noteId: "upper" });
  assert.equal(at(overlapped, 300, 61), null, "different pitch row");
  // Without the overlap, lower's own end is the resize handle.
  const solo: PianoNote[] = [{ id: "lower", startMs: 0, durationMs: 1000, midi: 60, velocity: 100 }];
  assert.deepEqual(at(solo, 995, 60), { kind: "resize", noteId: "lower" }, "within 8px of the end = resize");
  assert.deepEqual(at(solo, 900, 60), { kind: "body", noteId: "lower" }, "10px from the end is still the body at this zoom");
});

test("addNote snaps the start, clamps pitch/velocity, never mutates the input", () => {
  const before: PianoNote[] = [];
  const added = addNote(before, { startMs: 1300, durationMs: 400, midi: 200, velocity: 400 }, 500);
  assert.equal(added.length, 1);
  assert.equal(added[0].startMs, 1500);
  assert.equal(added[0].midi, 127);
  assert.equal(added[0].velocity, 127);
  assert.deepEqual(before, [], "pure — input untouched");
});

test("moveNotes: snap follows the primary note; the block clamps at timeline and pitch edges", () => {
  const notes: PianoNote[] = [
    { id: "a", startMs: 500, durationMs: 500, midi: 60, velocity: 100 },
    { id: "b", startMs: 750, durationMs: 250, midi: 64, velocity: 100 },
    { id: "c", startMs: 4000, durationMs: 250, midi: 70, velocity: 100 },
  ];
  const selection = new Set(["a", "b"]);
  // Unsnapped move of 130ms snaps the primary (500→750 at 250-grid → +250).
  const moved = moveNotes(notes, selection, 130, 2, 250);
  assert.equal(byId(moved, "a")!.startMs, 750);
  assert.equal(byId(moved, "a")!.midi, 62);
  assert.equal(byId(moved, "b")!.startMs, 1000, "same snapped delta");
  assert.equal(byId(moved, "b")!.midi, 66);
  assert.equal(byId(moved, "c")!.startMs, 4000, "unselected untouched");
  // Clamp at t=0: -750ms on the primary moves the block exactly to 0.
  const clamped = moveNotes(notes, selection, -750, 0, null);
  assert.equal(byId(clamped, "a")!.startMs, 0);
  assert.equal(byId(clamped, "b")!.startMs, 250);
  // Clamp at pitch ceiling: +70 semitones clamps to what fits (top note → 127).
  const ceiling = moveNotes(notes, selection, 0, 70, null);
  assert.equal(byId(ceiling, "b")!.midi, 127);
  assert.equal(byId(ceiling, "a")!.midi, 123);
});

test("resizeNote: end snaps, start stays fixed, minimum duration enforced", () => {
  const notes: PianoNote[] = [{ id: "a", startMs: 500, durationMs: 500, midi: 60, velocity: 100 }];
  const grown = resizeNote(notes, "a", 1800, 250);
  assert.equal(byId(grown, "a")!.durationMs, 1250); // end snapped to 1750
  const shrunk = resizeNote(notes, "a", 505, 250);
  assert.equal(byId(shrunk, "a")!.durationMs, 10, "minimum duration");
  const before = resizeNote(notes, "a", 1000, 250);
  assert.equal(byId(before, "a")!.startMs, 500, "start never moves");
});

test("delete, transpose (out-of-range stays), quantize, velocity", () => {
  const notes: PianoNote[] = [
    { id: "a", startMs: 510, durationMs: 500, midi: 60, velocity: 100 },
    { id: "b", startMs: 260, durationMs: 250, midi: 125, velocity: 100 },
  ];
  const afterDelete = deleteNotes(notes, new Set(["a"]));
  assert.equal(afterDelete.length, 1);
  const transposed = transposeNotes(notes, ids(notes), 3);
  assert.equal(byId(transposed, "b")!.midi, 125, "out-of-range note stays put");
  const quantized = quantizeNotes(notes, new Set(["a"]), 250);
  assert.equal(byId(quantized, "a")!.startMs, 500);
  assert.equal(byId(quantized, "b")!.startMs, 260, "unselected notes keep their timing");
});

test("duplicateNotes shifts by the selection's own span; copies get fresh ids", () => {
  const notes: PianoNote[] = [
    { id: "a", startMs: 0, durationMs: 500, midi: 60, velocity: 100 },
    { id: "b", startMs: 250, durationMs: 250, midi: 64, velocity: 100 },
    { id: "outside", startMs: 9000, durationMs: 100, midi: 67, velocity: 100 },
  ];
  const { notes: duplicated, newIds } = duplicateNotes(notes, new Set(["a", "b"]), null);
  assert.equal(duplicated.length, 5);
  assert.equal(newIds.length, 2);
  const copyA = byId(duplicated, newIds[0])!;
  assert.equal(copyA.startMs, 500, "shifted by span (max end 500 − min start 0)");
  const copyB = byId(duplicated, newIds[1])!;
  assert.equal(copyB.startMs, 750);
  assert.equal(copyA.velocity, 100, "velocity carried");
  assert.equal(byId(duplicated, "outside")!.startMs, 9000, "outside selection untouched");
});

test("normalizeOverlaps merges same-pitch overlaps into spanning notes, keeps others", () => {
  const notes: PianoNote[] = [
    { id: "a", startMs: 0, durationMs: 500, midi: 60, velocity: 80 },
    { id: "b", startMs: 300, durationMs: 500, midi: 60, velocity: 100 }, // overlaps a
    { id: "c", startMs: 1000, durationMs: 200, midi: 60, velocity: 64 }, // separate
    { id: "d", startMs: 100, durationMs: 100, midi: 61, velocity: 64 }, // different pitch
  ];
  const normalized = normalizeOverlaps(notes);
  const pitch60 = normalized.filter((note) => note.midi === 60);
  assert.equal(pitch60.length, 2);
  assert.deepEqual(pitch60[0], { id: "a", startMs: 0, durationMs: 800, midi: 60, velocity: 100 });
  assert.equal(pitch60[1].startMs, 1000);
  assert.equal(normalized.filter((note) => note.midi === 61).length, 1);
});

test("validatePianoNotes accepts real notes and rejects every malformed shape", () => {
  const good = [
    { id: "a", startMs: 0, durationMs: 500, midi: 60, velocity: 127 },
    { id: "b", startMs: 100, durationMs: 10, midi: 0, velocity: 1 },
  ];
  assert.equal(validatePianoNotes(good)?.length, 2);
  assert.equal(validatePianoNotes(null), null);
  assert.equal(validatePianoNotes([{ id: "x", startMs: -1, durationMs: 100, midi: 60, velocity: 100 }]), null);
  assert.equal(validatePianoNotes([{ id: "x", startMs: 0.5, durationMs: 100, midi: 60, velocity: 100 }]), null);
  assert.equal(validatePianoNotes([{ id: "x", startMs: 0, durationMs: 9, midi: 60, velocity: 100 }]), null);
  assert.equal(validatePianoNotes([{ id: "x", startMs: 0, durationMs: 100, midi: 128, velocity: 100 }]), null);
  assert.equal(validatePianoNotes([{ id: "x", startMs: 0, durationMs: 100, midi: 60, velocity: 0 }]), null);
  assert.equal(validatePianoNotes([{ id: "", startMs: 0, durationMs: 100, midi: 60, velocity: 100 }]), null);
  assert.equal(validatePianoNotes([{ startMs: 0, durationMs: 100, midi: 60, velocity: 100 }]), null); // no id
  assert.equal(validatePianoNotes(new Array(100_001).fill(good[0])), null);
});

test("an empty roll is a valid edit (delete-everything is legal)", () => {
  assert.deepEqual(validatePianoNotes([]), []);
});

test("synth + SMF interchange: velocity domains convert losslessly at the boundaries", () => {
  const notes: PianoNote[] = [
    { id: "a", startMs: 0, durationMs: 500, midi: 60, velocity: 127 },
    { id: "b", startMs: 100, durationMs: 250, midi: 43, velocity: 1 },
  ];
  const synth = toSynthEvents(notes);
  assert.equal(synth[0].velocity, 1);
  assert.equal(synth[1].velocity, 1 / 127);
  const back = fromSynthEvents(synth);
  assert.equal(back[0].velocity, 127);
  assert.equal(back[1].velocity, 1);
  assert.ok(back.every((note) => typeof note.id === "string" && note.id.length > 0), "ids assigned");
  const smf = toMidiNoteEvents(notes, 3);
  assert.deepEqual(smf[0], { startMs: 0, durationMs: 500, midiNote: 60, velocity: 127, channel: 3 });
  // Out-of-domain synth events clamp honestly on the way in.
  const clamped = fromSynthEvents([{ startMs: 0, durationMs: 0, midi: 999, velocity: 2 }]);
  assert.equal(clamped[0].midi, 127);
  assert.equal(clamped[0].durationMs, 10);
  assert.equal(clamped[0].velocity, 127);
});

test("selectionBounds spans the selection only", () => {
  const notes: PianoNote[] = [
    { id: "a", startMs: 100, durationMs: 400, midi: 55, velocity: 100 },
    { id: "b", startMs: 900, durationMs: 100, midi: 70, velocity: 100 },
    { id: "c", startMs: 5000, durationMs: 100, midi: 80, velocity: 100 },
  ];
  const bounds = selectionBounds(notes, new Set(["a", "b"]));
  assert.deepEqual(bounds, { startMs: 100, endMs: 1000, midiLow: 55, midiHigh: 70 });
  assert.equal(selectionBounds(notes, new Set()), null);
});
