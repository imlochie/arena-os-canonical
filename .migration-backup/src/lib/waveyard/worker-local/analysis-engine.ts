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

import { execTool } from "@/lib/waveyard/ffmpeg";

export const DESKTOP_ANALYSIS_ENGINE = "arena-js-dsp";
export const DESKTOP_ANALYSIS_ENGINE_VERSION = "1.0.0";

const ANALYSIS_PCM_RATE = 22_050; // mono analysis rate (enough to 10 kHz)

export type AnalysisResult = {
  bpm: number | null;
  bpmConfidence: number | null;
  musicalKey: string | null;
  keyConfidence: number | null;
  beatGridMs: number[] | null;
  beatConfidence: number | null;
};

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
  const total = chroma.reduce((sum, value) => sum + value, 0);
  if (total <= 1e-9) return { key: null, confidence: null };
  const normalised = chroma.map((value) => (value / total) * 12);
  let best: { name: string; score: number } | null = null;
  for (let root = 0; root < 12; root += 1) {
    for (const mode of ["major", "minor"] as const) {
      const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
      let score = 0;
      for (let interval = 0; interval < 12; interval += 1) {
        score += normalised[(root + interval) % 12] * profile[interval];
      }
      if (best === null || score > best.score) {
        best = { name: `${PITCH_CLASSES[root]} ${mode}`, score };
      }
    }
  }
  if (best === null) return { key: null, confidence: null };
  const scorePerBin = best.score / 12; // theoretical max ≈ max(profile) ≈ 6.35
  const confidence = Math.max(0, Math.min(1, scorePerBin / 4.2));
  return { key: best.name, confidence: Math.round(confidence * 1000) / 1000 };
}

export function analysePcm(pcm: Float32Array): AnalysisResult {
  const { envelope, frameMs } = onsetEnvelope(pcm);
  const { bpm, confidence: bpmConfidence } = estimateBpm(envelope, frameMs);
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

/** 55% BPM confidence plus 45% regularity of ordered source beat timing. (worker port) */
export function beatConfidenceFromGrid(bpmConfidence: number | null, beatGridMs: number[]): number | null {
  if (beatGridMs.length < 3) return 0;
  const intervals = beatGridMs.slice(1).map((value, index) => value - beatGridMs[index]);
  const mean = intervals.reduce((total, value) => total + value, 0) / intervals.length;
  if (mean <= 0) return 0;
  const variance = intervals.reduce((total, value) => total + (value - mean) ** 2, 0) / intervals.length;
  const regularity = Math.max(0, Math.min(1, 1 - (4 * Math.sqrt(variance)) / mean));
  return normaliseConfidence(0.55 * Math.max(0, Math.min(1, bpmConfidence ?? 0)) + 0.45 * regularity);
}
