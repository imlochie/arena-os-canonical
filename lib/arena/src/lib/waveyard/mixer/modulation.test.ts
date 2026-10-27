/**
 * Modulation effect tests — chorus, flanger, phaser. Real processing, no
 * mocks: tail extension, dry/wet honesty, stereo spread, determinism.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MODULATION_TAIL_MS,
  applyChorus,
  applyFlanger,
  applyPhaser,
  type ChorusParams,
} from "./modulation";
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

function rms(buffer: StereoBuffer, fromFrame: number, toFrame: number): number {
  let sum = 0;
  let count = 0;
  for (let i = fromFrame * 2; i < toFrame * 2; i += 1) {
    sum += buffer[i] * buffer[i];
    count += 1;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

function baseChorus(overrides: Partial<ChorusParams> = {}): ChorusParams {
  return {
    rateHz: 0.8,
    depth: 0.5,
    delayMs: 12,
    feedback: 0,
    mix: 1,
    spread: 1,
    sampleRate: FS,
    ...overrides,
  };
}

test("modulation effects extend the buffer by their declared tail", () => {
  const input = sine(0.5, 440, 0.3);
  for (const [name, out, tailMs] of [
    ["chorus", applyChorus(input, baseChorus()), MODULATION_TAIL_MS.chorus],
    ["flanger", applyFlanger(input, { rateHz: 0.25, depth: 0.7, delayMs: 2, feedback: 0.5, mix: 1, sampleRate: FS }), MODULATION_TAIL_MS.flanger],
    ["phaser", applyPhaser(input, { rateHz: 0.5, depth: 0.7, stages: 6, feedback: 0.4, centerHz: 800, mix: 1, sampleRate: FS }), MODULATION_TAIL_MS.phaser],
  ] as const) {
    const expected = input.length / 2 + Math.ceil((tailMs / 1000) * FS);
    assert.equal(out.length, expected * 2, `${name} tail length`);
  }
});

test("mix 0 returns the dry signal untouched in the dry region", () => {
  const input = sine(0.3, 440, 0.3);
  const out = applyChorus(input, baseChorus({ mix: 0 }));
  for (let i = 0; i < input.length; i += 1) {
    assert.equal(out[i], input[i]);
  }
  // Beyond the input the dry is zero and wet is multiplied by mix 0.
  for (let i = input.length; i < out.length; i += 1) {
    assert.equal(out[i], 0);
  }
});

test("chorus with spread 0 processes both channels identically", () => {
  const input = sine(0.4, 440, 0.3); // identical L/R
  const out = applyChorus(input, baseChorus({ spread: 0, feedback: 0.25 }));
  for (let i = 0; i < out.length / 2; i += 1) {
    assert.equal(out[i * 2], out[i * 2 + 1], `frame ${i} must be identical`);
  }
});

test("chorus with spread 1 decorrelates the channels", () => {
  const input = sine(0.4, 440, 0.3);
  const out = applyChorus(input, baseChorus({ spread: 1, feedback: 0.25 }));
  let diff = 0;
  for (let i = 0; i < out.length / 2; i += 1) {
    diff += Math.abs(out[i * 2] - out[i * 2 + 1]);
  }
  assert.ok(diff > 0.01, `channels must differ with full spread (diff=${diff})`);
});

test("chorus depth changes the wet signal", () => {
  const input = sine(0.4, 440, 0.3);
  const shallow = applyChorus(input, baseChorus({ depth: 0.02 }));
  const deep = applyChorus(input, baseChorus({ depth: 1 }));
  let diff = 0;
  const n = Math.min(shallow.length, deep.length);
  for (let i = 0; i < n; i += 1) diff += Math.abs(shallow[i] - deep[i]);
  assert.ok(diff > 0.05, `depth must matter (diff=${diff})`);
});

test("flanger feedback sign flips the comb character", () => {
  const input = sine(0.4, 440, 0.3);
  const positive = applyFlanger(input, { rateHz: 0.25, depth: 0.7, delayMs: 2, feedback: 0.6, mix: 1, sampleRate: FS });
  const negative = applyFlanger(input, { rateHz: 0.25, depth: 0.7, delayMs: 2, feedback: -0.6, mix: 1, sampleRate: FS });
  let diff = 0;
  const n = Math.min(positive.length, negative.length);
  for (let i = 0; i < n; i += 1) diff += Math.abs(positive[i] - negative[i]);
  assert.ok(diff > 0.05, `feedback sign must matter (diff=${diff})`);
});

test("flanger at depth 0 still applies a fixed short delay", () => {
  const input = new Float32Array(FS); // 0.5 s
  input[100 * 2] = 1;
  input[100 * 2 + 1] = 1;
  const out = applyFlanger(input, { rateHz: 0.25, depth: 0, delayMs: 5, feedback: 0, mix: 1, sampleRate: FS });
  // 5 ms = 240 frames: the impulse energy must move to ~frame 340.
  const before = rms(out, 100, 140);
  const after = rms(out, 330, 350);
  assert.ok(before < 1e-4, `no energy at the dry position (rms=${before})`);
  assert.ok(after > 0.1, `impulse must arrive ~5 ms later (rms=${after})`);
});

test("phaser rotates phase: mix 1 changes the waveform but keeps energy bounded", () => {
  const input = sine(0.4, 440, 0.3);
  const out = applyPhaser(input, { rateHz: 0.5, depth: 0.7, stages: 6, feedback: 0, centerHz: 800, mix: 1, sampleRate: FS });
  let diff = 0;
  let peak = 0;
  for (let i = 0; i < input.length; i += 1) {
    diff += Math.abs(out[i] - input[i]);
    peak = Math.max(peak, Math.abs(out[i]));
  }
  assert.ok(diff > 0.05, `phaser must alter the signal (diff=${diff})`);
  assert.ok(peak <= 2, `output must stay bounded (peak=${peak})`);
});

test("phaser stage counts snap and stay stable with feedback", () => {
  const input = sine(0.4, 440, 0.3);
  for (const stages of [2, 5, 7, 12]) {
    const out = applyPhaser(input, { rateHz: 0.5, depth: 0.7, stages, feedback: 0.9, centerHz: 800, mix: 1, sampleRate: FS });
    for (let i = 0; i < out.length; i += 1) {
      assert.ok(Number.isFinite(out[i]), `stages=${stages} sample ${i} finite`);
      assert.ok(Math.abs(out[i]) <= 8, `stages=${stages} sample ${i} bounded (${out[i]})`);
    }
  }
});

test("modulation processing is deterministic", () => {
  const input = sine(0.4, 440, 0.3);
  const a = applyChorus(input, baseChorus());
  const b = applyChorus(input, baseChorus());
  let detDiff = 0;
  for (let i = 0; i < a.length; i += 1) detDiff = Math.max(detDiff, Math.abs(a[i] - b[i]));
  assert.ok(detDiff === 0, `renders must be identical (maxDiff=${detDiff})`);
});

test("wet tails carry energy with feedback", () => {
  const input = sine(0.3, 440, 0.4);
  const inFrames = input.length / 2;
  const out = applyFlanger(input, { rateHz: 0.25, depth: 0.7, delayMs: 4, feedback: 0.85, mix: 1, sampleRate: FS });
  const tailRms = rms(out, inFrames + 10, out.length / 2);
  assert.ok(tailRms > 1e-4, `feedback tail must ring (rms=${tailRms})`);
});
