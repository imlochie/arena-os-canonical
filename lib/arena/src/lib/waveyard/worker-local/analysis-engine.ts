/**
 * arena-js-dsp — the desktop's real source-analysis engine.
 *
 * The cloud worker analyzes with Python/numpy (engine name
 * `waveyard-numpy-dsp`); the desktop cannot package that, so this engine
 * performs the same analysis natively in JS from decoded PCM:
 *   - BPM + beat grid: onset-energy envelope + autocorrelation + phase search
 *   - musical key: Goertzel-filtered chroma + major/minor profile matching
 * Provenance is honest: rows persist `arena-js-dsp`, never the Python
 * engine's name. Values outside the documented ranges are stored null,
 * never invented.
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execTool } from "@workspace/arena/lib/waveyard/ffmpeg";

export { DESKTOP_ANALYSIS_ENGINE, DESKTOP_ANALYSIS_ENGINE_VERSION } from "../types/analysis-provenance";

export const ANALYSIS_PCM_RATE = 22_050; // mono analysis rate (enough to 10 kHz)

export type AnalysisResult = {
  bpm: number | null;
  bpmConfidence: number | null;
  musicalKey: string | null;
  keyConfidence: number | null;
  beatGridMs: number[] | null;
  beatConfidence: number | null;
};

const TEMPO_WINDOW_MS = 30_000;
const TEMPO_WINDOW_OVERLAP_MS = 15_000;
const TEMPO_WINDOW_AGREEMENT = 0.04;

export async function decodeMonoPcm(path: string, maxSeconds = 900): Promise<Float32Array> {
  const dir = await mkdtemp(join(tmpdir(), "arena-analysis-"));
  try {
    const pcmPath = join(dir, "mono.pcm");
    // -t bounds the decode so a corrupt file cannot balloon memory.
    await execTool("ffmpeg", ["-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", String(ANALYSIS_PCM_RATE), "-t", String(maxSeconds), "-f", "f32le", "-y", pcmPath]);
    const buffer = await readFile(pcmPath);
    const samples = new Float32Array(buffer.length / 4);
    for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readFloatLE(i * 4);
    return samples;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ONSET_WINDOW_SIZE = 512;
const ONSET_HOP_SIZE = 256;

function fftInPlace(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  let reversed = 0;
  for (let index = 1; index < size; index += 1) {
    let bit = size >> 1;
    while ((reversed & bit) !== 0) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
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
        const evenReal = real[even];
        const evenImaginary = imaginary[even];
        real[even] = evenReal + oddReal;
        imaginary[even] = evenImaginary + oddImaginary;
        real[odd] = evenReal - oddReal;
        imaginary[odd] = evenImaginary - oddImaginary;
        const nextTwiddleReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }
}

/**
 * Positive spectral flux over overlapping 512-sample Hann windows (11.6 ms
 * hop). RMS-only flux misses beat attacks when sustained and percussive parts
 * trade energy without changing the whole-frame loudness.
 */
export function onsetEnvelope(pcm: Float32Array): { envelope: Float32Array; frameMs: number } {
  const frameMs = (ONSET_HOP_SIZE / ANALYSIS_PCM_RATE) * 1000;
  const frameCount = Math.max(0, Math.floor((pcm.length - ONSET_WINDOW_SIZE) / ONSET_HOP_SIZE) + 1);
  const envelope = new Float32Array(Math.max(0, frameCount - 1));
  if (frameCount < 2) return { envelope, frameMs };

  const window = Float64Array.from({ length: ONSET_WINDOW_SIZE }, (_, index) =>
    0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (ONSET_WINDOW_SIZE - 1)),
  );
  const real = new Float64Array(ONSET_WINDOW_SIZE);
  const imaginary = new Float64Array(ONSET_WINDOW_SIZE);
  const previousMagnitudes = new Float64Array(ONSET_WINDOW_SIZE / 2 + 1);
  let previousTotal = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * ONSET_HOP_SIZE;
    for (let index = 0; index < ONSET_WINDOW_SIZE; index += 1) {
      real[index] = (pcm[start + index] ?? 0) * window[index];
      imaginary[index] = 0;
    }
    fftInPlace(real, imaginary);

    let total = 0;
    let positiveFlux = 0;
    for (let bin = 1; bin < ONSET_WINDOW_SIZE / 2; bin += 1) {
      const magnitude = Math.hypot(real[bin], imaginary[bin]);
      total += magnitude;
      if (frame > 0) positiveFlux += Math.max(0, magnitude - previousMagnitudes[bin]);
      previousMagnitudes[bin] = magnitude;
    }
    if (frame > 0) {
      const scale = (total + previousTotal) / 2;
      envelope[frame - 1] = scale > 1e-8 ? Math.min(1, positiveFlux / scale) : 0;
    }
    previousTotal = total;
  }
  return { envelope, frameMs };
}

/** BPM via autocorrelation of the onset envelope over 40–300 BPM. */
export function estimateBpm(envelope: Float32Array, frameMs: number): { bpm: number | null; confidence: number | null } {
  const minLag = Math.max(2, Math.floor(60_000 / 300 / frameMs));
  const maxLag = Math.min(envelope.length - 2, Math.ceil(60_000 / 40 / frameMs));
  // Need at least two full periods of the slowest candidate tempo.
  if (maxLag < minLag || envelope.length < maxLag * 2) return { bpm: null, confidence: null };
  let mean = 0;
  for (const value of envelope) mean += value;
  mean /= envelope.length;
  const centered = Float32Array.from(envelope, (value) => value - mean);
  let totalEnergy = 0;
  for (const value of centered) totalEnergy += value * value;
  if (totalEnergy <= 1e-12) return { bpm: null, confidence: null };

  type Candidate = { lag: number; score: number };
  const candidates: Candidate[] = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    for (let i = 0; i + lag < centered.length; i += 1) correlation += centered[i] * centered[i + lag];
    correlation /= totalEnergy;
    candidates.push({ lag, score: correlation });
  }
  // Local maxima only, then prefer plausible music tempi (70–180) gently.
  const peaks = candidates.filter((candidate, index) => {
    const previous = candidates[index - 1]?.score ?? -Infinity;
    const next = candidates[index + 1]?.score ?? -Infinity;
    return candidate.score > previous && candidate.score >= next && candidate.score > 0;
  });
  if (peaks.length === 0) return { bpm: null, confidence: null };
  const best = peaks
    .map((peak) => {
      const bpm = 60_000 / (peak.lag * frameMs);
      const plausibility = bpm >= 70 && bpm <= 180 ? 1.25 : 1; // gentle prior, not a clamp
      return { bpm, score: peak.score * plausibility };
    })
    .sort((left, right) => right.score - left.score)[0];
  const bpm = Math.round(best.bpm * 1000) / 1000;
  if (bpm < 40 || bpm > 300) return { bpm: null, confidence: null };
  const confidence = Math.max(0, Math.min(1, best.score));
  return { bpm, confidence: confidence < 0.05 ? null : Math.round(confidence * 1000) / 1000 };
}

function foldTempoForMixing(bpm: number): number | null {
  let folded = bpm;
  while (folded < 70 && folded <= 150) folded *= 2;
  while (folded > 180 && folded >= 80) folded /= 2;
  return folded >= 70 && folded <= 180 ? Math.round(folded * 1000) / 1000 : null;
}

/**
 * Aggregate local tempo readings instead of letting one autocorrelation peak
 * across an entire song dictate the session BPM. Half/double-time readings
 * are folded into the same DJ tempo range; readings that disagree reduce the
 * evidence score rather than being presented as a confident global tempo.
 */
export function estimateTrackTempo(
  envelope: Float32Array,
  frameMs: number,
): { bpm: number | null; confidence: number | null } {
  if (!Number.isFinite(frameMs) || frameMs <= 0 || envelope.length === 0) {
    return { bpm: null, confidence: null };
  }
  const windowFrames = Math.max(1, Math.round(TEMPO_WINDOW_MS / frameMs));
  if (envelope.length <= windowFrames) {
    const estimate = estimateBpm(envelope, frameMs);
    const bpm = estimate.bpm === null ? null : foldTempoForMixing(estimate.bpm);
    return { bpm, confidence: bpm === null ? null : estimate.confidence };
  }

  const stepFrames = Math.max(1, Math.round(TEMPO_WINDOW_OVERLAP_MS / frameMs));
  const starts: number[] = [];
  for (let start = 0; start + windowFrames <= envelope.length; start += stepFrames) starts.push(start);
  const finalStart = envelope.length - windowFrames;
  if (finalStart - (starts.at(-1) ?? 0) >= Math.floor(windowFrames / 2)) starts.push(finalStart);

  const readings = starts.flatMap((start) => {
    const estimate = estimateBpm(envelope.subarray(start, start + windowFrames), frameMs);
    if (estimate.bpm === null || estimate.confidence === null) return [];
    const bpm = foldTempoForMixing(estimate.bpm);
    return bpm === null ? [] : [{ bpm, confidence: estimate.confidence }];
  });
  if (readings.length === 0) return { bpm: null, confidence: null };

  const clusters = readings.map((seed) =>
    readings.filter((reading) => Math.abs(reading.bpm - seed.bpm) / seed.bpm <= TEMPO_WINDOW_AGREEMENT),
  );
  const cluster = clusters.sort((left, right) =>
    right.length - left.length
      || right.reduce((sum, reading) => sum + reading.confidence, 0)
        - left.reduce((sum, reading) => sum + reading.confidence, 0),
  )[0];
  const ordered = [...cluster].sort((left, right) => left.bpm - right.bpm);
  const weight = ordered.reduce((sum, reading) => sum + Math.max(0.01, reading.confidence), 0);
  let cumulativeWeight = 0;
  let bpm = ordered[0].bpm;
  for (const reading of ordered) {
    cumulativeWeight += Math.max(0.01, reading.confidence);
    if (cumulativeWeight >= weight / 2) {
      bpm = reading.bpm;
      break;
    }
  }
  const averageConfidence = cluster.reduce((sum, reading) => sum + reading.confidence, 0) / cluster.length;
  const support = cluster.length / readings.length;
  return {
    bpm: Math.round(bpm * 1000) / 1000,
    confidence: Math.round(Math.max(0, Math.min(1, averageConfidence * support)) * 1000) / 1000,
  };
}

/** Beat grid: phase of the envelope against the detected period. */
export function estimateBeatGrid(envelope: Float32Array, frameMs: number, bpm: number): { beatGridMs: number[] | null; confidence: number | null } {
  const periodFrames = 60_000 / bpm / frameMs;
  if (!Number.isFinite(periodFrames) || periodFrames < 2) return { beatGridMs: null, confidence: null };
  const phases = Math.max(1, Math.round(periodFrames));
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < phases; phase += 1) {
    let score = 0;
    for (let frame = phase; frame < envelope.length; frame += periodFrames) {
      const index = Math.round(frame);
      if (index < envelope.length) score += envelope[index];
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  const grid: number[] = [];
  for (let frame = bestPhase; frame < envelope.length; frame += periodFrames) {
    grid.push(Math.round(frame * frameMs));
  }
  if (grid.length < 2) return { beatGridMs: null, confidence: null };
  const strength =
    bestScore /
    Math.max(1e-9, grid.reduce((sum, _beat) => sum + 1, 0)) /
    Math.max(1e-9, Math.max(...envelope) || 1);
  const confidence = Math.max(0, Math.min(1, strength * 3));
  return { beatGridMs: grid, confidence: Math.round(confidence * 1000) / 1000 };
}

const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function midiOfPitchClassIndex(index: number, octave: number): number {
  return 12 * (octave + 1) + index;
}

/**
 * Harmonic salience chroma from overlapping long-window spectra.
 *
 * The former full-track Goertzel probe sampled only C3–B4 exact frequencies.
 * That misses bass fundamentals and lets one spectral bin dominate a whole
 * song. Here, frame-local harmonic stacks contribute to each candidate note,
 * then normalize per frame so a loud chorus cannot erase a quieter key change.
 */
export function chromaFromPcm(pcm: Float32Array): number[] {
  const chroma = new Array<number>(12).fill(0);
  if (pcm.length === 0) return chroma;

  const fftSize = 8192;
  // Key changes occur over musical phrases, so analyze about 2.7 frames/sec
  // rather than paying onset-detector rates for a much slower-changing signal.
  const hopSize = 8192;
  const minMidi = 36; // C2
  const maxMidi = 95; // B6
  const frameCount = pcm.length <= fftSize
    ? 1
    : Math.floor((pcm.length - fftSize) / hopSize) + 1;
  const window = Float64Array.from({ length: fftSize }, (_, index) =>
    0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1)),
  );
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const magnitudes = new Float64Array(fftSize / 2 + 1);
  let activeFrames = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = Math.min(frame * hopSize, Math.max(0, pcm.length - fftSize));
    for (let index = 0; index < fftSize; index += 1) {
      real[index] = (pcm[start + index] ?? 0) * window[index];
      imaginary[index] = 0;
    }
    fftInPlace(real, imaginary);

    let totalSpectrum = 0;
    for (let bin = 1; bin < fftSize / 2; bin += 1) {
      const magnitude = Math.hypot(real[bin], imaginary[bin]);
      magnitudes[bin] = magnitude;
      totalSpectrum += magnitude;
    }
    if (totalSpectrum <= 1e-8) continue;

    const frameChroma = new Array<number>(12).fill(0);
    for (let midi = minMidi; midi <= maxMidi; midi += 1) {
      const fundamentalHz = 440 * Math.pow(2, (midi - 69) / 12);
      let salience = 0;
      for (let harmonic = 1; harmonic <= 6; harmonic += 1) {
        const frequency = fundamentalHz * harmonic;
        if (frequency >= ANALYSIS_PCM_RATE / 2) break;
        const exactBin = (frequency * fftSize) / ANALYSIS_PCM_RATE;
        const lowerBin = Math.floor(exactBin);
        const upperBin = Math.min(fftSize / 2 - 1, lowerBin + 1);
        const fraction = exactBin - lowerBin;
        const magnitude = (magnitudes[lowerBin] ?? 0) * (1 - fraction)
          + (magnitudes[upperBin] ?? 0) * fraction;
        salience += magnitude / Math.sqrt(harmonic);
      }
      frameChroma[((midi % 12) + 12) % 12] += salience;
    }

    const frameTotal = frameChroma.reduce((sum, value) => sum + value, 0);
    if (frameTotal <= 1e-8) continue;
    for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
      chroma[pitchClass] += frameChroma[pitchClass] / frameTotal;
    }
    activeFrames += 1;
  }

  if (activeFrames > 0) {
    for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) chroma[pitchClass] /= activeFrames;
  }
  return chroma;
}

export function keyFromChroma(chroma: number[]): { key: string | null; confidence: number | null } {
  if (chroma.length !== 12 || chroma.some((value) => !Number.isFinite(value) || value < 0)) {
    return { key: null, confidence: null };
  }
  const total = chroma.reduce((sum, value) => sum + value, 0);
  if (total <= 1e-9) return { key: null, confidence: null };
  const normalised = chroma.map((value) => (value / total) * 12);
  const mean = normalised.reduce((sum, value) => sum + value, 0) / normalised.length;
  const centred = normalised.map((value) => value - mean);
  const chromaNorm = Math.sqrt(centred.reduce((sum, value) => sum + value * value, 0));
  if (chromaNorm <= 1e-9) return { key: null, confidence: null };

  const candidates: Array<{ name: string; score: number }> = [];
  for (let root = 0; root < 12; root += 1) {
    for (const mode of ["major", "minor"] as const) {
      const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
      const rotated = profile.map((_, pitchClass) => profile[(pitchClass - root + 12) % 12]);
      const profileMean = rotated.reduce((sum, value) => sum + value, 0) / rotated.length;
      const profileCentred = rotated.map((value) => value - profileMean);
      const profileNorm = Math.sqrt(profileCentred.reduce((sum, value) => sum + value * value, 0));
      const covariance = centred.reduce((sum, value, index) => sum + value * profileCentred[index], 0);
      candidates.push({
        name: `${PITCH_CLASSES[root]} ${mode}`,
        score: covariance / Math.max(1e-9, chromaNorm * profileNorm),
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  const runnerUp = candidates[1];
  if (!best || !runnerUp || best.score <= 0) return { key: null, confidence: null };

  // A high profile fit is not enough when several keys fit almost equally
  // well (for example, a single major triad). Confidence is an evidence index,
  // not a probability: profile fit × margin over the nearest competing key.
  const margin = Math.max(0, best.score - Math.max(0, runnerUp.score));
  const confidence = Math.max(0, Math.min(1, best.score * Math.min(1, margin / 0.2)));
  return {
    key: best.name,
    confidence: Math.round(confidence * 1000) / 1000,
  };
}

export function analysePcm(pcm: Float32Array): AnalysisResult {
  const { envelope, frameMs } = onsetEnvelope(pcm);
  const { bpm, confidence: bpmConfidence } = estimateTrackTempo(envelope, frameMs);
  let beatGridMs: number[] | null = null;
  let beatConfidence: number | null = null;
  if (bpm !== null) {
    const grid = estimateBeatGrid(envelope, frameMs, bpm);
    beatGridMs = grid.beatGridMs;
    beatConfidence = grid.confidence;
  }
  const { key, confidence: keyConfidence } = keyFromChroma(chromaFromPcm(pcm));
  return { bpm, bpmConfidence, musicalKey: key, keyConfidence, beatGridMs, beatConfidence };
}

export type LocalDrumTransient = {
  timestampMs: number;
  strength: number;
  confidence: number;
  rhythmicClass: null;
};

/** Detect measurable transients in the already-isolated drum/percussion stem.
 * This engine deliberately leaves semantic class null: spectral onsets alone
 * do not reliably distinguish kick, snare and hats across arbitrary mixes. */
export function detectDrumTransients(pcm: Float32Array): LocalDrumTransient[] {
  const { envelope, frameMs } = onsetEnvelope(pcm);
  if (envelope.length < 3) return [];
  let maximum = 0;
  let mean = 0;
  for (const value of envelope) { maximum = Math.max(maximum, value); mean += value; }
  mean /= envelope.length;
  if (maximum < 0.015) return [];
  const threshold = Math.max(mean * 1.8, maximum * 0.12, 0.025);
  const events: LocalDrumTransient[] = [];
  let lastFrame = -Infinity;
  const refractoryFrames = Math.max(1, Math.round(55 / frameMs));
  for (let frame = 1; frame < envelope.length - 1; frame += 1) {
    const value = envelope[frame] ?? 0;
    if (value < threshold || value < (envelope[frame - 1] ?? 0) || value <= (envelope[frame + 1] ?? 0)) continue;
    if (frame - lastFrame < refractoryFrames) continue;
    const left = envelope[Math.max(0, frame - 3)] ?? 0;
    const right = envelope[Math.min(envelope.length - 1, frame + 3)] ?? 0;
    const baseline = (left + right) / 2;
    const prominence = Math.max(0, value - baseline);
    if (prominence < threshold * 0.25) continue;
    events.push({
      timestampMs: Math.max(0, Math.round(frame * frameMs)),
      strength: Math.round(Math.max(0, Math.min(1, value / maximum)) * 1_000_000) / 1_000_000,
      confidence: Math.round(Math.max(0, Math.min(1, prominence / Math.max(value, 1e-9))) * 1_000_000) / 1_000_000,
      rhythmicClass: null,
    });
    lastFrame = frame;
  }
  return events;
}

export type LocalHarmonyEvent = {
  startMs: number;
  endMs: number;
  root: string | null;
  quality: "major" | "minor" | "dominant7" | "minor7" | "major7" | "diminished" | "augmented" | "unknown";
  confidence: number;
};

const CHORD_TEMPLATES: ReadonlyArray<{ quality: LocalHarmonyEvent["quality"]; intervals: readonly number[] }> = [
  { quality: "major", intervals: [0, 4, 7] },
  { quality: "minor", intervals: [0, 3, 7] },
  { quality: "dominant7", intervals: [0, 4, 7, 10] },
  { quality: "minor7", intervals: [0, 3, 7, 10] },
  { quality: "major7", intervals: [0, 4, 7, 11] },
  { quality: "diminished", intervals: [0, 3, 6] },
  { quality: "augmented", intervals: [0, 4, 8] },
];

/** Conservative, source-relative chord windows using the same harmonic
 * salience chroma as the local BPM/key engine. Weak/ambiguous windows remain
 * explicitly unknown. */
export function detectHarmonyTimeline(pcm: Float32Array, windowSeconds = 2): LocalHarmonyEvent[] {
  if (pcm.length === 0 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 8) return [];
  const durationMs = Math.round((pcm.length / ANALYSIS_PCM_RATE) * 1000);
  const windowSamples = windowSeconds * ANALYSIS_PCM_RATE;
  const events: LocalHarmonyEvent[] = [];
  for (let start = 0; start < pcm.length; start += windowSamples) {
    const end = Math.min(pcm.length, start + windowSamples);
    const chroma = chromaFromPcm(pcm.subarray(start, end));
    const total = chroma.reduce((sum, value) => sum + value, 0);
    let best: { root: number; quality: LocalHarmonyEvent["quality"]; score: number } | null = null;
    let runner = 0;
    if (total > 1e-8) {
      const normalized = chroma.map((value) => value / total);
      for (let root = 0; root < 12; root += 1) {
        for (const template of CHORD_TEMPLATES) {
          let score = 0;
          for (let pitch = 0; pitch < 12; pitch += 1) {
            const interval = (pitch - root + 12) % 12;
            const weight = template.intervals.includes(interval) ? 1 : 0.08;
            score += normalized[pitch] * weight;
          }
          if (!best || score > best.score) {
            runner = best?.score ?? 0;
            best = { root, quality: template.quality, score };
          } else if (score > runner) runner = score;
        }
      }
    }
    const margin = best ? Math.max(0, (best.score - runner) / Math.max(best.score, 1e-9)) : 0;
    const confident = best !== null && best.score >= 0.28 && margin >= 0.04;
    const startMs = Math.round((start / ANALYSIS_PCM_RATE) * 1000);
    const endMs = Math.min(durationMs, Math.round((end / ANALYSIS_PCM_RATE) * 1000));
    if (endMs > startMs) events.push({
      startMs,
      endMs,
      root: confident && best ? PITCH_CLASSES[best.root]! : null,
      quality: confident && best ? best.quality : "unknown",
      confidence: Math.round((confident ? Math.min(1, margin) : Math.max(0, Math.min(1, best?.score ?? 0))) * 1_000_000) / 1_000_000,
    });
  }
  return events;
}

export type LocalVocalPitchFrame = {
  timestampMs: number;
  frequencyHz: number | null;
  midiFloat: number | null;
  nearestMidiNote: number | null;
  confidence: number;
  voiced: boolean;
};

/** Monophonic YIN-style pitch observations on isolated vocal stems. It emits
 * null pitch for unvoiced/ambiguous frames; it never guesses through silence. */
export function detectVocalPitchFrames(pcm: Float32Array): LocalVocalPitchFrame[] {
  const decimation = 4;
  const rate = ANALYSIS_PCM_RATE / decimation;
  const windowSize = Math.round(rate * 0.06);
  const hopSize = Math.round(rate * 0.03);
  const minLag = Math.floor(rate / 1_200);
  const maxLag = Math.floor(rate / 50);
  if (pcm.length < windowSize * decimation) return [];
  const frames: LocalVocalPitchFrame[] = [];
  const signal = new Float32Array(windowSize);
  for (let start = 0; start + (windowSize - 1) * decimation < pcm.length; start += hopSize * decimation) {
    let energy = 0;
    for (let index = 0; index < windowSize; index += 1) {
      const sample = pcm[start + index * decimation] ?? 0;
      signal[index] = sample;
      energy += sample * sample;
    }
    const timestampMs = Math.round(((start + (windowSize * decimation) / 2) / ANALYSIS_PCM_RATE) * 1000);
    if (energy / windowSize < 1e-5) {
      frames.push({ timestampMs, frequencyHz: null, midiFloat: null, nearestMidiNote: null, confidence: 0, voiced: false });
      continue;
    }
    const max = Math.min(maxLag, Math.floor(windowSize / 2));
    const differences = new Float64Array(max + 1);
    for (let lag = minLag; lag <= max; lag += 1) {
      let difference = 0;
      for (let index = 0; index + lag < windowSize; index += 1) {
        const delta = signal[index] - signal[index + lag];
        difference += delta * delta;
      }
      differences[lag] = difference;
    }
    let running = 0;
    let bestLag = -1;
    let bestValue = Number.POSITIVE_INFINITY;
    let previousNormalized = Number.POSITIVE_INFINITY;
    for (let lag = minLag; lag <= max; lag += 1) {
      running += differences[lag] ?? 0;
      const normalized = running > 0 ? ((differences[lag] ?? 0) * (lag - minLag + 1)) / running : 1;
      if (normalized < bestValue) { bestValue = normalized; bestLag = lag; }
      if (lag > minLag && normalized < 0.16 && normalized >= previousNormalized) {
        // The first CMND valley is the fundamental period. Searching the
        // global minimum biases toward octave/subharmonic multiples.
        bestLag = lag - 1;
        bestValue = previousNormalized;
        break;
      }
      previousNormalized = normalized;
      if (lag === max && normalized < 0.16) {
        bestLag = lag;
        bestValue = normalized;
      }
    }
    if (bestLag < 0 || bestValue > 0.24) {
      frames.push({ timestampMs, frequencyHz: null, midiFloat: null, nearestMidiNote: null, confidence: 0, voiced: false });
      continue;
    }
    const frequencyHz = rate / bestLag;
    const midiFloat = 69 + 12 * Math.log2(frequencyHz / 440);
    const confidence = Math.max(0, Math.min(1, 1 - bestValue));
    if (frequencyHz < 50 || frequencyHz > 1_200 || !Number.isFinite(midiFloat)) {
      frames.push({ timestampMs, frequencyHz: null, midiFloat: null, nearestMidiNote: null, confidence: 0, voiced: false });
    } else {
      frames.push({ timestampMs, frequencyHz, midiFloat, nearestMidiNote: Math.round(midiFloat), confidence, voiced: true });
    }
  }
  return frames;
}

/** Beat positions are canonical source milliseconds and must be strictly ordered. (worker port) */
export function normaliseBeatGrid(value: unknown, durationSeconds: number): number[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length < 2 || value.length > 100_000) return null;
  const maximum = Math.max(1, Math.round(durationSeconds * 1000));
  const grid = value.map((position) => (typeof position === "number" && Number.isFinite(position) ? Math.round(position) : Number.NaN));
  if (grid.some((position, index) => !Number.isInteger(position) || position < 0 || position > maximum || (index > 0 && position <= grid[index - 1]))) return null;
  return grid;
}

function normaliseConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

/** Combine tempo evidence with the measured audio-to-grid phase fit. */
export function beatConfidenceFromGrid(
  bpmConfidence: number | null,
  beatGridMs: number[],
  alignmentConfidence: number | null,
): number | null {
  if (beatGridMs.length < 3) return 0;
  if (alignmentConfidence === null || !Number.isFinite(alignmentConfidence)) return null;
  const tempoEvidence = Math.max(0, Math.min(1, bpmConfidence ?? 0));
  const gridEvidence = Math.max(0, Math.min(1, alignmentConfidence));
  return normaliseConfidence(0.55 * tempoEvidence + 0.45 * gridEvidence);
}
