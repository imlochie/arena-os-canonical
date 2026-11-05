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

const ANALYSIS_PCM_RATE = 22_050; // mono analysis rate (enough to 10 kHz)

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

/** Onset envelope: half-wave-rectified energy flux over ~11.6 ms frames. */
export function onsetEnvelope(pcm: Float32Array): { envelope: Float32Array; frameMs: number } {
  const frameSize = 256; // 22050/256 ≈ 11.6 ms
  const frames = Math.floor(pcm.length / frameSize);
  const envelope = new Float32Array(Math.max(0, frames - 1));
  const frameMs = (frameSize / ANALYSIS_PCM_RATE) * 1000;
  let previousEnergy = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let energy = 0;
    const start = frame * frameSize;
    for (let i = 0; i < frameSize; i += 1) {
      const sample = pcm[start + i];
      energy += sample * sample;
    }
    energy = Math.sqrt(energy / frameSize);
    if (frame > 0) envelope[frame - 1] = Math.max(0, energy - previousEnergy);
    previousEnergy = energy;
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

/** Chroma via Goertzel filters over C3–B4 (the musically dense octaves). */
export function chromaFromPcm(pcm: Float32Array): number[] {
  const chroma = new Array<number>(12).fill(0);
  const n = pcm.length;
  if (n === 0) return chroma;
  for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
    let magnitude = 0;
    for (const octave of [3, 4]) {
      const midi = midiOfPitchClassIndex(pitchClass, octave);
      const frequency = 440 * Math.pow(2, (midi - 69) / 12);
      if (frequency > ANALYSIS_PCM_RATE / 2) continue;
      const k = Math.round((n * frequency) / ANALYSIS_PCM_RATE);
      const w = (2 * Math.PI * k) / n;
      const coeff = 2 * Math.cos(w);
      let s0 = 0, s1 = 0, s2 = 0;
      for (let i = 0; i < n; i += 1) {
        s0 = pcm[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      magnitude += Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
    }
    chroma[pitchClass] = magnitude;
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
