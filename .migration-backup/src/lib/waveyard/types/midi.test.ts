/**
 * MIDI conversion tests — the vocal/drum/harmony → MidiNoteEvent adapters
 * and their validation, previously untested.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MIDI_PPQ,
  drumEventsToMidiNotes,
  harmonyEventsToMidiNotes,
  millisecondsToMidiTicks,
  normaliseMidiNoteEvents,
  vocalFramesToMidiNotes,
} from "./midi";
import type { DrumEvent } from "./drum-analysis";
import type { HarmonyEvent } from "./harmony-analysis";
import type { VocalPitchFrame } from "./vocal-analysis";

function frame(overrides: Partial<VocalPitchFrame> = {}): VocalPitchFrame {
  return { timestampMs: 0, frequencyHz: 261.6, midiFloat: 60.0, nearestMidiNote: 60, confidence: 0.9, voiced: true, ...overrides };
}

function drum(overrides: Partial<DrumEvent> = {}): DrumEvent {
  return { timestampMs: 0, strength: 0.8, confidence: 0.9, rhythmicClass: "kick", nearestBeatIndex: null, beatOffsetMs: null, ...overrides };
}

function harmony(overrides: Partial<HarmonyEvent> = {}): HarmonyEvent {
  return { startMs: 0, endMs: 1000, root: "C", quality: "major", confidence: 0.9, ...overrides };
}

test("millisecondsToMidiTicks: one quarter at 120 bpm is exactly one PPQ", () => {
  assert.equal(millisecondsToMidiTicks(500, 120, 480), 480);
  assert.equal(millisecondsToMidiTicks(500, 120), 480);
  assert.equal(millisecondsToMidiTicks(250, 120), 240);
  // Guarded: bad bpm/ms/ppq reject with null, never a wrong number.
  assert.equal(millisecondsToMidiTicks(500, 10), null);
  assert.equal(millisecondsToMidiTicks(500, 400), null);
  assert.equal(millisecondsToMidiTicks(-1, 120), null);
  assert.equal(millisecondsToMidiTicks(Number.NaN, 120), null);
});

test("vocalFramesToMidiNotes segments stable voiced runs into notes", () => {
  const frames = [
    ...Array.from({ length: 10 }, (_, i) => frame({ timestampMs: i * 46, nearestMidiNote: 60 })),
    // unvoiced gap
    frame({ timestampMs: 10 * 46, voiced: false, nearestMidiNote: null, frequencyHz: null, midiFloat: null }),
    ...Array.from({ length: 10 }, (_, i) => frame({ timestampMs: 11 * 46 + i * 46, nearestMidiNote: 65 })),
  ];
  const notes = vocalFramesToMidiNotes(frames, { minimumDurationMs: 100, minimumConfidence: 0.6 });
  assert.equal(notes.length, 2, "two stable segments");
  assert.equal(notes[0].midiNote, 60);
  assert.equal(notes[1].midiNote, 65);
  assert.ok(notes[0].durationMs >= 100);
  assert.ok(notes[1].startMs > notes[0].startMs);
  // Velocity carries confidence.
  assert.ok(notes[0].velocity > 100, `velocity from confidence (${notes[0].velocity})`);
});

test("vocalFramesToMidiNotes splits on pitch jumps beyond the hysteresis", () => {
  const frames = [
    ...Array.from({ length: 8 }, (_, i) => frame({ timestampMs: i * 46, nearestMidiNote: 60 })),
    ...Array.from({ length: 8 }, (_, i) => frame({ timestampMs: (8 + i) * 46, nearestMidiNote: 67 })),
  ];
  const notes = vocalFramesToMidiNotes(frames, { maximumPitchJump: 1, minimumDurationMs: 100 });
  assert.equal(notes.length, 2, "a 7-semitone jump must split the segment");
});

test("vocalFramesToMidiNotes drops short segments and low confidence", () => {
  const short = [frame({ timestampMs: 0 }), frame({ timestampMs: 46 })];
  assert.equal(vocalFramesToMidiNotes(short, { minimumDurationMs: 500 }).length, 0);
  const quiet = Array.from({ length: 10 }, (_, i) => frame({ timestampMs: i * 46, confidence: 0.2 }));
  assert.equal(vocalFramesToMidiNotes(quiet, { minimumConfidence: 0.6 }).length, 0);
  // Hostile options reject with an empty result.
  assert.equal(vocalFramesToMidiNotes([frame()], { minimumDurationMs: -5 }).length, 0);
});

test("drumEventsToMidiNotes maps classes to GM percussion on channel 9", () => {
  const events = [
    drum({ timestampMs: 0, rhythmicClass: "kick", strength: 1 }),
    drum({ timestampMs: 250, rhythmicClass: "snare", strength: 0.5 }),
    drum({ timestampMs: 500, rhythmicClass: "hat", strength: 0.9, confidence: 0.3 }), // below confidence
    drum({ timestampMs: 750, rhythmicClass: "other", strength: 1 }), // unmapped class
    drum({ timestampMs: 1000, rhythmicClass: null, strength: 1 }), // no class
  ];
  const notes = drumEventsToMidiNotes(events, 0.6);
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.midiNote), [36, 38]);
  assert.ok(notes.every((n) => n.channel === 9), "GM percussion channel");
  assert.equal(notes[0].velocity, 127, "velocity from strength");
  assert.equal(notes[1].velocity, 64, "0.5 strength → 64");
});

test("harmonyEventsToMidiNotes expands chords from the root", () => {
  const notes = harmonyEventsToMidiNotes([harmony({ root: "C", quality: "major" })], 0.6);
  assert.deepEqual(notes.map((n) => n.midiNote), [48, 52, 55], "C major from C3");
  const minor = harmonyEventsToMidiNotes([harmony({ root: "A", quality: "minor" })], 0.6);
  assert.deepEqual(minor.map((n) => n.midiNote), [57, 60, 64], "A minor from A3");
  // Unknown roots/qualities and low confidence never emit.
  assert.equal(harmonyEventsToMidiNotes([harmony({ root: null })]).length, 0);
  assert.equal(harmonyEventsToMidiNotes([harmony({ quality: "unknown" })]).length, 0);
  assert.equal(harmonyEventsToMidiNotes([harmony({ confidence: 0.1 })]).length, 0);
});

test("normaliseMidiNoteEvents validates strictly and sorts chronologically", () => {
  const valid = normaliseMidiNoteEvents([
    { startMs: 500, durationMs: 100, midiNote: 60, velocity: 90, channel: 0 },
    { startMs: 0, durationMs: 400, midiNote: 62, velocity: 80, channel: 0 },
  ]);
  assert.ok(valid);
  assert.deepEqual(valid.map((n) => n.startMs), [0, 500], "sorted by start");

  const bad = [
    { startMs: -1, durationMs: 100, midiNote: 60, velocity: 90, channel: 0 },
    { startMs: 0, durationMs: 0, midiNote: 60, velocity: 90, channel: 0 },
    { startMs: 0, durationMs: 100, midiNote: 128, velocity: 90, channel: 0 },
    { startMs: 0, durationMs: 100, midiNote: 60, velocity: 0, channel: 0 },
    { startMs: 0, durationMs: 100, midiNote: 60, velocity: 90, channel: 16 },
    { startMs: 0.5, durationMs: 100, midiNote: 60, velocity: 90, channel: 0 },
  ];
  for (const candidate of bad) {
    assert.equal(normaliseMidiNoteEvents([candidate]), null, `must reject ${JSON.stringify(candidate)}`);
  }
  assert.equal(normaliseMidiNoteEvents("nope"), null);
  assert.equal(normaliseMidiNoteEvents(null), null);
  assert.equal(MIDI_PPQ, 480);
});
