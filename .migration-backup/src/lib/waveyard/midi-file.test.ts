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

// ---------------------------------------------------------------------------
// Reader — the interchange promise: we open what FL Studio (and our own
// writer) export. Round-trips, hand-built FL-style bytes (running status,
// format 1), tempo changes, and the honest rejections.
// ---------------------------------------------------------------------------

import { parseStandardMidiFile, type ParsedMidiFile } from "./midi-file";

test("writer → reader round-trip at 125 bpm (1 tick = 1 ms) is exact", () => {
  const notes = [
    note({ startMs: 0, durationMs: 480, midiNote: 60, velocity: 100, channel: 0 }),
    note({ startMs: 480, durationMs: 240, midiNote: 64, velocity: 80, channel: 0 }),
    note({ startMs: 720, durationMs: 960, midiNote: 67, velocity: 127, channel: 3 }),
    note({ startMs: 5000, durationMs: 500, midiNote: 36, velocity: 45, channel: 9 }),
  ];
  const parsed = parseStandardMidiFile(buildStandardMidiFile(notes, 125));
  assert.ok(parsed !== null, "file must parse");
  assert.equal(parsed.ppq, 480);
  assert.deepEqual(parsed.tempoChanges, [{ tick: 0, bpm: 125 }]);
  assert.deepEqual(parsed.notes, notes);
  assert.equal(parsed.durationMs, 5500); // last note ends 5000 + 500
});

test("writer → reader round-trip at 120 bpm preserves notes within tick rounding", () => {
  const notes = [
    note({ startMs: 123, durationMs: 456, midiNote: 71, velocity: 64, channel: 2 }),
    note({ startMs: 4000, durationMs: 250, midiNote: 43, velocity: 33, channel: 0 }),
  ];
  const parsed = parseStandardMidiFile(buildStandardMidiFile(notes, 120));
  assert.ok(parsed !== null);
  assert.equal(parsed.notes.length, 2);
  for (let index = 0; index < notes.length; index += 1) {
    const original = notes[index];
    const restored: MidiNoteEvent = parsed.notes[index];
    assert.ok(Math.abs(restored.startMs - original.startMs) <= 2, `startMs within 2ms (${restored.startMs} vs ${original.startMs})`);
    assert.ok(Math.abs(restored.durationMs - original.durationMs) <= 2);
    assert.equal(restored.midiNote, original.midiNote);
    assert.equal(restored.velocity, original.velocity);
    assert.equal(restored.channel, original.channel);
  }
});

test("parses a hand-built format-0 file with RUNNING STATUS (how FL exports long tracks)", () => {
  // Hand-assembled: MThd format 0, 1 track, 480 ppq; tempo 120bpm.
  // Track: tempo@0; note-on C4 (90 3c 64) @0; then a RUNNING-STATUS second
  // note-on (data bytes only, no status byte) for D4 @480; note-offs with
  // explicit status; end-of-track.
  const track: number[] = [];
  const push = (...event: number[]) => track.push(...event);
  push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // tempo @0
  push(0x00, 0x90, 0x3c, 0x64); // C4 on @0
  push(0x83, 0x60, 0x3e, 0x50); // running status: D4 on @480 (delta 480 = 83 60)
  push(0x00, 0x80, 0x3c, 0x00); // C4 off @480
  push(0x83, 0x60, 0x80, 0x3e, 0x00); // D4 off @960 (delta 480)
  push(0x00, 0xff, 0x2f, 0x00); // end of track
  const file = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff, (track.length >>> 8) & 0xff, track.length & 0xff,
    ...track,
  ]);
  const parsed = parseStandardMidiFile(file);
  assert.ok(parsed !== null, "running-status file must parse");
  assert.deepEqual(parsed.notes, [
    { startMs: 0, durationMs: 500, midiNote: 60, velocity: 100, channel: 0 },
    { startMs: 500, durationMs: 500, midiNote: 62, velocity: 80, channel: 0 },
  ]);
});

test("parses a format-1 file: tempo in track 0, notes across two tracks merge", () => {
  // Track 0: tempo 100 bpm only. Track 1: C4 on @0, off @480.
  const mkTrack = (events: number[]) => new Uint8Array(events);
  const tempoTrack = mkTrack([0x00, 0xff, 0x51, 0x03, 0x09, 0x27, 0xc0, 0x00, 0xff, 0x2f, 0x00]); // 600,000 µs/q = 100 bpm
  const noteTrack = mkTrack([0x00, 0x90, 0x3c, 0x64, 0x83, 0x60, 0x80, 0x3c, 0x00, 0x00, 0xff, 0x2f, 0x00]);
  const chunks: number[] = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x02, 0x01, 0xe0,
  ];
  for (const track of [tempoTrack, noteTrack]) {
    chunks.push(0x4d, 0x54, 0x72, 0x6b, (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff, (track.length >>> 8) & 0xff, track.length & 0xff, ...track);
  }
  const parsed = parseStandardMidiFile(new Uint8Array(chunks));
  assert.ok(parsed !== null);
  assert.deepEqual(parsed.tempoChanges, [{ tick: 0, bpm: 100 }]);
  assert.equal(parsed.notes.length, 1);
  // 480 ticks at 100 bpm = 600 ms quarter.
  assert.equal(parsed.notes[0].startMs, 0);
  assert.equal(parsed.notes[0].durationMs, 600);
});

test("a mid-song tempo change integrates piecewise (both segments)", () => {
  // Tempo 120 for the first quarter, then 60: C4 on @0, off @720 ticks.
  // ms = 0..500 at 120bpm (tick 480), then 240 more ticks at 60bpm (500ms/quarter) = +250ms.
  const track: number[] = [];
  track.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // 120 bpm @0
  track.push(0x83, 0x60, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40); // 60 bpm @480
  track.push(0x83, 0x60, 0x90, 0x3c, 0x64); // on @960
  track.push(0x81, 0x70, 0x80, 0x3c, 0x00); // off @960+240=1200 (delta 240 = 81 70)
  track.push(0x00, 0xff, 0x2f, 0x00);
  const file = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff, (track.length >>> 8) & 0xff, track.length & 0xff,
    ...track,
  ]);
  const parsed = parseStandardMidiFile(file);
  assert.ok(parsed !== null);
  assert.deepEqual(parsed.tempoChanges.map((change) => change.bpm), [120, 60]);
  // note starts at tick 960: first 480 ticks at 120bpm = 500ms, then 480
  // ticks (a full quarter) at 60bpm = 1000ms → 1500ms total.
  assert.equal(parsed.notes[0].startMs, 1500);
  // duration 240 ticks at 60 bpm = half a quarter = 500ms
  assert.equal(parsed.notes[0].durationMs, 500);
});

test("an unclosed note-on closes at end-of-track; a retrigger closes its predecessor", () => {
  // On @0, retrigger @240, end-of-track @720: two notes, first 240 ticks, second 480.
  const track: number[] = [];
  track.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);
  track.push(0x00, 0x90, 0x3c, 0x64); // on @0
  track.push(0x81, 0x70, 0x90, 0x3c, 0x32); // retrigger @240 (delta 240 = 81 70)
  track.push(0x83, 0x60, 0xff, 0x2f, 0x00); // end @720 (delta 480)
  const file = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff, (track.length >>> 8) & 0xff, track.length & 0xff,
    ...track,
  ]);
  const parsed = parseStandardMidiFile(file);
  assert.ok(parsed !== null);
  assert.deepEqual(
    parsed.notes.map((note) => [note.startMs, note.durationMs, note.velocity]),
    [[0, 250, 100], [250, 500, 50]],
  );
});

test("structurally invalid files are rejected honestly (null, never a guess)", () => {
  const good = buildStandardMidiFile([note()], 120);
  const cases: Array<{ name: string; bytes: Uint8Array }> = [
    { name: "empty", bytes: new Uint8Array(0) },
    { name: "not an SMF", bytes: new Uint8Array([0x4d, 0x54, 0x68, 0x65, 0x00, 0x00, 0x00, 0x06, 0, 0, 0, 1, 0, 0]) },
    { name: "truncated header", bytes: good.slice(0, 10) },
    { name: "truncated track", bytes: good.slice(0, good.length - 4) },
    { name: "format 2", bytes: new Uint8Array([...good.slice(0, 8), 0x00, 0x02, ...good.slice(10)]) },
    { name: "SMPTE division", bytes: new Uint8Array([...good.slice(0, 12), 0xe7, 0x28, ...good.slice(14)]) },
    { name: "wrong chunk id", bytes: new Uint8Array([...good.slice(0, 14), 0x58, 0x58, 0x58, 0x58, ...good.slice(18)]) },
  ];
  for (const { name, bytes } of cases) {
    const parsed = parseStandardMidiFile(bytes);
    assert.equal(parsed, null, `${name} must be rejected`);
  }
});
