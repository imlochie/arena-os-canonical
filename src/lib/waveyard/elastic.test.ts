/**
 * Elastic audio tests — WSOLA time stretch, sinc resampling, pitch shift.
 * Real processing, no mocks: length contracts, frequency invariance under
 * stretch, pitch ratios, and determinism.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { pitchShift, resampleBuffer, timeStretch } from "./elastic";
import type { StereoBuffer } from "./mixer/dsp";

const FS = 48000;

function sine(seconds: number, freqHz: number, amplitude: number): StereoBuffer {
  const frames = Math.round(seconds * FS);
  const buffer = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const v = Math.sin((2 * Math.PI * freqHz * i) / FS) * amplitude;
    buffer[i * 2] = v;
    buffer[i * 2 + 1] = v;
  }
  return buffer;
}

/** Dominant frequency via positive-going zero crossings over the middle. */
function dominantHz(buffer: StereoBuffer, sampleRate: number, fromFrac = 0.25, toFrac = 0.75): number {
  const frames = buffer.length / 2;
  const from = Math.floor(frames * fromFrac);
  const to = Math.floor(frames * toFrac);
  let crossings = 0;
  let prev = buffer[from * 2];
  for (let i = from + 1; i < to; i += 1) {
    const v = buffer[i * 2];
    if (prev <= 0 && v > 0) crossings += 1;
    prev = v;
  }
  const seconds = (to - from) / sampleRate;
  return crossings / seconds;
}

test("timeStretch produces exactly round(frames × ratio) frames", () => {
  const input = sine(1, 440, 0.3);
  for (const ratio of [0.5, 1.5, 2]) {
    const out = timeStretch(input, ratio, FS);
    assert.equal(out.length, Math.round((input.length / 2) * ratio) * 2, `ratio ${ratio}`);
  }
});

test("timeStretch ratio 1 is an identity copy", () => {
  const input = sine(0.5, 440, 0.3);
  const out = timeStretch(input, 1, FS);
  let identityDiff = 0;
  for (let i = 0; i < input.length; i += 1) {
    identityDiff = Math.max(identityDiff, Math.abs(out[i] - input[i]));
  }
  assert.ok(identityDiff === 0, `ratio 1 must copy exactly (${identityDiff})`);
});

test("timeStretch clamps hostile ratios instead of failing", () => {
  const input = sine(0.5, 440, 0.3);
  const tooBig = timeStretch(input, 1e9, FS);
  assert.equal(tooBig.length, (input.length / 2) * 10 * 2, "clamped to 10×");
  const nan = timeStretch(input, Number.NaN, FS);
  let nanDiff = 0;
  for (let i = 0; i < input.length; i += 1) {
    nanDiff = Math.max(nanDiff, Math.abs(nan[i] - input[i]));
  }
  assert.ok(nanDiff === 0, `NaN ratio must be identity (${nanDiff})`);
});

test("timeStretch preserves pitch: a 440 Hz sine stays 440 Hz", () => {
  const input = sine(2, 440, 0.3);
  for (const ratio of [0.6, 1.4]) {
    const out = timeStretch(input, ratio, FS);
    const hz = dominantHz(out, FS);
    assert.ok(Math.abs(hz - 440) < 8, `ratio ${ratio}: measured ${hz} Hz`);
  }
});

test("timeStretch keeps a tone burst localised (transient preservation)", () => {
  // A 30 ms 1 kHz burst at 250 ms — a real transient with waveform to match,
  // unlike a single-sample impulse (degenerate for waveform similarity).
  const input = new Float32Array(FS); // 0.5 s
  const start = Math.round(0.25 * FS);
  const end = start + Math.round(0.03 * FS);
  for (let i = start; i < end; i += 1) {
    const v = Math.sin((2 * Math.PI * 1000 * i) / FS) * 0.5;
    input[i * 2] = v;
    input[i * 2 + 1] = v;
  }
  const out = timeStretch(input, 1.5, FS);
  const frames = out.length / 2;
  let inside = 0;
  let total = 0;
  const centre = Math.round(0.25 * FS * 1.5);
  const window = Math.round(0.08 * FS); // generous: burst + WSOLA frame smear
  for (let i = 0; i < frames; i += 1) {
    const e = out[i * 2] * out[i * 2] + out[i * 2 + 1] * out[i * 2 + 1];
    total += e;
    if (i >= centre - window && i <= centre + window) inside += e;
  }
  assert.ok(total > 0);
  assert.ok(inside / total > 0.5, `burst energy must stay localised (${(inside / total).toFixed(2)} inside)`);
});

test("timeStretch keeps identical channels identical (shared segment choices)", () => {
  const input = sine(1, 440, 0.3); // L === R
  const out = timeStretch(input, 1.7, FS);
  for (let i = 0; i < out.length / 2; i += 1) {
    assert.ok(Math.abs(out[i * 2] - out[i * 2 + 1]) < 1e-9, `frame ${i}`);
  }
});

test("resampleBuffer changes length by the rate ratio and keeps the tone", () => {
  const input = sine(1, 1000, 0.3);
  const up = resampleBuffer(input, 48000, 96000);
  assert.equal(up.length, input.length * 2);
  const hz = dominantHz(up, 96000);
  assert.ok(Math.abs(hz - 1000) < 15, `resampled tone ${hz} Hz`);
  const down = resampleBuffer(up, 96000, 48000);
  assert.equal(down.length, input.length);
});

test("resampleBuffer anti-aliases: 15 kHz at 48k decimated to 8k loses the tone", () => {
  const input = sine(1, 15000, 0.3);
  const out = resampleBuffer(input, 48000, 8000);
  // 15 kHz is above the 4 kHz target Nyquist; it must not alias back strongly.
  let rms = 0;
  for (let i = Math.floor(out.length * 0.25); i < Math.floor(out.length * 0.75); i += 1) {
    rms += out[i] * out[i];
  }
  rms = Math.sqrt(rms / (out.length / 2));
  assert.ok(rms < 0.02, `aliased energy must be tiny (rms=${rms})`);
});

test("pitchShift preserves length and shifts a sine by the exact ratio", () => {
  const input = sine(1.5, 440, 0.3);
  const up = pitchShift(input, 12, FS);
  assert.equal(up.length, input.length, "length preserved");
  const hzUp = dominantHz(up, FS);
  assert.ok(Math.abs(hzUp - 880) < 12, `octave up measured ${hzUp} Hz`);
  const down = pitchShift(input, -12, FS);
  const hzDown = dominantHz(down, FS);
  assert.ok(Math.abs(hzDown - 220) < 8, `octave down measured ${hzDown} Hz`);
});

test("pitchShift of 0 semitones is a copy; extreme shifts stay finite", () => {
  const input = sine(0.5, 440, 0.3);
  const zero = pitchShift(input, 0, FS);
  let zeroDiff = 0;
  for (let i = 0; i < input.length; i += 1) {
    zeroDiff = Math.max(zeroDiff, Math.abs(zero[i] - input[i]));
  }
  assert.ok(zeroDiff === 0, `0 semitones must copy exactly (${zeroDiff})`);
  for (const st of [-48, 48, Number.NaN]) {
    const out = pitchShift(input, st, FS);
    for (let i = 0; i < out.length; i += 1) {
      assert.ok(Number.isFinite(out[i]), `st=${st} sample ${i}`);
    }
  }
});

test("elastic processing is deterministic", () => {
  const input = sine(1, 440, 0.3);
  const a = timeStretch(input, 1.3, FS);
  const b = timeStretch(input, 1.3, FS);
  let detDiff = 0;
  for (let i = 0; i < a.length; i += 1) detDiff = Math.max(detDiff, Math.abs(a[i] - b[i]));
  assert.ok(detDiff === 0, `renders must be identical (maxDiff=${detDiff})`);
});
