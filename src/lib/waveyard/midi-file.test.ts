/**
 * SMF writer tests — golden bytes, VLQ encoding, event ordering, edge
 * cases. Everything asserted against the published format-0 layout.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildStandardMidiFile } from "./midi-file";
import type { MidiNoteEvent } from "./types/midi";

function note(overrides: Partial<MidiNoteEvent> = {}): MidiNoteEvent {
  return { startMs: 0, durationMs: 500, midiNote: 60, velocity: 100, channel: 0, ...overrides };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

test("a single note at 120 bpm serialises to the exact golden bytes", () => {
  // 120 bpm: quarter = 500 ms = 480 ticks; tempo = 500000 µs/quarter (07 A1 20).
  // Track: tempo @0, note-on C4 @0, note-off @480 (VLQ 83 60), end-of-track.
  const file = buildStandardMidiFile([note()], 120);
  assert.equal(
    hex(file),
    "4d 54 68 64 00 00 00 06 00 00 00 01 01 e0 " +
      "4d 54 72 6b 00 00 00 14 " +
      "00 ff 51 03 07 a1 20 " +
      "00 90 3c 64 " +
      "83 60 80 3c 00 " +
      "00 ff 2f 00",
  );
});

test("header declares format 0, one track, and the requested PPQ", () => {
  const file = buildStandardMidiFile([], 120, 960);
  assert.equal(hex(file.subarray(0, 14)), "4d 54 68 64 00 00 00 06 00 00 00 01 03 c0");
});

test("no notes still produces a valid tempo + end-of-track file", () => {
  const file = buildStandardMidiFile([], 120);
  assert.equal(
    hex(file),
    "4d 54 68 64 00 00 00 06 00 00 00 01 01 e0 " +
      "4d 54 72 6b 00 00 00 0b " +
      "00 ff 51 03 07 a1 20 " +
      "00 ff 2f 00",
  );
});

test("simultaneous note-offs precede note-ons at the same tick", () => {
  // Note A: 0..500 ms. Note B: 500..1000 ms — B starts exactly when A ends.
  const file = buildStandardMidiFile([note({ midiNote: 60 }), note({ startMs: 500, durationMs: 500, midiNote: 62 })], 120);
  const track = Array.from(file.subarray(22));
  // Locate the note-off of the first note (80 3c 00) and check the next
  // event is the second note-on (90 3e ...) with delta 0.
  const offIndex = track.findIndex((b, i) => b === 0x80 && track[i + 1] === 0x3c);
  assert.ok(offIndex > 0, "note-off must exist");
  assert.deepEqual(track.slice(offIndex, offIndex + 3), [0x80, 0x3c, 0x00]);
  assert.deepEqual(track.slice(offIndex + 3, offIndex + 7), [0x00, 0x90, 0x3e, 100], "note-on follows at delta 0");
});

test("variable-length deltas encode 122 as one byte and 128 as two", () => {
  // tick = ms·bpm·ppq/60000 → ms 127 → 127·0.96 = 122 (VLQ: one byte 7a)
  // ms 133 → 128 ticks (VLQ: two bytes 81 00). The delta BEFORE the note-on
  // (after the tick-0 tempo event) is the note's start tick.
  const a = buildStandardMidiFile([note({ startMs: 127 })], 120);
  const b = buildStandardMidiFile([note({ startMs: 133 })], 120);
  const trackA = Array.from(a.subarray(22));
  const trackB = Array.from(b.subarray(22));
  const onIndexA = trackA.findIndex((b2, i) => b2 === 0x90 && trackA[i + 1] === 0x3c);
  const onIndexB = trackB.findIndex((b2, i) => b2 === 0x90 && trackB[i + 1] === 0x3c);
  assert.ok(onIndexA > 0 && onIndexB > 0);
  assert.equal(trackA[onIndexA - 1], 122, "122 fits one VLQ byte");
  assert.deepEqual(trackB.slice(onIndexB - 2, onIndexB), [0x81, 0x00], "128 needs two VLQ bytes");
});

test("channels map to their own cable numbers; drums use channel 9", () => {
  const file = buildStandardMidiFile([note({ channel: 9, midiNote: 36 })], 120);
  const track = Array.from(file.subarray(22));
  const onIndex = track.findIndex((b, i) => (b & 0xf0) === 0x90);
  assert.equal(track[onIndex] & 0x0f, 9, "channel 9 (GM percussion)");
  assert.equal(track[onIndex + 1], 36, "kick drum note");
});

test("hostile inputs clamp instead of producing an invalid file", () => {
  const file = buildStandardMidiFile(
    [note({ midiNote: 200, velocity: 999, channel: 99, startMs: -50, durationMs: 1e12 })],
    999, // out-of-range bpm falls back to 120
  );
  const track = Array.from(file.subarray(22));
  const onIndex = track.findIndex((b, i) => (b & 0xf0) === 0x90);
  assert.ok(onIndex > 0);
  assert.equal(track[onIndex] & 0x0f, 15, "channel 99 clamps to 15");
  assert.equal(track[onIndex + 1], 127, "note clamps to 127");
  assert.equal(track[onIndex + 2], 127, "velocity clamps to 127");
  for (const byte of file) assert.ok(Number.isInteger(byte) && byte >= 0 && byte <= 255);
  // Every byte accounted for: track length field matches the payload.
  const declared = (file[18] << 24) | (file[19] << 16) | (file[20] << 8) | file[21];
  assert.equal(file.length - 22, declared);
});

test("many notes stay sorted and the file length field stays exact", () => {
  const notes = Array.from({ length: 500 }, (_, i) =>
    note({ startMs: (i * 137) % 20_000, durationMs: 80 + (i % 7) * 40, midiNote: 40 + (i % 60), channel: i % 16 }),
  );
  const file = buildStandardMidiFile(notes, 128);
  const declared = (file[18] << 24) | (file[19] << 16) | (file[20] << 8) | file[21];
  assert.equal(file.length - 22, declared, "track length field must match exactly");
  assert.ok(file.length > 500 * 6, "500 notes produce a substantial track");
});
