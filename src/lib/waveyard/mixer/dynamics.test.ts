/**
 * Dynamics processor tests — de-esser and maximizer. Real processing, no
 * mocks: spectral selectivity, range limits, brickwall ceiling invariants.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyDeEsser, applyMaximizer } from "./dynamics";
import { dbToGain, gainToDb } from "./gain";
import type { StereoBuffer } from "./dsp";

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

function rmsDb(buffer: StereoBuffer): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
  return gainToDb(Math.sqrt(sum / buffer.length));
}

test("de-esser leaves low-frequency content untouched", () => {
  const input = sine(1, 300, 0.25);
  const out = Float32Array.from(input);
  applyDeEsser(out, { freqHz: 6000, thresholdDb: -30, rangeDb: 10, sampleRate: FS });
  let maxDiff = 0;
  for (let i = 0; i < input.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(input[i] - out[i]));
  }
  assert.ok(maxDiff < 1e-3, `300 Hz must pass (maxDiff=${maxDiff})`);
});

test("de-esser attenuates loud sibilance within its range", () => {
  const input = sine(1, 7000, 0.5); // −6 dBFS of sibilance
  const out = Float32Array.from(input);
  applyDeEsser(out, { freqHz: 6000, thresholdDb: -40, rangeDb: 10, sampleRate: FS });
  const reduction = rmsDb(input) - rmsDb(out);
  assert.ok(reduction > 4, `sibilance must be dipped (reduction=${reduction} dB)`);
  assert.ok(reduction < 14, `dip must respect the range (reduction=${reduction} dB)`);
});

test("de-esser range 0 is a no-op", () => {
  const input = sine(1, 7000, 0.5);
  const out = Float32Array.from(input);
  applyDeEsser(out, { freqHz: 6000, thresholdDb: -60, rangeDb: 0, sampleRate: FS });
  let maxDiff = 0;
  for (let i = 0; i < input.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(input[i] - out[i]));
  }
  assert.ok(maxDiff < 1e-6, `range 0 must not touch the signal (maxDiff=${maxDiff})`);
});

test("de-esser ignores sibilance below the threshold", () => {
  const input = sine(1, 7000, 0.003); // −50 dBFS, well under −30
  const out = Float32Array.from(input);
  applyDeEsser(out, { freqHz: 6000, thresholdDb: -30, rangeDb: 20, sampleRate: FS });
  let maxDiff = 0;
  for (let i = 0; i < input.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(input[i] - out[i]));
  }
  assert.ok(maxDiff < 1e-4, `quiet sibilance must pass (maxDiff=${maxDiff})`);
});

test("maximizer never exceeds the ceiling on a hot signal", () => {
  const input = new Float32Array(FS); // 0.5 s of full-scale square-ish tone
  for (let i = 0; i < FS / 2; i += 1) {
    const v = Math.sin((2 * Math.PI * 220 * i) / FS) >= 0 ? 1 : -1;
    input[i * 2] = v;
    input[i * 2 + 1] = v;
  }
  const ceiling = dbToGain(-0.3);
  applyMaximizer(input, { thresholdDb: 0, ceilingDb: -0.3, releaseMs: 50, sampleRate: FS });
  let peak = 0;
  for (let i = 0; i < input.length; i += 1) {
    assert.ok(Number.isFinite(input[i]), `sample ${i} finite`);
    peak = Math.max(peak, Math.abs(input[i]));
  }
  assert.ok(peak <= ceiling + 1e-6, `brickwall violated: peak ${gainToDb(peak)} dBFS`);
});

test("maximizer drive raises quiet material toward the ceiling", () => {
  const input = sine(1, 440, dbToGain(-20)); // −20 dBFS
  applyMaximizer(input, { thresholdDb: -12, ceilingDb: -0.3, releaseMs: 50, sampleRate: FS });
  let peak = 0;
  for (let i = 0; i < input.length; i += 1) peak = Math.max(peak, Math.abs(input[i]));
  const peakDb = gainToDb(peak);
  // −20 + 12 dB of drive ≈ −8 dBFS peak; far from the ceiling, so barely limited.
  assert.ok(peakDb > -10 && peakDb < -6, `drive must raise the peak (got ${peakDb} dBFS)`);
  assert.ok(peakDb <= -0.3 + 0.01, `ceiling must hold (${peakDb} dBFS)`);
});

test("maximizer clamps driven peaks at exactly the ceiling", () => {
  const input = sine(1, 440, dbToGain(-2)); // −2 dBFS
  applyMaximizer(input, { thresholdDb: -12, ceilingDb: -3, releaseMs: 50, sampleRate: FS });
  let peak = 0;
  for (let i = 0; i < input.length; i += 1) peak = Math.max(peak, Math.abs(input[i]));
  const peakDb = gainToDb(peak);
  assert.ok(peakDb <= -3 + 0.05, `ceiling must hold (${peakDb} dBFS)`);
  assert.ok(peakDb > -3.5, `limited peaks must reach the ceiling (${peakDb} dBFS)`);
});

test("maximizer survives a single-sample impulse without NaN", () => {
  const input = new Float32Array(FS);
  input[1000] = 1;
  input[1001] = 1;
  applyMaximizer(input, { thresholdDb: 0, ceilingDb: -0.3, releaseMs: 5, sampleRate: FS });
  for (let i = 0; i < input.length; i += 1) {
    assert.ok(Number.isFinite(input[i]), `sample ${i} finite`);
  }
});

test("maximizer is stereo-linked: hot left clamps right too", () => {
  const input = new Float32Array(FS);
  for (let i = 0; i < FS / 2; i += 1) {
    input[i * 2] = Math.sin((2 * Math.PI * 220 * i) / FS); // hot left, 0 dBFS
    input[i * 2 + 1] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / FS); // −12 dB right
  }
  applyMaximizer(input, { thresholdDb: 0, ceilingDb: -1, releaseMs: 50, sampleRate: FS });
  const ceiling = dbToGain(-1);
  let peakL = 0;
  let peakR = 0;
  for (let i = 0; i < input.length; i += 2) {
    peakL = Math.max(peakL, Math.abs(input[i]));
    peakR = Math.max(peakR, Math.abs(input[i + 1]));
  }
  assert.ok(peakL <= ceiling + 1e-6, `left must respect the ceiling (${gainToDb(peakL)})`);
  assert.ok(peakR <= ceiling + 1e-6, `right must be clamped with the left (${gainToDb(peakR)})`);
  // The shared gain ducks the quiet channel with the hot one: −12 dB of
  // signal stays −12 dB below the limited left peak rather than its own 0.25.
  assert.ok(peakR > 0.15 && peakR < 0.28, `linked gain must duck the right channel too (${peakR})`);
});
