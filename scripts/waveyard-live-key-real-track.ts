import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { LiveKeyShift } from "../lib/arena/src/lib/waveyard/live-key-shift";
import { LiveStemWsola } from "../lib/arena/src/lib/waveyard/live-stem-wsola";

const SAMPLE_RATE = 48_000;
const BLOCK = 128;
const FFT_SIZE = 4096;
const shifts = [-11, -6, -3, 0, 3, 6, 11];
const rateSegments = [
  { start: 0, end: 2, rate: 1 },
  { start: 2, end: 4, rate: 0.85 },
  { start: 4, end: 6, rate: 1.15 },
  { start: 6, end: 8, rate: 0.9 },
  { start: 8, end: 10, rate: 1.1 },
];

function requirePositive(value: string | undefined, fallback: number, label: string) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number.`);
  return parsed;
}

function decodeStereo(file: string, startSeconds: number, durationSeconds: number) {
  const bytes = execFileSync("ffmpeg", [
    "-nostdin", "-v", "error", "-ss", String(startSeconds), "-t", String(durationSeconds),
    "-i", file, "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "2", "-ar", String(SAMPLE_RATE), "pipe:1",
  ], { maxBuffer: 64 * 1024 * 1024 });
  if (bytes.length < SAMPLE_RATE * durationSeconds * 2 * 4 * 0.95) {
    throw new Error(`FFmpeg decoded too little audio (${bytes.length} bytes) from the requested excerpt.`);
  }
  const interleaved = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  const frames = Math.floor(interleaved.length / 2);
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  for (let i = 0; i < frames; i += 1) {
    channels[0][i] = interleaved[i * 2];
    channels[1][i] = interleaved[i * 2 + 1];
  }
  return channels;
}

function fft(real: Float64Array, imaginary: Float64Array) {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

function chroma(samples: Float32Array[], startFrame: number, endFrame: number) {
  const bins = new Float64Array(12);
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) =>
    0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  let frames = 0;
  for (let offset = startFrame; offset + FFT_SIZE <= endFrame; offset += FFT_SIZE / 2) {
    real.fill(0);
    imaginary.fill(0);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      real[i] = ((samples[0][offset + i] ?? 0) + (samples[1][offset + i] ?? 0)) * 0.5 * window[i];
    }
    fft(real, imaginary);
    for (let bin = 5; bin < FFT_SIZE / 2; bin += 1) {
      const hz = bin * SAMPLE_RATE / FFT_SIZE;
      if (hz < 55 || hz > 5000) continue;
      const midi = Math.round(69 + 12 * Math.log2(hz / 440));
      const pitchClass = ((midi % 12) + 12) % 12;
      bins[pitchClass] += Math.hypot(real[bin], imaginary[bin]);
    }
    frames += 1;
  }
  if (frames === 0) throw new Error("The decoded excerpt is too short for a pitch-spectrum measurement.");
  return Array.from(bins, value => value / frames);
}

function shiftedChromaSimilarity(reference: number[], actual: number[], semitones: number) {
  let dot = 0;
  let referenceEnergy = 0;
  let actualEnergy = 0;
  for (let pitch = 0; pitch < 12; pitch += 1) {
    const expectedPitch = (pitch + semitones + 12) % 12;
    dot += reference[pitch] * actual[expectedPitch];
    referenceEnergy += reference[pitch] ** 2;
    actualEnergy += actual[expectedPitch] ** 2;
  }
  return dot / Math.max(1e-12, Math.sqrt(referenceEnergy * actualEnergy));
}

function logFrequencySpectrum(samples: Float32Array[], startFrame: number, endFrame: number) {
  const stepsPerSemitone = 6;
  const minimumMidi = 24;
  const maximumMidi = 100;
  const bins = new Float64Array((maximumMidi - minimumMidi) * stepsPerSemitone);
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) =>
    0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  for (let offset = startFrame; offset + FFT_SIZE <= endFrame; offset += FFT_SIZE / 2) {
    real.fill(0);
    imaginary.fill(0);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      real[i] = ((samples[0][offset + i] ?? 0) + (samples[1][offset + i] ?? 0)) * 0.5 * window[i];
    }
    fft(real, imaginary);
    for (let bin = 5; bin < FFT_SIZE / 2; bin += 1) {
      const hz = bin * SAMPLE_RATE / FFT_SIZE;
      if (hz < 55 || hz > 5000) continue;
      const midi = 69 + 12 * Math.log2(hz / 440);
      const index = Math.floor((midi - minimumMidi) * stepsPerSemitone);
      if (index >= 0 && index < bins.length) bins[index] += Math.hypot(real[bin], imaginary[bin]);
    }
  }
  return bins;
}

function estimateSemitoneShift(reference: Float64Array, actual: Float64Array) {
  const stepsPerSemitone = 6;
  let best = { semitones: 0, similarity: -Infinity };
  for (let steps = -11 * stepsPerSemitone; steps <= 11 * stepsPerSemitone; steps += 1) {
    let dot = 0;
    let referenceEnergy = 0;
    let actualEnergy = 0;
    for (let index = 0; index < reference.length; index += 1) {
      const shifted = index + steps;
      if (shifted < 0 || shifted >= actual.length) continue;
      dot += reference[index] * actual[shifted];
      referenceEnergy += reference[index] ** 2;
      actualEnergy += actual[shifted] ** 2;
    }
    const similarity = dot / Math.max(1e-12, Math.sqrt(referenceEnergy * actualEnergy));
    if (similarity > best.similarity) best = { semitones: steps / stepsPerSemitone, similarity };
  }
  return best;
}

function audioMetrics(samples: Float32Array[], startFrame: number, endFrame: number) {
  let sumSquares = 0;
  let peak = 0;
  let clippedSamples = 0;
  let hardJumps = 0;
  let stereoDot = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const left = samples[0][frame];
    const right = samples[1][frame];
    sumSquares += (left * left + right * right) * 0.5;
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
    if (Math.abs(left) >= 0.99999 || Math.abs(right) >= 0.99999) clippedSamples += 1;
    if (frame > startFrame
      && Math.max(Math.abs(left - samples[0][frame - 1]), Math.abs(right - samples[1][frame - 1])) > 0.75) {
      hardJumps += 1;
    }
    stereoDot += left * right;
    leftSquares += left * left;
    rightSquares += right * right;
  }
  const frames = Math.max(1, endFrame - startFrame);
  return {
    rms: Math.sqrt(sumSquares / frames),
    peak,
    clippedSamples,
    hardJumps,
    stereoCorrelation: stereoDot / Math.max(1e-12, Math.sqrt(leftSquares * rightSquares)),
  };
}

function envelopeLatencyMs(input: Float32Array[], output: Float32Array[], start: number, end: number) {
  const step = SAMPLE_RATE / 100;
  const energyEnvelope = (channels: Float32Array[]) => {
    const values: number[] = [];
    for (let from = start; from + step <= end; from += step) {
      let energy = 0;
      for (let frame = from; frame < from + step; frame += 1) {
        energy += ((channels[0][frame] ?? 0) ** 2 + (channels[1][frame] ?? 0) ** 2) * 0.5;
      }
      values.push(Math.sqrt(energy / step));
    }
    return values;
  };
  const before = energyEnvelope(input);
  const after = energyEnvelope(output);
  let best = { lag: 0, score: -Infinity };
  for (let lag = -12; lag <= 12; lag += 1) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 12; i < before.length - 12; i += 1) {
      const shifted = i + lag;
      if (shifted < 0 || shifted >= after.length) continue;
      xy += before[i] * after[shifted];
      xx += before[i] ** 2;
      yy += after[shifted] ** 2;
    }
    const score = xy / Math.max(1e-12, Math.sqrt(xx * yy));
    if (score > best.score) best = { lag, score };
  }
  return { estimatedEnvelopeDelayMs: best.lag * 10, envelopeCorrelation: best.score };
}

function render(semitones: number, input: Float32Array[]) {
  const frameCount = Math.min(input[0].length, SAMPLE_RATE * 10);
  const source = input.map(channel => channel.subarray(0, frameCount));
  const wsola = new LiveStemWsola(source, SAMPLE_RATE);
  wsola.setPitchPreserving(true);
  wsola.setPlaying(true);
  const shifter = new LiveKeyShift(SAMPLE_RATE, 2);
  shifter.setSemitones(semitones);
  const unshifted = [new Float32Array(frameCount), new Float32Array(frameCount)];
  const shifted = [new Float32Array(frameCount), new Float32Array(frameCount)];
  const wsolaBlock = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const keyBlock = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const rateChanges: { frame: number; rate: number }[] = [];
  const started = performance.now();

  for (let offset = 0; offset < frameCount; offset += BLOCK) {
    const seconds = offset / SAMPLE_RATE;
    const segment = rateSegments.find(item => seconds >= item.start && seconds < item.end);
    const rate = segment?.rate ?? 1;
    if (offset === 0 || segment?.start === seconds) {
      wsola.setRate(rate);
      rateChanges.push({ frame: offset, rate });
    }
    wsola.process(wsolaBlock);
    shifter.process(wsolaBlock, keyBlock);
    const count = Math.min(BLOCK, frameCount - offset);
    for (let channel = 0; channel < 2; channel += 1) {
      unshifted[channel].set(wsolaBlock[channel].subarray(0, count), offset);
      shifted[channel].set(keyBlock[channel].subarray(0, count), offset);
    }
  }
  return {
    source,
    unshifted,
    shifted,
    rateChanges,
    processingMs: performance.now() - started,
  };
}

const args = process.argv.slice(2).filter(argument => argument !== "--");
const inputPath = args[0];
if (!inputPath || inputPath.startsWith("--")) {
  throw new Error("Usage: pnpm --filter @workspace/scripts exec tsx $PWD/scripts/waveyard-live-key-real-track.ts -- <authorized-audio-file> [excerpt-start-seconds]");
}
const file = resolve(inputPath);
const startSeconds = requirePositive(args[1], 30, "Excerpt start");
const stat = readFileSync(file);
const requestedDurationSeconds = 10;
const input = decodeStereo(file, startSeconds, requestedDurationSeconds);
const frameCount = input[0].length;
const inputInfo = {
  file: basename(file),
  sha256: createHash("sha256").update(stat).digest("hex"),
  decodedSampleRate: SAMPLE_RATE,
  decodedChannels: 2,
  bitDepth: "float32 analysis PCM (source codec bit depth is retained in the original file)",
  excerptStartSeconds: startSeconds,
  decodedDurationSeconds: frameCount / SAMPLE_RATE,
  rateSequence: rateSegments.map(({ start, end, rate }) => ({ start, end, rate })),
};
const results = [];

for (const semitones of shifts) {
  const rendered = render(semitones, input);
  const intervals = rateSegments.map(segment => {
    const start = Math.round(segment.start * SAMPLE_RATE);
    const end = Math.min(frameCount, Math.round(segment.end * SAMPLE_RATE));
    const referenceChroma = chroma(rendered.unshifted, start, end);
    const outputChroma = chroma(rendered.shifted, start, end);
    const estimatedPitch = estimateSemitoneShift(
      logFrequencySpectrum(rendered.unshifted, start, end),
      logFrequencySpectrum(rendered.shifted, start, end),
    );
    const before = audioMetrics(rendered.unshifted, start, end);
    const after = audioMetrics(rendered.shifted, start, end);
    return {
      rate: segment.rate,
      seconds: [segment.start, Math.min(segment.end, frameCount / SAMPLE_RATE)],
      spectralPitchClassSimilarity: shiftedChromaSimilarity(referenceChroma, outputChroma, semitones),
      estimatedSemitoneShift: estimatedPitch.semitones,
      spectralShiftSimilarity: estimatedPitch.similarity,
      metrics: {
        inputRms: before.rms,
        outputRms: after.rms,
        loudnessDeltaDb: 20 * Math.log10(Math.max(1e-8, after.rms) / Math.max(1e-8, before.rms)),
        inputPeak: before.peak,
        outputPeak: after.peak,
        clippedSamples: after.clippedSamples,
        inputHardJumps: before.hardJumps,
        outputHardJumps: after.hardJumps,
        inputStereoCorrelation: before.stereoCorrelation,
        outputStereoCorrelation: after.stereoCorrelation,
        estimatedEnvelopeLatency: envelopeLatencyMs(rendered.unshifted, rendered.shifted, start, end),
      },
    };
  });
  results.push({
    semitones,
    expectedFrequencyRatio: 2 ** (semitones / 12),
    processingMs: rendered.processingMs,
    realTimeFactor: rendered.processingMs / 1000 / (frameCount / SAMPLE_RATE),
    frameCountPreserved: rendered.shifted.every(channel => channel.length === input[0].length),
    liveTempoChanges: rendered.rateChanges,
    intervals,
  });
}

for (const result of results) {
  assert(result.frameCountPreserved, `${result.semitones}-semitone shift must keep the 10-second output clock intact.`);
  for (const interval of result.intervals) {
    assert(
      interval.spectralPitchClassSimilarity >= 0.9,
      `${result.semitones}-semitone shift missed its measured pitch class at ${interval.rate}x: ${interval.spectralPitchClassSimilarity}`,
    );
    assert(
      interval.metrics.loudnessDeltaDb >= -3 && interval.metrics.loudnessDeltaDb <= 3,
      `${result.semitones}-semitone shift changed excerpt RMS by more than 3 dB at ${interval.rate}x: ${interval.metrics.loudnessDeltaDb}`,
    );
    assert(
      interval.metrics.outputPeak <= 1 && interval.metrics.clippedSamples === 0,
      `${result.semitones}-semitone shift clipped the output at ${interval.rate}x.`,
    );
    assert(
      Math.abs(interval.metrics.estimatedEnvelopeLatency.estimatedEnvelopeDelayMs) <= 80,
      `${result.semitones}-semitone shift exceeded the 80 ms measured envelope-delay limit.`,
    );
  }
}

console.log(JSON.stringify({ report: "waveyard-live-key-real-track-v1", input: inputInfo, results }, null, 2));
