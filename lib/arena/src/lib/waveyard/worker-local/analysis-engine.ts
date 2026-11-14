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
import { HARMONY_CHORD_TEMPLATES, HARMONY_TEMPLATE_MIN_MARGIN } from "../types/harmony-analysis";
import type { VocalActivityInterval } from "../types/vocal-analysis";
import { SESSION_MIN_DOWNBEAT_CONFIDENCE } from "../session-dj-controls";

export { DESKTOP_ANALYSIS_ENGINE, DESKTOP_ANALYSIS_ENGINE_VERSION } from "../types/analysis-provenance";

export const ANALYSIS_PCM_RATE = 22_050; // mono analysis rate (enough to 10 kHz)

export type AnalysisResult = {
  bpm: number | null;
  bpmConfidence: number | null;
  /**
   * Plausible tempi in the same pulse family as `bpm`, strongest first, each in
   * 40-300 BPM. A hats-heavy part can read one octave high with high
   * confidence, so `bpm` alone is not enough to decide how hard a vocal must be
   * stretched. Consumers that warp audio should prefer the candidate that costs
   * the least stretch instead of trusting `bpm` verbatim.
   */
  bpmCandidates: number[] | null;
  musicalKey: string | null;
  keyConfidence: number | null;
  beatGridMs: number[] | null;
  beatConfidence: number | null;
  downbeatGridMs: number[] | null;
  downbeatConfidence: number | null;
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
export function onsetEnvelope(
  pcm: Float32Array,
  options?: {
    frequencyBandHz?: { minHz: number; maxHz: number };
    minBandEnergyFraction?: number;
  },
): { envelope: Float32Array; frameMs: number } {
  const frameMs = (ONSET_HOP_SIZE / ANALYSIS_PCM_RATE) * 1000;
  const frameCount = Math.max(0, Math.floor((pcm.length - ONSET_WINDOW_SIZE) / ONSET_HOP_SIZE) + 1);
  const envelope = new Float32Array(frameCount);
  if (frameCount < 2) return { envelope, frameMs };
  const binWidthHz = ANALYSIS_PCM_RATE / ONSET_WINDOW_SIZE;
  const frequencyBandHz = options?.frequencyBandHz;
  const minBandEnergyFraction = options?.minBandEnergyFraction ?? 0;
  const minBin = frequencyBandHz ? Math.max(1, Math.floor(frequencyBandHz.minHz / binWidthHz)) : 1;
  const maxBin = frequencyBandHz
    ? Math.min(ONSET_WINDOW_SIZE / 2 - 1, Math.ceil(frequencyBandHz.maxHz / binWidthHz))
    : ONSET_WINDOW_SIZE / 2 - 1;
  if (
    frequencyBandHz
    && (!Number.isFinite(frequencyBandHz.minHz)
      || !Number.isFinite(frequencyBandHz.maxHz)
      || frequencyBandHz.minHz < 0
      || frequencyBandHz.maxHz <= frequencyBandHz.minHz
      || maxBin < minBin
      || !Number.isFinite(minBandEnergyFraction)
      || minBandEnergyFraction < 0
      || minBandEnergyFraction > 1)
  ) return { envelope, frameMs };

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
    let broadbandTotal = 0;
    let positiveFlux = 0;
    for (let bin = 1; bin < ONSET_WINDOW_SIZE / 2; bin += 1) {
      const magnitude = Math.hypot(real[bin], imaginary[bin]);
      broadbandTotal += magnitude;
      if (bin >= minBin && bin <= maxBin) {
        total += magnitude;
        positiveFlux += Math.max(0, magnitude - previousMagnitudes[bin]);
      }
      previousMagnitudes[bin] = magnitude;
    }
    const scale = frame === 0 ? total : (total + previousTotal) / 2;
    const energyFraction = broadbandTotal > 1e-8 ? total / broadbandTotal : 0;
    envelope[frame] = scale > 1e-8 && energyFraction >= minBandEnergyFraction
      ? Math.min(1, positiveFlux / scale)
      : 0;
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

/**
 * Plausible tempi in the same pulse family as `bpm`, strongest first.
 *
 * The detector picks the strongest autocorrelation peak, and a part with loud
 * off-beat hats or a busy subdivision can score higher at twice the musical
 * tempo. That is a genuine ambiguity: at 72 BPM with 8th-note hats every
 * position of both the 72 and the 143.5 BPM grid lands on an onset, so the
 * envelope cannot say which one is the beat. Rather than pretend one is right,
 * report the family and let the caller pick the computationally cheapest
 * interpretation. `bpm` always stays first so existing behaviour is preserved.
 */
export function tempoCandidates(bpm: number | null): number[] | null {
  if (bpm === null || !Number.isFinite(bpm) || bpm <= 0) return null;
  const family: number[] = [];
  for (const multiplier of [1, 0.5, 2, 0.25, 4]) {
    const candidate = Math.round(bpm * multiplier * 1000) / 1000;
    if (candidate < 40 || candidate > 300) continue;
    if (family.some((existing) => Math.abs(existing - candidate) <= 0.5)) continue;
    family.push(candidate);
  }
  return family.length > 0 ? family : null;
}

/** Beat grid: phase of the envelope against the detected period. */
export function estimateBeatGrid(envelope: Float32Array, frameMs: number, bpm: number): { beatGridMs: number[] | null; confidence: number | null } {
  const periodFrames = 60_000 / bpm / frameMs;
  if (!Number.isFinite(periodFrames) || periodFrames < 2) return { beatGridMs: null, confidence: null };
  let envelopePeak = 0;
  for (const value of envelope) envelopePeak = Math.max(envelopePeak, value);
  const phases = Math.max(1, Math.round(periodFrames));
  const phaseLookaheadFrames = Math.min(envelope.length, Math.ceil(periodFrames * 8));
  let bestPhase = 0;
  let bestScore = -Infinity;
  let bestPhaseSamples = 0;
  for (let phase = 0; phase < phases; phase += 1) {
    let score = 0;
    let sampleCount = 0;
    for (let frame = phase; frame < phaseLookaheadFrames; frame += periodFrames) {
      const index = Math.round(frame);
      if (index < envelope.length) {
        score += envelope[index] ?? 0;
        sampleCount += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
      bestPhaseSamples = sampleCount;
    }
  }

  // The first spectral-flux frame has no previous audio frame to compare with.
  // If it contains an attack and another attack follows one beat later, use
  // that directly observed start instead of allowing a long-track phase fit to
  // skip the opening beat.
  const searchRadiusFrames = Math.max(1, Math.min(
    Math.round(periodFrames * 0.16),
    Math.round(80 / frameMs),
  ));
  const peakInRange = (from: number, to: number): { frame: number; value: number } => {
    let frame = Math.max(0, from);
    const end = Math.min(envelope.length - 1, to);
    for (let index = frame + 1; index <= end; index += 1) {
      if ((envelope[index] ?? 0) > (envelope[frame] ?? 0)) frame = index;
    }
    return { frame, value: envelope[frame] ?? 0 };
  };
  const firstAttack = peakInRange(0, searchRadiusFrames);
  const nextExpected = firstAttack.frame + periodFrames;
  const nextAttack = peakInRange(
    Math.floor(nextExpected - searchRadiusFrames),
    Math.ceil(nextExpected + searchRadiusFrames),
  );
  if (
    envelopePeak > 0
    && firstAttack.value >= envelopePeak * 0.15
    && nextAttack.value >= envelopePeak * 0.15
  ) bestPhase = firstAttack.frame;

  // Follow nearby attacks instead of projecting one perfectly even grid over
  // the whole song. The bounded phase/period loop tracks small performance
  // drift while refusing to jump to a syncopated hit far from the pulse.
  const phaseCorrection = 0.25;
  const periodCorrection = 0.02;
  let predictedFrame = bestPhase;
  let trackedPeriodFrames = periodFrames;
  let strongPeakCount = 0;
  let absoluteCorrection = 0;
  let normalizedPeakStrength = 0;
  const grid: number[] = [];
  while (predictedFrame < envelope.length) {
    const expected = predictedFrame;
    const from = Math.max(0, Math.floor(expected - searchRadiusFrames));
    const to = Math.min(envelope.length - 1, Math.ceil(expected + searchRadiusFrames));
    let localMean = 0;
    let peakFrame = from;
    for (let frame = from; frame <= to; frame += 1) {
      localMean += envelope[frame] ?? 0;
      if ((envelope[frame] ?? 0) > (envelope[peakFrame] ?? 0)) peakFrame = frame;
    }
    localMean /= Math.max(1, to - from + 1);
    const peakValue = envelope[peakFrame] ?? 0;
    const hasLocalAttack = peakValue > 1e-9 && peakValue >= localMean * 1.25;
    const correction = hasLocalAttack ? peakFrame - expected : 0;
    const beatFrame = hasLocalAttack ? peakFrame : expected;
    const beatMs = Math.round(beatFrame * frameMs);
    if (grid.length === 0 || beatMs > grid[grid.length - 1]!) {
      grid.push(beatMs);
      if (hasLocalAttack) {
        strongPeakCount += 1;
        absoluteCorrection += Math.abs(correction);
        normalizedPeakStrength += envelopePeak > 0 ? peakValue / envelopePeak : 0;
      }
    }

    trackedPeriodFrames = Math.max(
      periodFrames * 0.85,
      Math.min(periodFrames * 1.15, trackedPeriodFrames + correction * periodCorrection),
    );
    predictedFrame = expected + trackedPeriodFrames + correction * phaseCorrection;
  }
  if (grid.length < 2) return { beatGridMs: null, confidence: null };
  const phaseStrength =
    bestScore /
    Math.max(1, bestPhaseSamples) /
    Math.max(1e-9, envelopePeak || 1);
  const peakCoverage = strongPeakCount / grid.length;
  const meanPeakStrength = strongPeakCount > 0 ? normalizedPeakStrength / strongPeakCount : 0;
  const meanCorrection = strongPeakCount > 0 ? absoluteCorrection / strongPeakCount : searchRadiusFrames;
  const trackingEvidence = peakCoverage
    * meanPeakStrength
    * Math.max(0, 1 - meanCorrection / Math.max(1, searchRadiusFrames));
  const confidence = Math.max(0, Math.min(1, phaseStrength * 3 * (0.5 + 0.5 * trackingEvidence)));
  return { beatGridMs: grid, confidence: Math.round(confidence * 1000) / 1000 };
}

export type DownbeatGridEstimate = {
  downbeatGridMs: number[] | null;
  downbeatConfidence: number | null;
};

/**
 * Infer a repeating four-beat accent phase only when the measured beat
 * envelope supports one stable phase. This is rhythm evidence, not a semantic
 * meter classifier. Uniform pulses, short tracks, unstable phases, and weak
 * beat grids remain unavailable; BPM alone never labels a downbeat.
 */
export function estimateDownbeatGrid(
  envelope: Float32Array,
  frameMs: number,
  beatGridMs: readonly number[] | null,
  beatConfidence: number | null,
): DownbeatGridEstimate {
  const beatsPerBar = 4;
  const confirmationBars = 4;
  const confirmationBeats = beatsPerBar * confirmationBars;
  if (
    !Number.isFinite(frameMs) || frameMs <= 0
    || !beatGridMs || beatGridMs.length < confirmationBeats + 1
    || beatGridMs.some((beat, index) =>
      !Number.isSafeInteger(beat) || beat < 0 || (index > 0 && beat <= beatGridMs[index - 1]!))
    || typeof beatConfidence !== "number" || !Number.isFinite(beatConfidence)
    || beatConfidence < 0.5 || beatConfidence > 1
  ) return { downbeatGridMs: null, downbeatConfidence: null };

  let envelopePeak = 0;
  for (const value of envelope) {
    if (Number.isFinite(value)) envelopePeak = Math.max(envelopePeak, value);
  }
  if (envelopePeak <= 1e-9) return { downbeatGridMs: null, downbeatConfidence: 0 };

  const radiusFrames = Math.max(1, Math.ceil(45 / frameMs));
  const beatStrengths = beatGridMs.map((beatMs) => {
    const center = Math.round(beatMs / frameMs);
    let strength = 0;
    for (
      let frame = Math.max(0, center - radiusFrames);
      frame <= Math.min(envelope.length - 1, center + radiusFrames);
      frame += 1
    ) {
      const value = envelope[frame] ?? 0;
      if (Number.isFinite(value)) strength = Math.max(strength, value);
    }
    return strength;
  });

  const windows: Array<{ phase: number; confidence: number }> = [];
  for (let start = 0; start + confirmationBeats < beatStrengths.length; start += beatsPerBar) {
    const phaseStrengths = Array.from({ length: beatsPerBar }, (_, phase) =>
      Array.from({ length: confirmationBars }, (_, bar) => beatStrengths[start + bar * beatsPerBar + phase] ?? 0),
    );
    const median = (values: number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const ranked = phaseStrengths
      .map((values, phase) => ({ phase, strength: median(values) }))
      .sort((left, right) => right.strength - left.strength);
    const strongest = ranked[0];
    const runnerUp = ranked[1];
    if (!strongest || !runnerUp || strongest.strength <= envelopePeak * 0.08) {
      windows.push({ phase: strongest?.phase ?? 0, confidence: 0 });
      continue;
    }
    const contrast = Math.max(0, (strongest.strength - runnerUp.strength) / strongest.strength);
    const supportedBars = phaseStrengths[strongest.phase]!.filter((accent, bar) => {
      const otherStrengths = phaseStrengths
        .filter((_, phase) => phase !== strongest.phase)
        .map((values) => values[bar] ?? 0);
      const localMedian = median(otherStrengths);
      return accent >= envelopePeak * 0.08 && accent >= localMedian * 1.2;
    }).length;
    const support = supportedBars / confirmationBars;
    const confidence = Math.max(0, Math.min(1, contrast * support * beatConfidence));
    windows.push({ phase: strongest.phase, confidence });
  }
  if (windows.length === 0) return { downbeatGridMs: null, downbeatConfidence: null };

  const phaseCounts = Array.from({ length: beatsPerBar }, (_, phase) =>
    windows.filter((window) => window.phase === phase && window.confidence >= SESSION_MIN_DOWNBEAT_CONFIDENCE).length,
  );
  const bestPhase = phaseCounts.indexOf(Math.max(...phaseCounts));
  const accepted = windows.filter((window) => window.confidence >= SESSION_MIN_DOWNBEAT_CONFIDENCE);
  const matching = accepted.filter((window) => window.phase === bestPhase);
  const phaseAgreement = accepted.length > 0 ? matching.length / accepted.length : 0;
  const meanConfidence = matching.length > 0
    ? matching.reduce((sum, window) => sum + window.confidence, 0) / matching.length
    : windows.reduce((sum, window) => sum + window.confidence, 0) / windows.length;
  const weakestWindowConfidence = Math.min(...windows.map((window) => window.confidence));
  const confidence = Math.round(Math.min(meanConfidence * phaseAgreement, weakestWindowConfidence) * 1000) / 1000;
  if (
    matching.length === 0
    || accepted.length !== windows.length
    || phaseAgreement < 1
    || confidence < SESSION_MIN_DOWNBEAT_CONFIDENCE
  ) return { downbeatGridMs: null, downbeatConfidence: confidence };

  const lastConfirmedBeat = Math.min(
    beatGridMs.length - 1,
    (windows.length - 1) * beatsPerBar + confirmationBeats - 1,
  );
  const downbeatGridMs = beatGridMs.filter((_, index) =>
    index <= lastConfirmedBeat && index % beatsPerBar === bestPhase,
  );
  return downbeatGridMs.length >= 2
    ? { downbeatGridMs, downbeatConfidence: confidence }
    : { downbeatGridMs: null, downbeatConfidence: confidence };
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
  const downbeats = estimateDownbeatGrid(envelope, frameMs, beatGridMs, beatConfidence);
  const { key, confidence: keyConfidence } = keyFromChroma(chromaFromPcm(pcm));
  return {
    bpm, bpmConfidence, bpmCandidates: tempoCandidates(bpm), musicalKey: key, keyConfidence, beatGridMs, beatConfidence,
    downbeatGridMs: downbeats.downbeatGridMs,
    downbeatConfidence: downbeats.downbeatConfidence,
  };
}

export type LocalDrumTransient = {
  timestampMs: number;
  strength: number;
  confidence: number;
  rhythmicClass: null;
};

export type LocalBassAttack = {
  timestampMs: number;
  strength: number;
  confidence: number;
};

/**
 * Detect transient evidence in an onset envelope. Strength is relative to this
 * file's strongest event; confidence is a local prominence measure, not a
 * probability or instrument classifier.
 */
function transientEventsFromEnvelope(
  envelope: Float32Array,
  frameMs: number,
): LocalDrumTransient[] {
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

/** Detect measurable transients in an isolated drum/percussion stem.
 * Spectral onsets alone do not reliably distinguish kick, snare and hats. */
export function detectDrumTransients(pcm: Float32Array): LocalDrumTransient[] {
  const { envelope, frameMs } = onsetEnvelope(pcm);
  return transientEventsFromEnvelope(envelope, frameMs);
}

/**
 * Detect low-band attacks from an isolated bass stem. These are not note or
 * pitch labels: they mark measured spectral changes between 35 and 250 Hz.
 */
export function detectBassAttacks(pcm: Float32Array): LocalBassAttack[] {
  const { envelope, frameMs } = onsetEnvelope(pcm, {
    frequencyBandHz: { minHz: 35, maxHz: 250 },
    minBandEnergyFraction: 0.04,
  });
  return transientEventsFromEnvelope(envelope, frameMs);
}

export type LocalHarmonyEvent = {
  startMs: number;
  endMs: number;
  root: string | null;
  quality: "major" | "minor" | "dominant7" | "minor7" | "major7" | "diminished" | "augmented" | "unknown";
  /** Top-two chord-template score margin; deliberately not called a probability. */
  confidence: number;
};

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
        for (const template of HARMONY_CHORD_TEMPLATES) {
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
    const confident = best !== null && best.score >= 0.28 && margin >= HARMONY_TEMPLATE_MIN_MARGIN;
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
    // CMND needs the sum from lag 1, including periods outside the search
    // range. Use equal support for every lag, not a shrinking comparison.
    for (let lag = 1; lag <= max; lag += 1) {
      let difference = 0;
      for (let index = 0; index < windowSize - max; index += 1) {
        const delta = signal[index] - signal[index + lag];
        difference += delta * delta;
      }
      differences[lag] = difference;
    }
    let running = 0;
    const normalizedDifferences = new Float64Array(max + 1);
    for (let lag = 1; lag <= max; lag += 1) {
      running += differences[lag]!;
      normalizedDifferences[lag] = running > 0 ? differences[lag]! * lag / running : 1;
    }
    let bestLag = -1;
    let bestValue = Number.POSITIVE_INFINITY;
    let previousNormalized = Number.POSITIVE_INFINITY;
    for (let lag = minLag; lag <= max; lag += 1) {
      const normalized = normalizedDifferences[lag]!;
      if (normalized < bestValue) { bestValue = normalized; bestLag = lag; }
      if (lag > minLag && previousNormalized < 0.16 && normalized >= previousNormalized) {
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
    // Integer-lag estimates quantize higher sung notes by tens of cents.
    // Interpolate the accepted valley without relaxing voiced confidence.
    let period = bestLag;
    if (bestLag > 1 && bestLag < max) {
      const left = normalizedDifferences[bestLag - 1]!;
      const middle = normalizedDifferences[bestLag]!;
      const right = normalizedDifferences[bestLag + 1]!;
      const curvature = left - 2 * middle + right;
      if (curvature > 1e-12) period += Math.max(-0.5, Math.min(0.5, (left - right) / (2 * curvature)));
    }
    const frequencyHz = rate / period;
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

export type LocalVocalActivityInterval = VocalActivityInterval;

/**
 * Finds coarse activity passages from the isolated vocal stem independently
 * of monophonic pitch. Adaptive hysteresis handles speech, breathy/unvoiced
 * consonants, and separated vocals that do not produce a stable YIN pitch.
 * These are activity intervals, not word or lyric boundaries.
 */
export function detectVocalActivityIntervals(
  pcm: Float32Array,
  pitchFrames: readonly LocalVocalPitchFrame[] = [],
): LocalVocalActivityInterval[] {
  const windowSamples = Math.round(ANALYSIS_PCM_RATE * 0.03);
  const hopSamples = Math.round(ANALYSIS_PCM_RATE * 0.01);
  const minimumDurationMs = 120;
  const silenceGapMs = 260;
  if (pcm.length < windowSamples || pcm.some((sample) => !Number.isFinite(sample))) return [];

  const energyFrames: Array<{ startMs: number; endMs: number; levelDb: number }> = [];
  for (let startSample = 0; startSample + windowSamples <= pcm.length; startSample += hopSamples) {
    let squaredEnergy = 0;
    for (let sampleIndex = startSample; sampleIndex < startSample + windowSamples; sampleIndex += 1) {
      const sample = pcm[sampleIndex]!;
      squaredEnergy += sample * sample;
    }
    const rms = Math.sqrt(squaredEnergy / windowSamples);
    energyFrames.push({
      startMs: Math.round(startSample * 1000 / ANALYSIS_PCM_RATE),
      endMs: Math.round((startSample + windowSamples) * 1000 / ANALYSIS_PCM_RATE),
      levelDb: 20 * Math.log10(Math.max(rms, 1e-6)),
    });
  }
  if (energyFrames.length < 10) return [];

  const sortedLevels = energyFrames.map((frame) => frame.levelDb).sort((left, right) => left - right);
  const percentile = (fraction: number) => sortedLevels[Math.floor((sortedLevels.length - 1) * fraction)]!;
  const noiseFloorDb = percentile(0.2);
  const activeReferenceDb = percentile(0.75);
  const dynamicRangeDb = activeReferenceDb - noiseFloorDb;
  if (!Number.isFinite(dynamicRangeDb) || dynamicRangeDb < 12) return [];

  const openThresholdDb = noiseFloorDb + dynamicRangeDb * 0.62;
  const closeThresholdDb = noiseFloorDb + dynamicRangeDb * 0.4;
  const rawIntervals: Array<{ startMs: number; endMs: number }> = [];
  let startMs: number | null = null;
  let lastActiveEndMs = 0;
  const finish = () => {
    if (startMs !== null && lastActiveEndMs > startMs) rawIntervals.push({ startMs, endMs: lastActiveEndMs });
    startMs = null;
    lastActiveEndMs = 0;
  };

  for (const frame of energyFrames) {
    if (startMs === null) {
      if (frame.levelDb >= openThresholdDb) {
        startMs = frame.startMs;
        lastActiveEndMs = frame.endMs;
      }
      continue;
    }
    if (frame.levelDb >= closeThresholdDb) lastActiveEndMs = frame.endMs;
    else finish();
  }
  finish();

  const mergedIntervals: Array<{ startMs: number; endMs: number }> = [];
  for (const interval of rawIntervals) {
    const previous = mergedIntervals.at(-1);
    if (previous && interval.startMs - previous.endMs <= silenceGapMs) {
      previous.endMs = interval.endMs;
    } else if (interval.endMs - interval.startMs >= minimumDurationMs) {
      mergedIntervals.push({ ...interval });
    }
  }

  const roundedDurationMs = Math.floor(pcm.length * 1000 / ANALYSIS_PCM_RATE);
  let energyFrameIndex = 0;
  let pitchFrameIndex = 0;
  return mergedIntervals
    .map((interval) => {
      const start = Math.max(0, Math.min(roundedDurationMs, interval.startMs));
      const end = Math.max(start, Math.min(roundedDurationMs, interval.endMs));
      while (energyFrameIndex < energyFrames.length && energyFrames[energyFrameIndex]!.endMs <= start) energyFrameIndex += 1;
      let activeLevelSum = 0;
      let activeLevelCount = 0;
      for (let index = energyFrameIndex; index < energyFrames.length && energyFrames[index]!.startMs < end; index += 1) {
        const frame = energyFrames[index]!;
        if (frame.endMs > start && frame.levelDb >= closeThresholdDb) {
          activeLevelSum += frame.levelDb;
          activeLevelCount += 1;
        }
      }
      while (pitchFrameIndex < pitchFrames.length && pitchFrames[pitchFrameIndex]!.timestampMs < start) pitchFrameIndex += 1;
      let voicedFrameCount = 0;
      for (let index = pitchFrameIndex; index < pitchFrames.length && pitchFrames[index]!.timestampMs <= end; index += 1) {
        if (pitchFrames[index]!.voiced) voicedFrameCount += 1;
      }
      const expectedFrameCount = Math.max(1, Math.ceil((end - start) / 30));
      const pitchSupport = Math.min(1, voicedFrameCount / expectedFrameCount);
      const meanActiveDb = activeLevelCount
        ? activeLevelSum / activeLevelCount
        : openThresholdDb;
      const contrast = Math.max(0, Math.min(1,
        (meanActiveDb - noiseFloorDb) / Math.max(12, dynamicRangeDb)));
      const confidence = Math.max(0, Math.min(0.9, 0.52 + 0.23 * contrast + 0.15 * pitchSupport));
      return {
        startMs: start,
        endMs: end,
        confidence: Math.round(confidence * 1000) / 1000,
      };
    })
    .filter((interval) => interval.endMs - interval.startMs >= minimumDurationMs);
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
