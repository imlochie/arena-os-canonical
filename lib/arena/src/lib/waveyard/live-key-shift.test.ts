import assert from "node:assert/strict";
import test from "node:test";
import { LiveKeyShift } from "./live-key-shift";

const SAMPLE_RATE = 48_000;

function renderTone(semitones: number, frequency = 440, seconds = 1.5) {
  const effect = new LiveKeyShift(SAMPLE_RATE, 1);
  effect.setSemitones(semitones);
  const length = Math.round(seconds * SAMPLE_RATE);
  const input = new Float32Array(128);
  const output = new Float32Array(128);
  const captured = new Float32Array(length);
  let written = 0;
  for (let block = 0; written < length; block += 1) {
    const count = Math.min(128, length - written);
    for (let index = 0; index < count; index += 1) {
      input[index] = Math.sin(2 * Math.PI * frequency * (written + index) / SAMPLE_RATE);
    }
    effect.process([input], [output]);
    captured.set(output.subarray(0, count), written);
    written += count;
  }
  return captured;
}

function dominantFrequency(samples: Float32Array, expected: number) {
  const start = Math.floor(SAMPLE_RATE * 0.25);
  const end = samples.length - start;
  const crossings: number[] = [];
  for (let index = start + 1; index < end; index += 1) {
    const before = samples[index - 1];
    const after = samples[index];
    if (before <= 0 && after > 0 && after - before > 0.005) {
      crossings.push(index - 1 + -before / (after - before));
    }
  }
  const intervals = crossings.slice(1).map((crossing, index) => crossing - crossings[index]);
  const period = intervals.reduce((total, value) => total + value, 0) / intervals.length;
  return SAMPLE_RATE / period;
}

test("live key shift changes pitch while keeping frame count and timeline intact", () => {
  for (const semitones of [-4, 3, 7]) {
    const output = renderTone(semitones);
    const expected = 440 * 2 ** (semitones / 12);
    const measured = dominantFrequency(output, expected);
    assert.equal(output.length, Math.round(1.5 * SAMPLE_RATE));
    assert.ok(
      Math.abs(measured - expected) < 4,
      `${semitones} semitones should measure near ${expected.toFixed(2)} Hz, measured ${measured.toFixed(2)} Hz`,
    );
  }
});

test("zero semitones is transparent and invalid key shifts fail explicitly", () => {
  const effect = new LiveKeyShift(SAMPLE_RATE, 1);
  const input = Float32Array.from({ length: 128 }, (_, index) => Math.sin(index / 9));
  const output = new Float32Array(128);
  effect.process([input], [output]);
  assert.deepEqual(output, input);
  assert.throws(() => effect.setSemitones(12), /-11 to \+11/);
  assert.throws(() => effect.setSemitones(1.5), /integer/);
});
