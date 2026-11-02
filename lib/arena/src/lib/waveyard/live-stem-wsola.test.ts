import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveStemWsola } from "./live-stem-wsola";
import { copyPcmChannelsForWorklet } from "./live-stem-layers";

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

test("mono donor PCM is transferred once and rendered to both output channels", () => {
  const mono = new Float32Array(SAMPLE_RATE);
  const channels = copyPcmChannelsForWorklet({
    numberOfChannels: 1,
    getChannelData: () => mono,
  });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].byteLength, mono.byteLength);
});

test("three-minute stereo pitch-lock migration stays within its measured PCM budget", () => {
  const frames = SAMPLE_RATE * 180;
  const before = process.memoryUsage().arrayBuffers;
  const sourceLeft = new Float32Array(frames);
  const sourceRight = new Float32Array(frames);
  const transferred = copyPcmChannelsForWorklet({
    numberOfChannels: 2,
    getChannelData: (channel) => channel === 0 ? sourceLeft : sourceRight,
  });
  const stretcher = new LiveStemWsola(transferred, SAMPLE_RATE);
  stretcher.setRate(1.2);
  stretcher.setPitchPreserving(true);
  stretcher.setPlaying(true);
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  for (let block = 0; block < 64; block += 1) stretcher.process([left, right]);
  const measuredBytes = process.memoryUsage().arrayBuffers - before;
  const pcmBytes = frames * 2 * Float32Array.BYTES_PER_ELEMENT;
  assert.equal(transferred.reduce((total, channel) => total + channel.byteLength, 0), pcmBytes);
  assert.ok(
    measuredBytes <= 140 * 1024 * 1024,
    `three minutes of 48 kHz stereo PCM, the temporary transfer copy, and WSOLA scratch must stay under 140 MiB (measured ${(measuredBytes / 1024 / 1024).toFixed(2)} MiB)`,
  );
});
