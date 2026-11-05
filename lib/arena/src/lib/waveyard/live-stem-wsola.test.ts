import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveStemWsola } from "./live-stem-wsola";
import {
  copyPcmChannelsForWorklet,
  estimateLiveStemPitchLockMemory,
  LIVE_STEM_PITCH_LOCK_SESSION_BUDGET_BYTES,
} from "./live-stem-layers";

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

test("live WSOLA keeps lower donor pitches at an intermediate session speed", () => {
  for (const frequency of [230, 370]) {
    const output = render(frequency, 1.1, true);
    assert.ok(
      Math.abs(estimateFrequency(output) - frequency) < 4,
      `1.1× should keep a ${frequency} Hz donor near its source pitch`,
    );
  }
});

test("live WSOLA pitch-follow mode changes tone frequency with session speed", () => {
  const slow = render(440, 0.8, false);
  const fast = render(440, 1.2, false);
  assert.ok(Math.abs(estimateFrequency(slow) - 352) < 4, "0.8× pitch-follow should reach 352 Hz");
  assert.ok(Math.abs(estimateFrequency(fast) - 528) < 4, "1.2× pitch-follow should reach 528 Hz");
});

test("pitch lock keeps percussion on the tempo clock over a minute, not the correlation search clock", () => {
  const sampleRate = 48_000;
  const source = new Float32Array(sampleRate * 8);
  for (let frame = 0; frame < source.length; frame++) {
    const sinceBeat = (frame - sampleRate / 4 + source.length) % (sampleRate / 2);
    source[frame] = 0.08 * Math.sin(2 * Math.PI * 233 * frame / sampleRate)
      + (sinceBeat < 40 ? 0.9 * Math.exp(-sinceBeat / 10) : 0);
  }
  for (const rate of [0.8, 1.2]) {
    const processor = new LiveStemWsola([source], sampleRate);
    processor.setRate(rate);
    processor.setPitchPreserving(true);
    processor.setPlaying(true);
    const output = new Float32Array(sampleRate * 60);
    for (let frame = 0; frame < output.length; frame += 128) {
      processor.process([output.subarray(frame, Math.min(output.length, frame + 128))]);
    }
    let maximumError = 0;
    let minimumPeak = Infinity;
    for (let beat = 2; ; beat++) {
      const expected = (0.25 + beat * 0.5) / rate * sampleRate;
      if (expected + sampleRate / 5 >= output.length) break;
      let peak = 0;
      let peakFrame = 0;
      for (let frame = Math.floor(expected - sampleRate / 5); frame < expected + sampleRate / 5; frame++) {
        if (Math.abs(output[frame]) > peak) {
          peak = Math.abs(output[frame]);
          peakFrame = frame;
        }
      }
      minimumPeak = Math.min(minimumPeak, peak);
      maximumError = Math.max(maximumError, Math.abs(peakFrame - expected) / sampleRate);
    }
    assert.ok(minimumPeak > 0.2, `${rate}× must retain a real drum transient on every expected beat`);
    console.log(`WAVEYARD_PERCUSSION_TIMING ${JSON.stringify({
      sampleRate, durationSeconds: 60, rate,
      maximumTransientErrorMs: Number((maximumError * 1000).toFixed(3)),
      minimumTransientPeak: Number(minimumPeak.toFixed(3)),
    })}`);
    assert.ok(maximumError < 0.045, `${rate}× maximum transient timing error ${maximumError.toFixed(4)}s must stay bounded, not accumulate`);
  }
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
  const mono = tone(440);
  const channels = copyPcmChannelsForWorklet({
    numberOfChannels: 1,
    getChannelData: () => mono,
  });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].byteLength, mono.byteLength);
  const stretcher = new LiveStemWsola(channels, SAMPLE_RATE);
  stretcher.setPlaying(true);
  const leftOutput = new Float32Array(128 * 188);
  const rightOutput = new Float32Array(leftOutput.length);
  for (let offset = 0; offset < leftOutput.length; offset += 128) {
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    stretcher.process([left, right]);
    leftOutput.set(left, offset);
    rightOutput.set(right, offset);
  }
  assert.deepEqual(leftOutput, rightOutput);
  assert.ok(Math.abs(estimateFrequency(leftOutput.subarray(4_800, 19_200)) - 440) < 4);
});

test("four three-minute stereo donors fit the measured pitch-lock session PCM budget", () => {
  const frames = SAMPLE_RATE * 180;
  const before = process.memoryUsage().arrayBuffers;
  const pcmBytes = frames * 2 * Float32Array.BYTES_PER_ELEMENT;
  const decodedDonors: Array<[Float32Array, Float32Array] | null> = Array.from(
    { length: 4 },
    () => [new Float32Array(frames), new Float32Array(frames)],
  );
  const workletProcessors: LiveStemWsola[] = [];
  const retainedWorkletPcm: Float32Array[][] = [];
  let retainedBytes = 0;
  let peakPcmBytes = 0;
  let peakArrayBufferBytes = 0;
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  for (let donor = 0; donor < decodedDonors.length; donor += 1) {
    const source = decodedDonors[donor]!;
    const transferred = copyPcmChannelsForWorklet({
      numberOfChannels: 2,
      getChannelData: (channel) => source[channel],
    });
    const stretcher = new LiveStemWsola(transferred, SAMPLE_RATE);
    stretcher.setRate(1.2);
    stretcher.setPitchPreserving(true);
    stretcher.setPlaying(true);
    stretcher.process([left, right]);
    workletProcessors.push(stretcher);
    retainedWorkletPcm.push(transferred);
    const transferredBytes = transferred.reduce((total, channel) => total + channel.byteLength, 0);
    assert.equal(transferredBytes, pcmBytes);
    peakArrayBufferBytes = Math.max(peakArrayBufferBytes, process.memoryUsage().arrayBuffers - before);
    peakPcmBytes = Math.max(
      peakPcmBytes,
      retainedBytes + decodedDonors.reduce((total, item) =>
        total + (item ? item[0].byteLength + item[1].byteLength : 0), 0) + 2 * transferredBytes,
    );
    retainedBytes += transferredBytes;
    decodedDonors[donor] = null;
    (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
    peakArrayBufferBytes = Math.max(peakArrayBufferBytes, process.memoryUsage().arrayBuffers - before);
  }
  const estimate = estimateLiveStemPitchLockMemory(Array(4).fill(pcmBytes));
  const retainedWorkletBytes = retainedWorkletPcm.reduce(
    (total, channels) => total + channels.reduce((channelTotal, channel) => channelTotal + channel.byteLength, 0),
    0,
  );
  assert.equal(retainedBytes, 4 * pcmBytes);
  assert.equal(retainedWorkletBytes, retainedBytes, "all four worklets retain their transferred stereo PCM");
  assert.equal(estimate.retainedBytes, retainedBytes);
  assert.equal(peakPcmBytes, 6 * pcmBytes, "the estimate includes the migration copy and one donor awaiting reclamation");
  assert.equal(estimate.peakBytes, peakPcmBytes);
  console.log(`WAVEYARD_PITCH_PCM_BUDGET ${JSON.stringify({
    donorCount: 4,
    durationSeconds: 180,
    sampleRate: SAMPLE_RATE,
    channels: 2,
    retainedMiB: Number((retainedBytes / 1024 / 1024).toFixed(2)),
    measuredPeakArrayBuffersMiB: Number((peakArrayBufferBytes / 1024 / 1024).toFixed(2)),
    estimatedPeakPcmMiB: Number((peakPcmBytes / 1024 / 1024).toFixed(2)),
    estimatedPeakMiB: Number((estimate.peakBytes / 1024 / 1024).toFixed(2)),
    budgetMiB: LIVE_STEM_PITCH_LOCK_SESSION_BUDGET_BYTES / 1024 / 1024,
  })}`);
  assert.ok(
    estimate.peakBytes <= LIVE_STEM_PITCH_LOCK_SESSION_BUDGET_BYTES,
    `four three-minute 48 kHz stereo donors and migration overlap must stay under the 512 MiB session limit (estimated ${(estimate.peakBytes / 1024 / 1024).toFixed(2)} MiB)`,
  );
  assert.ok(
    peakArrayBufferBytes <= LIVE_STEM_PITCH_LOCK_SESSION_BUDGET_BYTES,
    `measured PCM ArrayBuffer peak must stay under the 512 MiB session limit (measured ${(peakArrayBufferBytes / 1024 / 1024).toFixed(2)} MiB)`,
  );
});
