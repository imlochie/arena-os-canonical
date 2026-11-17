import assert from "node:assert/strict";
import test from "node:test";
import { pitchShiftPreviewStereoPcm } from "./arrangement-preview-audio";

const RATE = 22_050;

function stereoSine(seconds: number, frequency: number) {
  const frames = Math.round(seconds * RATE);
  const samples = new Float32Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.sin(2 * Math.PI * frequency * frame / RATE) * 0.4;
    samples[frame * 2] = value;
    samples[frame * 2 + 1] = value;
  }
  return samples;
}

function zeroCrossingFrequency(samples: Float32Array, from = 0.25, to = 0.75) {
  const start = Math.floor(samples.length / 2 * from);
  const end = Math.floor(samples.length / 2 * to);
  let crossings = 0;
  for (let frame = start + 1; frame < end; frame += 1)
    if (samples[(frame - 1) * 2]! <= 0 && samples[frame * 2]! > 0) crossings += 1;
  return crossings / ((end - start) / RATE);
}

test("preview key shift changes pitch while preserving the clip's duration", () => {
  const input = stereoSine(1, 440);
  const shifted = pitchShiftPreviewStereoPcm(input, 2, RATE);
  assert.equal(shifted.length, input.length);
  assert.ok(Math.abs(zeroCrossingFrequency(shifted) - 440 * 2 ** (2 / 12)) < 4);
});

test("preview key shift rejects unsupported channel shape and shifts", () => {
  assert.throws(() => pitchShiftPreviewStereoPcm(new Float32Array(11), 2, RATE), /interleaved stereo/);
  assert.throws(() => pitchShiftPreviewStereoPcm(new Float32Array(12), 12, RATE), /-11 to \+11/);
});
