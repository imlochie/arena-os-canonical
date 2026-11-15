/**
 * Offline harmonic-perception experiment. This is intentionally not imported by
 * the production analysis or persistence path. Results are candidate evidence,
 * not calibrated chord probabilities or musical ground truth.
 */
import { fftInPlace, ANALYSIS_PCM_RATE } from "./analysis-engine";
import {
  HARMONY_CHORD_TEMPLATES,
  HARMONY_TEMPLATE_MIN_MARGIN,
  type ChordQuality,
  type HarmonyEvent,
} from "../types/harmony-analysis";

export const HARMONIC_CANDIDATE_ENGINE = "waveyard-multires-overtone-context-candidate";
export const HARMONIC_CANDIDATE_VERSION = "0.1.0";
export const HARMONIC_CANDIDATE_WINDOW_MS = 1_000;
const HOP_SAMPLES = Math.round(ANALYSIS_PCM_RATE * 0.25);
const BASS_FFT_SIZE = 16_384;
const UPPER_FFT_SIZE = 4_096;
const MIN_MIDI = 24; // C1: examine evidence below the production C2 floor.
const MAX_MIDI = 95;
const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export type CandidateChordHypothesis = {
  root: string | null;
  quality: ChordQuality;
  score: number;
  margin: number;
};

export type CandidateFrameEvidence = {
  timestampMs: number;
  bassPitchClasses: number[];
  upperPitchClasses: number[];
  independentPitchClasses: number[];
  active: boolean;
  transientWeight: number;
  tuningCents: number | null;
};

export type HarmonicCandidateAnalysis = {
  engine: string;
  version: string;
  events: HarmonyEvent[];
  frames: CandidateFrameEvidence[];
  hypotheses: Array<{ startMs: number; endMs: number; candidates: CandidateChordHypothesis[] }>;
  tuning: { cents: number | null; confidence: number; observationCount: number; pitchClassCount: number };
  diagnostics: {
    bassFundamentalHzRange: [number, number];
    bassUpperDisagreements: number;
    transientFrameCount: number;
    activeFrameCount: number;
    abstainedWindowCount: number;
  };
};

type Spectrum = { magnitudes: Float64Array; fftSize: number; noiseFloor: number; flatness: number };
type Resolution = { spectrum: Spectrum; direct: Float64Array; explained: Uint8Array; chroma: number[] };
type RawFrame = { timestampMs: number; bass: Resolution; upper: Resolution; transientWeight: number; active: boolean; tuningCents: number | null };

function spectrumFor(pcm: Float32Array, center: number, fftSize: number): Spectrum {
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const start = Math.round(center - fftSize / 2);
  let energy = 0;
  for (let index = 0; index < fftSize; index += 1) {
    const sample = pcm[start + index] ?? 0;
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / Math.max(1, fftSize - 1));
    real[index] = sample * window;
    energy += sample * sample;
  }
  fftInPlace(real, imaginary);
  const magnitudes = new Float64Array(fftSize / 2 + 1);
  let arithmetic = 0;
  let logSum = 0;
  let count = 0;
  const floor = 1e-12;
  for (let bin = 1; bin < fftSize / 2; bin += 1) {
    const magnitude = Math.hypot(real[bin]!, imaginary[bin]!);
    magnitudes[bin] = magnitude;
    arithmetic += magnitude;
    logSum += Math.log(Math.max(floor, magnitude));
    count += 1;
  }
  const flatness = count && arithmetic > 0 ? Math.exp(logSum / count) / (arithmetic / count) : 1;
  return { magnitudes, fftSize, noiseFloor: count ? arithmetic / count : 0, flatness: Number.isFinite(flatness) ? flatness : 1 };
}

function magnitudeAt(spectrum: Spectrum, hz: number, tuningCents: number): number {
  const frequency = hz * Math.pow(2, tuningCents / 1200);
  const exact = frequency * spectrum.fftSize / ANALYSIS_PCM_RATE;
  const bin = Math.round(exact);
  if (bin < 1 || bin >= spectrum.magnitudes.length - 1) return 0;
  // Peak capture avoids interpolation losses from modest tuning drift while the
  // tuning estimate itself remains separate and auditable.
  return Math.max(spectrum.magnitudes[bin - 1]!, spectrum.magnitudes[bin]!, spectrum.magnitudes[bin + 1]!);
}

function midiHz(midi: number): number { return 440 * Math.pow(2, (midi - 69) / 12); }

function estimateFrameTuning(spectrum: Spectrum): { cents: number | null; observations: Array<{ cents: number; midi: number }> } {
  const observations: Array<{ cents: number; midi: number }> = [];
  const maximum = Math.max(0, ...spectrum.magnitudes);
  if (maximum < 1e-8) return { cents: null, observations };
  for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi += 1) {
    const hz = midiHz(midi);
    if (hz < 38 || hz > 5_000) continue;
    const exact = hz * spectrum.fftSize / ANALYSIS_PCM_RATE;
    const bin = Math.round(exact);
    if (bin < 2 || bin >= spectrum.magnitudes.length - 2) continue;
    const peak = spectrum.magnitudes[bin]!;
    if (peak < maximum * 0.08 || peak <= spectrum.noiseFloor * 8) continue;
    const offset = 1200 * Math.log2((bin * ANALYSIS_PCM_RATE / spectrum.fftSize) / hz);
    if (Math.abs(offset) <= 45) observations.push({ cents: offset, midi: midi % 12 });
  }
  return { cents: null, observations };
}

function robustTuning(observations: Array<{ cents: number; midi: number }>): { cents: number | null; confidence: number; pitchClassCount: number } {
  if (observations.length < 12) return { cents: null, confidence: 0, pitchClassCount: new Set(observations.map((o) => o.midi)).size };
  const byPitchClass = new Map<number, number[]>();
  for (const observation of observations) byPitchClass.set(observation.midi, [...(byPitchClass.get(observation.midi) ?? []), observation.cents]);
  const stable: number[] = [];
  for (const values of byPitchClass.values()) {
    values.sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)]!;
    if (values.length >= 3 && values.filter((value) => Math.abs(value - median) <= 6).length >= Math.ceil(values.length * 0.7)) stable.push(median);
  }
  if (stable.length < 3) return { cents: null, confidence: 0, pitchClassCount: stable.length };
  stable.sort((a, b) => a - b);
  const median = stable[Math.floor(stable.length / 2)]!;
  const spread = stable.filter((value) => Math.abs(value - median) <= 5).length / stable.length;
  if (spread < 0.75 || Math.abs(median) < 2 || Math.abs(median) > 40)
    return { cents: null, confidence: spread, pitchClassCount: stable.length };
  return { cents: median, confidence: spread, pitchClassCount: stable.length };
}

function resolutionFor(spectrum: Spectrum, tuningCents: number): Resolution {
  const direct = new Float64Array(MAX_MIDI + 1);
  const explained = new Uint8Array(MAX_MIDI + 1);
  const maxMagnitude = Math.max(0, ...spectrum.magnitudes);
  if (maxMagnitude <= 1e-10) return { spectrum, direct, explained, chroma: new Array(12).fill(0) };
  for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi += 1) {
    const fundamental = magnitudeAt(spectrum, midiHz(midi), tuningCents);
    const second = magnitudeAt(spectrum, midiHz(midi) * 2, tuningCents);
    const third = magnitudeAt(spectrum, midiHz(midi) * 3, tuningCents);
    const fifth = magnitudeAt(spectrum, midiHz(midi) * 5, tuningCents);
    const harmonics = (second * 0.35 + third * 0.2 + fifth * 0.12) / maxMagnitude;
    direct[midi] = Math.max(0, (fundamental / maxMagnitude) * 0.72 + harmonics * 0.28);
  }
  // A high peak that is an integer partial of a separately supported lower
  // fundamental is retained as an alternative explanation, but excluded from
  // the independent-note vector. This avoids counting one note's overtone as
  // a second pitch class. It can abstain when the spectrum cannot distinguish
  // the two musical explanations.
  for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi += 1) {
    const targetHz = midiHz(midi) * Math.pow(2, tuningCents / 1200);
    const targetPeak = magnitudeAt(spectrum, midiHz(midi), tuningCents);
    for (let lower = MIN_MIDI; lower < midi; lower += 1) {
      const lowerHz = midiHz(lower) * Math.pow(2, tuningCents / 1200);
      const ratio = targetHz / lowerHz;
      const harmonic = Math.round(ratio);
      if (harmonic < 2 || harmonic > 8 || Math.abs(ratio - harmonic) > harmonic * 0.006) continue;
      const lowerPeak = magnitudeAt(spectrum, midiHz(lower), tuningCents);
      if (lowerPeak > maxMagnitude * 0.035 && targetPeak <= lowerPeak * 1.65) { explained[midi] = 1; break; }
    }
  }
  const chroma = new Array<number>(12).fill(0);
  for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi += 1) {
    if (explained[midi]) continue;
    const value = direct[midi]!;
    chroma[midi % 12] += value;
  }
  const total = chroma.reduce((sum, value) => sum + value, 0);
  if (total > 0) for (let i = 0; i < 12; i += 1) chroma[i] = chroma[i]! / total;
  return { spectrum, direct, explained, chroma };
}

function spectralFlux(previous: Spectrum | null, current: Spectrum): number {
  if (!previous || previous.magnitudes.length !== current.magnitudes.length) return 0;
  let positive = 0; let energy = 0;
  for (let i = 1; i < current.magnitudes.length; i += 4) {
    const now = current.magnitudes[i]!; const before = previous.magnitudes[i]!;
    positive += Math.max(0, now - before); energy += now;
  }
  return energy > 0 ? positive / energy : 0;
}

function candidateHypotheses(chroma: number[]): CandidateChordHypothesis[] {
  const sum = chroma.reduce((a, b) => a + b, 0);
  if (sum <= 1e-9) return [{ root: null, quality: "unknown", score: 0, margin: 0 }];
  const observed = chroma.map((value) => value / Math.max(...chroma));
  const observedNorm = Math.hypot(...observed);
  const scored: CandidateChordHypothesis[] = [];
  for (let root = 0; root < 12; root += 1) for (const template of HARMONY_CHORD_TEMPLATES) {
    let dot = 0; let norm = 0;
    for (let pitch = 0; pitch < 12; pitch += 1) {
      const weight = template.intervals.includes((pitch - root + 12) % 12) ? 1 : 0.08;
      dot += observed[pitch]! * weight; norm += weight * weight;
    }
    scored.push({ root: PITCH_CLASSES[root]!, quality: template.quality, score: dot / Math.max(1e-9, observedNorm * Math.sqrt(norm)), margin: 0 });
  }
  scored.sort((a, b) => b.score - a.score);
  for (let i = 0; i < Math.min(4, scored.length); i += 1) scored[i]!.margin = Math.max(0, (scored[i]!.score - (scored[i + 1]?.score ?? 0)) / Math.max(scored[i]!.score, 1e-9));
  return scored.slice(0, 4);
}

function combineFrame(bass: Resolution, upper: Resolution): { pitchClasses: number[]; disagreement: boolean } {
  const combined = new Array<number>(12).fill(0);
  let bassTotal = 0; let upperTotal = 0;
  for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi += 1) {
    const b = bass.direct[midi]! * (bass.explained[midi] ? 0 : 1);
    const u = upper.direct[midi]! * (upper.explained[midi] ? 0 : 1);
    let value: number;
    if (midi <= 47) value = b;
    else if (midi >= 56) value = u;
    else value = Math.min(b, u); // overlap: both independent windows must support it.
    combined[midi % 12] += value;
    bassTotal += b; upperTotal += u;
  }
  const total = combined.reduce((sum, value) => sum + value, 0);
  if (total > 0) for (let i = 0; i < 12; i += 1) combined[i] = combined[i]! / total;
  const disagreement = bassTotal > 0 && upperTotal > 0
    && cosine(bass.chroma, upper.chroma) < 0.35;
  return { pitchClasses: combined, disagreement };
}

function cosine(left: number[], right: number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  const norms = Math.hypot(...left) * Math.hypot(...right);
  return norms > 0 ? dot / norms : 0;
}

export function analyzeHarmonicCandidate(pcm: Float32Array): HarmonicCandidateAnalysis {
  if (!(pcm instanceof Float32Array) || pcm.some((sample) => !Number.isFinite(sample))) throw new TypeError("Candidate input must be finite mono Float32 PCM.");
  const durationMs = Math.round(pcm.length * 1000 / ANALYSIS_PCM_RATE);
  if (pcm.length === 0) return emptyAnalysis();
  const raw: Array<{ timestampMs: number; bassSpectrum: Spectrum; upperSpectrum: Spectrum; observations: Array<{ cents: number; midi: number }>; transientWeight: number }> = [];
  let previousUpper: Spectrum | null = null;
  for (let center = 0; center < pcm.length; center += HOP_SAMPLES) {
    const bassSpectrum = spectrumFor(pcm, center, BASS_FFT_SIZE);
    const upperSpectrum = spectrumFor(pcm, center, UPPER_FFT_SIZE);
    const peaks = estimateFrameTuning(bassSpectrum).observations.concat(estimateFrameTuning(upperSpectrum).observations);
    const flux = spectralFlux(previousUpper, upperSpectrum);
    const transientWeight = upperSpectrum.flatness > 0.82 ? 0.2
      : upperSpectrum.flatness > 0.62 && flux > 0.45 ? 0.12
      : upperSpectrum.flatness > 0.42 && flux > 0.6 ? 0.35 : 1;
    raw.push({ timestampMs: Math.round(center * 1000 / ANALYSIS_PCM_RATE), bassSpectrum, upperSpectrum, observations: peaks, transientWeight });
    previousUpper = upperSpectrum;
  }
  const tuning = robustTuning(raw.flatMap((frame) => frame.observations));
  const frames: RawFrame[] = raw.map((frame) => {
    const bass = resolutionFor(frame.bassSpectrum, tuning.cents ?? 0);
    const upper = resolutionFor(frame.upperSpectrum, tuning.cents ?? 0);
    const mix = combineFrame(bass, upper);
    const energy = frame.bassSpectrum.magnitudes.reduce((sum, value) => sum + value, 0);
    return { timestampMs: frame.timestampMs, bass, upper, transientWeight: frame.transientWeight,
      active: energy > 1e-6 && mix.pitchClasses.reduce((sum, value) => sum + value, 0) > 0, tuningCents: tuning.cents };
  });
  const events: HarmonyEvent[] = [];
  const hypotheses: HarmonicCandidateAnalysis["hypotheses"] = [];
  let disagreements = 0; let transientCount = 0; let activeCount = 0; let abstained = 0;
  const windowSamples = Math.round(ANALYSIS_PCM_RATE * HARMONIC_CANDIDATE_WINDOW_MS / 1000);
  for (let start = 0; start < pcm.length; start += windowSamples) {
    const end = Math.min(pcm.length, start + windowSamples);
    const firstMs = Math.round(start * 1000 / ANALYSIS_PCM_RATE);
    const lastMs = Math.min(durationMs, Math.round(end * 1000 / ANALYSIS_PCM_RATE));
    const selected = frames.filter((frame) => frame.timestampMs >= firstMs && frame.timestampMs < lastMs);
    const active = selected.filter((frame) => frame.active && frame.transientWeight >= 0.5);
    if (selected.some((frame) => frame.transientWeight < 0.5)) transientCount += selected.filter((frame) => frame.transientWeight < 0.5).length;
    activeCount += active.length;
    const summed = new Array<number>(12).fill(0);
    for (const frame of active) {
      const mix = combineFrame(frame.bass, frame.upper);
      if (mix.disagreement) disagreements += 1;
      for (let pc = 0; pc < 12; pc += 1) summed[pc] += mix.pitchClasses[pc]!;
    }
    const pitchClassCount = summed.filter((value) => value > 0.04).length;
    const chordVector = summed.map((value) => active.length ? value / active.length : 0);
    const ranked = candidateHypotheses(chordVector);
    const first = ranked[0] ?? { root: null, quality: "unknown" as const, score: 0, margin: 0 };
    const supportedPitchClasses = chordVector.filter((value) => value > 0.04).length;
    const enoughTime = active.length >= 2;
    const named = enoughTime && pitchClassCount >= 3 && supportedPitchClasses >= 3
      && first.root !== null && first.score >= 0.28 && first.margin >= HARMONY_TEMPLATE_MIN_MARGIN;
    if (!named) abstained += 1;
    hypotheses.push({ startMs: firstMs, endMs: lastMs, candidates: ranked });
    events.push({ startMs: firstMs, endMs: lastMs, root: named ? first.root : null,
      quality: named ? first.quality : "unknown", confidence: Math.round((named ? first.margin : 0) * 1e6) / 1e6 });
  }
  const bassMinHz = midiHz(MIN_MIDI); const bassMaxHz = midiHz(47);
  return {
    engine: HARMONIC_CANDIDATE_ENGINE, version: HARMONIC_CANDIDATE_VERSION,
    events, frames: frames.map((frame) => ({ timestampMs: frame.timestampMs,
      bassPitchClasses: frame.bass.chroma, upperPitchClasses: frame.upper.chroma,
      independentPitchClasses: combineFrame(frame.bass, frame.upper).pitchClasses,
      active: frame.active, transientWeight: frame.transientWeight, tuningCents: frame.tuningCents })),
    hypotheses, tuning: { cents: tuning.cents, confidence: tuning.confidence,
      observationCount: raw.reduce((sum, frame) => sum + frame.observations.length, 0), pitchClassCount: tuning.pitchClassCount },
    diagnostics: { bassFundamentalHzRange: [bassMinHz, bassMaxHz], bassUpperDisagreements: disagreements,
      transientFrameCount: transientCount, activeFrameCount: activeCount, abstainedWindowCount: abstained },
  };
}

function emptyAnalysis(): HarmonicCandidateAnalysis {
  return { engine: HARMONIC_CANDIDATE_ENGINE, version: HARMONIC_CANDIDATE_VERSION, events: [], frames: [], hypotheses: [],
    tuning: { cents: null, confidence: 0, observationCount: 0, pitchClassCount: 0 },
    diagnostics: { bassFundamentalHzRange: [midiHz(MIN_MIDI), midiHz(47)], bassUpperDisagreements: 0,
      transientFrameCount: 0, activeFrameCount: 0, abstainedWindowCount: 0 } };
}

