/**
 * Synth tests — real renders, real WAV bytes, no mocks.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeWav16,
  encodeWav16,
  midiToHz,
  renderNotes,
  renderNotesToWav,
  type NoteEvent,
} from "./synth";
import type { StereoBuffer } from "./dsp";
import { samplePeak } from "./meters";

const FS = 44100;

function gainToDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}

test("midiToHz is concert pitch", () => {
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9);
  assert.ok(Math.abs(midiToHz(60) - 261.6256) < 0.001);
  assert.ok(Math.abs(midiToHz(57) - 220) < 1e-9); // A3
});

test("renderNotes produces real audio where the notes are, silence where they are not", () => {
  const events: NoteEvent[] = [
    { startMs: 500, durationMs: 400, midi: 60, velocity: 0.8 },
  ];
  const buffer = renderNotes(events, "strings", FS, 2);
  assert.equal(buffer.length, 2 * FS * 2);
  const beforePeak = peakBetween(buffer, 0, 0.4);
  const duringPeak = peakBetween(buffer, 0.55, 0.85);
  const afterPeak = peakBetween(buffer, 1.2, 2.0);
  assert.equal(beforePeak, 0, "must be silent before the note");
  assert.ok(duringPeak > 0.01, `note must render (peak ${gainToDb(duringPeak)} dB)`);
  assert.equal(afterPeak, 0, "must be silent after the release");
});

test("different instruments render measurably differently", () => {
  const events: NoteEvent[] = [{ startMs: 0, durationMs: 1000, midi: 55, velocity: 0.8 }];
  const strings = renderNotes(events, "strings", FS, 1.2);
  const pluck = renderNotes(events, "pluck", FS, 1.2);
  // Strings attack slowly (0.12 s), pluck is near-instant: compare RMS of
  // the first 30 ms.
  const stringsAttack = rmsBetween(strings, 0, 0.03);
  const pluckAttack = rmsBetween(pluck, 0, 0.03);
  assert.ok(pluckAttack > stringsAttack * 3, `pluck attack ${pluckAttack} vs strings ${stringsAttack}`);
});

test("velocity scales the render", () => {
  const loud = renderNotes([{ startMs: 0, durationMs: 500, midi: 60, velocity: 1 }], "pad", FS, 0.6);
  const soft = renderNotes([{ startMs: 0, durationMs: 500, midi: 60, velocity: 0.2 }], "pad", FS, 0.6);
  assert.ok(samplePeak(loud) > samplePeak(soft) * 2);
});

test("output is ceiling-protected (never digital overs)", () => {
  const events: NoteEvent[] = Array.from({ length: 12 }, (_, i) => ({
    startMs: i * 100,
    durationMs: 900,
    midi: 48 + i,
    velocity: 1,
  }));
  const buffer = renderNotes(events, "pad", FS, 2.5, 1.0);
  assert.ok(samplePeak(buffer) <= Math.pow(10, -3 / 20) + 1e-6);
});

test("WAV encode/decode round-trips sample data", () => {
  const events: NoteEvent[] = [{ startMs: 100, durationMs: 300, midi: 64, velocity: 0.7 }];
  const buffer = renderNotes(events, "pluck", FS, 0.6);
  const wav = encodeWav16(buffer, FS);
  assert.equal(wav.length, 44 + buffer.length * 2);
  const decoded = decodeWav16(wav);
  assert.notEqual(decoded, null);
  assert.equal(decoded!.sampleRate, FS);
  assert.equal(decoded!.channels, 2);
  assert.equal(decoded!.frames, buffer.length >> 1);
  // 16-bit quantization error bound: 1/32768
  for (let i = 0; i < 8; i++)
    assert.ok(Math.abs(decoded!.samples[i] - buffer[i]) < 1 / 32000);
  // Reject junk honestly.
  assert.equal(decodeWav16(new Uint8Array(10)), null);
});

test("renderNotesToWav produces a playable WAV body", () => {
  const wav = renderNotesToWav([{ startMs: 0, durationMs: 200, midi: 60, velocity: 0.5 }], "sub-bass", FS, 0.4);
  const decoded = decodeWav16(wav);
  assert.notEqual(decoded, null);
  const peak = samplePeak(decoded!.samples as StereoBuffer);
  assert.ok(peak > 0.01, "sub-bass note must actually render");
});

function peakBetween(buffer: StereoBuffer, fromSec: number, toSec: number): number {
  let peak = 0;
  const start = Math.floor(fromSec * FS) * 2;
  const end = Math.floor(toSec * FS) * 2;
  for (let i = start; i < end && i < buffer.length; i++) peak = Math.max(peak, Math.abs(buffer[i]));
  return peak;
}

function rmsBetween(buffer: StereoBuffer, fromSec: number, toSec: number): number {
  let sum = 0;
  let count = 0;
  const start = Math.floor(fromSec * FS) * 2;
  const end = Math.floor(toSec * FS) * 2;
  for (let i = start; i < end && i < buffer.length; i++) {
    sum += buffer[i] * buffer[i];
    count += 1;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}
