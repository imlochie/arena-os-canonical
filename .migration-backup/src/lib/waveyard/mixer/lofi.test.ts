/**
 * Lo-Fi and Rectifier tests — quantization stair-steps, hold decimation,
 * noise shaping, wave-folding behaviour, DC removal.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyLoFi, applyRectifier } from "./lofi";
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

test("lofi at 24 bits and full rate is effectively transparent", () => {
  const input = sine(0.5, 1000, 0.25);
  const out = Float32Array.from(input);
  applyLoFi(out, { bits: 24, sampleRateHz: 48000, noisePercent: 0, mix: 1, sampleRate: FS });
  let maxDiff = 0;
  for (let i = 0; i < input.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(input[i] - out[i]));
  }
  assert.ok(maxDiff < 2e-6, `24-bit/48k must be near-transparent (maxDiff=${maxDiff})`);
});

test("lofi at 4 bits quantizes to audible steps", () => {
  const input = sine(0.5, 440, 0.5);
  const out = Float32Array.from(input);
  applyLoFi(out, { bits: 4, sampleRateHz: 48000, noisePercent: 0, mix: 1, sampleRate: FS });
  // 4 bits → step = 2^(1-4) = 0.125: every sample must sit on a 0.125 grid.
  for (let i = 100; i < out.length; i += 1) {
    const grid = out[i] / 0.125;
    assert.ok(Math.abs(grid - Math.round(grid)) < 1e-4, `sample ${i} on the 4-bit grid (${out[i]})`);
  }
  // Quantization distortion must actually change the signal.
  let diff = 0;
  for (let i = 0; i < input.length; i += 1) diff += Math.abs(input[i] - out[i]);
  assert.ok(diff > 1, `4-bit crush must alter the signal (diff=${diff})`);
});

test("lofi sample-and-hold freezes values between grabs", () => {
  const input = sine(0.05, 1000, 0.5); // 50 ms = 50 periods
  const out = Float32Array.from(input);
  // 1 kHz hold rate on a 1 kHz tone at 48k: 48-sample holds.
  applyLoFi(out, { bits: 24, sampleRateHz: 1000, noisePercent: 0, mix: 1, sampleRate: FS });
  let holds = 0;
  for (let i = 1; i < out.length / 2; i += 1) {
    if (out[i * 2] === out[(i - 1) * 2]) holds += 1;
  }
  const frames = out.length / 2;
  assert.ok(holds > frames * 0.9, `expected ~47/48 held samples, got ${holds}/${frames}`);
});

test("lofi noise adds measurable hiss, and mix 0 bypasses", () => {
  const input = sine(0.5, 1000, 0.25);
  const quiet = Float32Array.from(input);
  applyLoFi(quiet, { bits: 24, sampleRateHz: 48000, noisePercent: 50, mix: 1, sampleRate: FS });
  let quietEnergy = 0;
  let inputEnergy = 0;
  for (let i = 0; i < input.length; i += 1) {
    quietEnergy += (quiet[i] - input[i]) * (quiet[i] - input[i]);
    inputEnergy += input[i] * input[i];
  }
  assert.ok(quietEnergy > inputEnergy * 0.001, `hiss must be audible (ratio ${quietEnergy / inputEnergy})`);

  const bypassed = Float32Array.from(input);
  applyLoFi(bypassed, { bits: 4, sampleRateHz: 2000, noisePercent: 100, mix: 0, sampleRate: FS });
  let bypassDiff = 0;
  for (let i = 0; i < input.length; i += 1) {
    bypassDiff = Math.max(bypassDiff, Math.abs(bypassed[i] - input[i]));
  }
  assert.ok(bypassDiff === 0, `mix 0 must bypass exactly (maxDiff=${bypassDiff})`);
});

test("lofi is deterministic (seeded noise)", () => {
  const input = sine(0.5, 1000, 0.25);
  const a = Float32Array.from(input);
  const b = Float32Array.from(input);
  applyLoFi(a, { bits: 6, sampleRateHz: 8000, noisePercent: 30, mix: 1, sampleRate: FS });
  applyLoFi(b, { bits: 6, sampleRateHz: 8000, noisePercent: 30, mix: 1, sampleRate: FS });
  let detDiff = 0;
  for (let i = 0; i < a.length; i += 1) detDiff = Math.max(detDiff, Math.abs(a[i] - b[i]));
  assert.ok(detDiff === 0, `renders must be identical (maxDiff=${detDiff})`);
});

test("full-wave rectifier folds negatives up and removes DC", () => {
  const input = sine(0.5, 440, 0.5); // symmetric, zero mean
  const out = Float32Array.from(input);
  applyRectifier(out, { mode: 1, mix: 1, outputDb: 0, sampleRate: FS });
  // After DC removal the mean must be ~0 even though |x| has positive mean.
  let mean = 0;
  for (let i = 0; i < out.length; i += 1) mean += out[i];
  mean /= out.length;
  assert.ok(Math.abs(mean) < 0.02, `DC must be removed (mean=${mean})`);
  // |x| halves the period: the dominant tone must be ~880 Hz.
  let crossings = 0;
  const from = Math.floor((out.length / 2) * 0.25);
  const to = Math.floor((out.length / 2) * 0.75);
  let prev = out[from * 2];
  for (let i = from + 1; i < to; i += 1) {
    const v = out[i * 2];
    if (prev <= 0 && v > 0) crossings += 1;
    prev = v;
  }
  const hz = crossings / ((to - from) / FS);
  assert.ok(Math.abs(hz - 880) < 20, `full wave doubles frequency (got ${hz} Hz)`);
});

test("half-wave rectifier is asymmetric and differs from full-wave", () => {
  const input = sine(0.5, 440, 0.5);
  const half = Float32Array.from(input);
  applyRectifier(half, { mode: 0, mix: 1, outputDb: 0, sampleRate: FS });
  const full = Float32Array.from(input);
  applyRectifier(full, { mode: 1, mix: 1, outputDb: 0, sampleRate: FS });
  // Half-wave keeps only the positive half before DC removal, so after the
  // blocker its energy still leans on the input's positive half (measured
  // ~1.35x on a sine), and it must differ from full-wave everywhere-ish.
  let pos = 0;
  let neg = 0;
  let modeDiff = 0;
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] > 0.1) pos += Math.abs(half[i]);
    else if (input[i] < -0.1) neg += Math.abs(half[i]);
    modeDiff = Math.max(modeDiff, Math.abs(half[i] - full[i]));
  }
  assert.ok(pos > neg * 1.1, `half-wave must lean on the positive half (${pos} vs ${neg})`);
  assert.ok(modeDiff > 0.05, `half and full wave must differ (${modeDiff})`);
  let mean = 0;
  for (let i = 0; i < half.length; i += 1) mean += half[i];
  assert.ok(Math.abs(mean / half.length) < 0.02, `DC removed (mean=${mean / half.length})`);
});

test("rectifier mix 0 is a true bypass; output gain is a total trim", () => {
  const input = sine(0.5, 440, 0.5);
  // mix 0 with unity output gain: exact bypass.
  const bypassed = Float32Array.from(input);
  applyRectifier(bypassed, { mode: 1, mix: 0, outputDb: 0, sampleRate: FS });
  let bypassDiff = 0;
  for (let i = 0; i < input.length; i += 1) {
    bypassDiff = Math.max(bypassDiff, Math.abs(bypassed[i] - input[i]));
  }
  assert.ok(bypassDiff === 0, `mix 0 at unity must bypass exactly (${bypassDiff})`);

  // The output stage trims dry + wet together: mix 0 with +12 dB scales the
  // dry by exactly dbToGain(12).
  const trimmed = Float32Array.from(input);
  applyRectifier(trimmed, { mode: 1, mix: 0, outputDb: 12, sampleRate: FS });
  const want = Math.pow(10, 12 / 20);
  let trimErr = 0;
  for (let i = 100; i < input.length; i += 1) {
    trimErr = Math.max(trimErr, Math.abs(Math.abs(trimmed[i] / input[i]) - want));
  }
  assert.ok(trimErr < 1e-3, `output trim must scale the total by ${want} (err=${trimErr})`);

  const gained = Float32Array.from(input);
  applyRectifier(gained, { mode: 1, mix: 0.5, outputDb: -6, sampleRate: FS });
  let peak = 0;
  for (let i = 0; i < gained.length; i += 1) {
    assert.ok(Number.isFinite(gained[i]), `sample ${i}`);
    peak = Math.max(peak, Math.abs(gained[i]));
  }
  assert.ok(peak > 0 && peak < 0.6, `partial mix keeps signal in range (${peak})`);
});
