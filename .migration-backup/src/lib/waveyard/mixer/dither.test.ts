/**
 * Dither tests — quantization grid, TPDF noise behaviour, silence
 * passthrough, determinism, clamping.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyDither } from "./dither";
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

test("16-bit dither puts every sample on the quantization grid", () => {
  const input = sine(0.5, 440, 0.5);
  const out = Float32Array.from(input);
  applyDither(out, { bitDepth: 16, noiseShaping: false, sampleRate: FS });
  const lsb = Math.pow(2, 1 - 16);
  for (let i = 0; i < out.length; i += 1) {
    const grid = out[i] / lsb;
    assert.ok(Math.abs(grid - Math.round(grid)) < 1e-6, `sample ${i} on the 16-bit grid (${out[i]})`);
    assert.ok(Math.abs(out[i]) <= 1, `sample ${i} within full scale (${out[i]})`);
  }
});

test("24-bit dither is effectively transparent", () => {
  const input = sine(0.5, 440, 0.5);
  const out = Float32Array.from(input);
  applyDither(out, { bitDepth: 24, noiseShaping: false, sampleRate: FS });
  const lsb = Math.pow(2, 1 - 24);
  let maxDiff = 0;
  for (let i = 0; i < input.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(input[i] - out[i]));
  }
  // TPDF spans ±1 LSB (2 LSB peak-to-peak), so |q − x| ≤ 1.5 LSB; at 24
  // bits that is ~1.8e-7 — numerically bounded and utterly inaudible.
  assert.ok(maxDiff <= 1.5 * lsb, `24-bit requantization error must stay within 1.5 LSB (${maxDiff} vs ${lsb})`);
});

test("dither adds noise: a constant signal dithers between adjacent levels", () => {
  const frames = 5000;
  const input = new Float32Array(frames * 2).fill(0.5);
  const out = Float32Array.from(input);
  applyDither(out, { bitDepth: 16, noiseShaping: false, sampleRate: FS });
  const lsb = Math.pow(2, 1 - 16);
  const levels = new Set<number>();
  for (let i = 100; i < out.length; i += 1) {
    levels.add(Math.round(out[i] / lsb));
  }
  // TPDF at ±½ LSB makes the requantizer visit both neighbouring levels.
  assert.ok(levels.size >= 2, `dither must toggle levels (saw ${[...levels].slice(0, 4)})`);
});

test("digital silence passes through as exact silence", () => {
  const input = new Float32Array(1000);
  const out = Float32Array.from(input);
  applyDither(out, { bitDepth: 16, noiseShaping: true, sampleRate: FS });
  for (let i = 0; i < out.length; i += 1) {
    assert.equal(out[i], 0, `sample ${i} must stay silent`);
  }
});

test("dither never deviates from the input by more than ~1.5 LSB", () => {
  const input = sine(0.5, 997, 0.4);
  const out = Float32Array.from(input);
  applyDither(out, { bitDepth: 16, noiseShaping: false, sampleRate: FS });
  const lsb = Math.pow(2, 1 - 16);
  let maxDev = 0;
  for (let i = 0; i < input.length; i += 1) {
    maxDev = Math.max(maxDev, Math.abs(input[i] - out[i]));
  }
  assert.ok(maxDev < 1.5 * lsb, `deviation must stay bounded (${maxDev} vs lsb ${lsb})`);
});

test("noise shaping stays finite, on-grid, and bounded", () => {
  const input = sine(1, 440, 0.9); // hot signal exercises the error feedback
  const out = Float32Array.from(input);
  applyDither(out, { bitDepth: 16, noiseShaping: true, sampleRate: FS });
  const lsb = Math.pow(2, 1 - 16);
  for (let i = 0; i < out.length; i += 1) {
    assert.ok(Number.isFinite(out[i]), `sample ${i} finite`);
    const grid = out[i] / lsb;
    assert.ok(Math.abs(grid - Math.round(grid)) < 1e-6, `sample ${i} on grid`);
    assert.ok(out[i] >= -1 && out[i] <= 1 - lsb, `sample ${i} clamped to the representable range (${out[i]})`);
  }
});

test("full-scale input is clamped below +1.0", () => {
  const input = new Float32Array(2000).fill(1);
  const out = Float32Array.from(input);
  applyDither(out, { bitDepth: 16, noiseShaping: false, sampleRate: FS });
  const lsb = Math.pow(2, 1 - 16);
  let max = -Infinity;
  for (let i = 0; i < out.length; i += 1) max = Math.max(max, out[i]);
  assert.ok(max <= 1 - lsb, `peak must clamp to 1 − LSB (got ${max})`);
});

test("dither is deterministic (seeded LCG)", () => {
  const input = sine(0.5, 440, 0.5);
  const a = Float32Array.from(input);
  const b = Float32Array.from(input);
  applyDither(a, { bitDepth: 16, noiseShaping: true, sampleRate: FS });
  applyDither(b, { bitDepth: 16, noiseShaping: true, sampleRate: FS });
  let maxDiff = 0;
  for (let i = 0; i < a.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
  assert.ok(maxDiff === 0, `renders must be identical (maxDiff=${maxDiff})`);
});
