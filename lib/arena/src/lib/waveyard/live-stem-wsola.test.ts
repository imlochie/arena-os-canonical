import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveStemWsola } from "./live-stem-wsola";

const SAMPLE_RATE = 48_000;

function tone(frequency: number, seconds = 3) {
  const samples = new Float32Array(Math.round(SAMPLE_RATE * seconds));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
  }
  return samples;
}

function render(frequency: number, rate: number, pitchPreserving: boolean) {
  const source = tone(frequency);
  const stretcher = new LiveStemWsola([source, source], SAMPLE_RATE);
  stretcher.setRate(rate);
  stretcher.setPitchPreserving(pitchPreserving);
  stretcher.setPlaying(true);
  const output = new Float32Array(SAMPLE_RATE);
  for (let offset = 0; offset < output.length; offset += 128) {
    const left = new Float32Array(Math.min(128, output.length - offset));
    const right = new Float32Array(left.length);
    stretcher.process([left, right]);
    output.set(left, offset);
  }
  return output.subarray(Math.round(SAMPLE_RATE * 0.2), Math.round(SAMPLE_RATE * 0.8));
}

function estimateFrequency(samples: Float32Array) {
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index - 1] <= 0 && samples[index] > 0) crossings += 1;
  }
  return (crossings * SAMPLE_RATE) / samples.length;
}

test("live WSOLA keeps a donor tone's pitch at both session speed limits", () => {
  for (const rate of [0.8, 1.2]) {
    const output = render(440, rate, true);
    assert.ok(Math.abs(estimateFrequency(output) - 440) < 4, `${rate}× should stay near 440 Hz`);
  }
});

test("live WSOLA pitch-follow mode changes tone frequency with session speed", () => {
  const slow = render(440, 0.8, false);
  const fast = render(440, 1.2, false);
  assert.ok(Math.abs(estimateFrequency(slow) - 352) < 4, "0.8× pitch-follow should reach 352 Hz");
  assert.ok(Math.abs(estimateFrequency(fast) - 528) < 4, "1.2× pitch-follow should reach 528 Hz");
});

test("seeking while pitch lock is enabled starts from the requested source frame", () => {
  const source = tone(440);
  const stretcher = new LiveStemWsola([source], SAMPLE_RATE);
  stretcher.setRate(1.1);
  stretcher.setPitchPreserving(true);
  stretcher.setPlaying(true);
  stretcher.seek(SAMPLE_RATE);
  const output = new Float32Array(128);
  stretcher.process([output]);
  assert.ok(Math.abs(estimateFrequency(output) - 440) < 80);
});
