/**
 * Vocal chops — the chipmunk-soul sampler (vision §V4 extension).
 *
 * Waveyard already owns the cleanest possible input: the SEPARATED VOCAL
 * STEM (V1 stem machine). This module scans that stem for the best
 * one-shot vocal notes — "chops" — and renders new melodies from them:
 *
 *  detectVocalChops  voiced-segment detection + per-segment pitch analysis
 *                    (normalized autocorrelation), quality-scored
 *                    (clarity, pitch stability, length, level), ranked
 *  extractChopSample trimmed + peak-normalised + edge-faded mono one-shot
 *  renderChopPattern sample playback with resampling pitch shift — pitch
 *                    UP plays faster and brighter: that IS the chipmunk
 *                    effect (no formant preservation, by design)
 *
 * Everything here is pure float math — no node: imports, fully testable,
 * client-safe. The API routes are thin shells over scanVocalStemForChops.
 */

import type { StereoBuffer } from "../mixer/dsp";

export const CHOP_SCAN_ENGINE = "waveyard-chop-scan-v1";
export const CHOP_RENDER_ENGINE = "waveyard-chop-render-v1";

/** Defaults tuned for 44.1 kHz vocal stems. */
export type ChopScanOptions = {
  /** Minimum note length to count as a chop (ms). */
  minDurationMs?: number;
  /** Maximum note length (ms) — longer than this is a phrase, not a chop. */
  maxDurationMs?: number;
  /** How many ranked chops to return. */
  maxChops?: number;
  /** Minimum mean autocorrelation clarity for a segment to qualify (0–1). */
  minClarity?: number;
  /** Minimum share of pitch-voiced frames within a segment (0–1). */
  minVoicedRatio?: number;
};

export type ChopDetection = {
  /** Position in the source stem (ms). */
  startMs: number;
  durationMs: number;
  /** Median pitch as a MIDI note (rounded) + signed cents deviation. */
  rootMidi: number;
  cents: number;
  /** Mean normalized-autocorrelation peak (0–1). */
  clarity: number;
  /** 1 − cents standard deviation / 100, clamped to 0–1. */
  stability: number;
  /** Share of frames with a confident pitch (0–1). */
  voicedRatio: number;
  /** Weighted quality score (0–1) — the ranking key. */
  score: number;
};

/** A decoded PCM buffer (interleaved, any channel count). */
export type PcmBuffer = {
  samples: Float32Array;
  channels: number;
  sampleRate: number;
};

const FRAME_SIZE = 1024;
const HOP_SIZE = 512;
/** Bridge gaps up to this many frames (~35 ms) inside one note. */
const BRIDGE_FRAMES = 3;
const MIN_HZ = 70;
const MAX_HZ = 1050;
/** RMS relative to the stem's peak for a frame to count as voiced. */
const VOICED_RMS_RATIO = 0.08;
const ABS_SILENCE_RMS = 1e-4;
const CHOP_PEAK = 0.95;
const RENDER_FADE_MS = 5;

function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

function downmix(buffer: PcmBuffer): Float32Array {
  if (buffer.channels === 1) return buffer.samples;
  const frames = Math.floor(buffer.samples.length / buffer.channels);
  const mono = new Float32Array(frames);
  const { channels } = buffer;
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += buffer.samples[frame * channels + channel];
    mono[frame] = sum / channels;
  }
  return mono;
}

/**
 * Normalized autocorrelation (NCF) pitch estimate for one frame.
 * Returns null when the frame has no confident periodicity. DC is removed
 * before correlation so constant offsets cannot fake clarity.
 */
export function estimateFramePitch(
  frame: Float32Array,
  sampleRate: number,
  minClarity: number,
): { hz: number; clarity: number } | null {
  let mean = 0;
  for (let i = 0; i < frame.length; i += 1) mean += frame[i];
  mean /= frame.length;

  let energy = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const centered = frame[i] - mean;
    energy += centered * centered;
  }
  if (energy / frame.length < ABS_SILENCE_RMS * ABS_SILENCE_RMS * frame.length) return null;

  const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ));
  const maxLag = Math.min(frame.length - 2, Math.ceil(sampleRate / MIN_HZ));
  if (maxLag <= minLag) return null;

  // Coarse correlation grid (stride 2) over the whole search range.
  const gridLength = Math.floor((maxLag - minLag) / 2) + 1;
  const grid = new Float32Array(gridLength);
  let bestIndex = 0;
  for (let index = 0; index < gridLength; index += 1) {
    grid[index] = normalizedCorrelation(frame, mean, minLag + index * 2);
    if (grid[index] > grid[bestIndex]) bestIndex = index;
  }
  let bestValue = grid[bestIndex];
  if (bestValue < minClarity) return null;

  // Peak-picking: integer-lag bias means a multiple of the true period
  // (k·P) can correlate marginally HIGHER than the period itself. The
  // fundamental is the FIRST local peak essentially as strong as the best
  // (≥ 0.9·best) — take it instead of the global maximum.
  for (let index = 1; index < bestIndex; index += 1) {
    if (grid[index] >= grid[index - 1] && grid[index] >= grid[index + 1] && grid[index] >= bestValue * 0.9) {
      bestIndex = index;
      bestValue = grid[index];
      break;
    }
  }

  // Refine the chosen peak to stride-1 resolution.
  let bestLag = minLag + bestIndex * 2;
  for (let lag = Math.max(minLag, bestLag - 2); lag <= Math.min(maxLag, bestLag + 2); lag += 1) {
    const value = normalizedCorrelation(frame, mean, lag);
    if (value > bestValue) {
      bestValue = value;
      bestLag = lag;
    }
  }
  return { hz: sampleRate / bestLag, clarity: bestValue };
}

function normalizedCorrelation(frame: Float32Array, mean: number, lag: number): number {
  let numerator = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  const length = frame.length - lag;
  for (let i = 0; i < length; i += 1) {
    const left = frame[i] - mean;
    const right = frame[i + lag] - mean;
    numerator += left * right;
    leftEnergy += left * left;
    rightEnergy += right * right;
  }
  const denominator = Math.sqrt(leftEnergy * rightEnergy);
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Segments longer than maxDurationMs are not chops — but they often CONTAIN
 * chops separated by energy dips rather than true silence (dense rap vocals,
 * sustained vowels). Split at dip runs (≥2 frames below 55% of the segment's
 * mean level); pieces still too long with no internal dips are sustained
 * notes — keep their middle maxDurationMs window. Pieces shorter than
 * minDurationMs are dropped.
 */
export function splitSegmentsAtDips(
  rms: Float32Array,
  segments: ReadonlyArray<{ first: number; last: number }>,
  frameMs: number,
  minDurationMs: number,
  maxDurationMs: number,
): Array<{ first: number; last: number }> {
  const minFrames = Math.max(1, Math.ceil(minDurationMs / frameMs));
  const maxFrames = Math.floor(maxDurationMs / frameMs);
  const out: Array<{ first: number; last: number }> = [];

  for (const segment of segments) {
    const lengthFrames = segment.last - segment.first + 1;
    if (lengthFrames <= maxFrames) {
      out.push(segment);
      continue;
    }

    let sum = 0;
    for (let index = segment.first; index <= segment.last; index += 1) sum += rms[index];
    const dipThreshold = (sum / lengthFrames) * 0.55;

    const pieces: Array<{ first: number; last: number }> = [];
    let pieceStart = segment.first;
    let index = segment.first;
    while (index <= segment.last) {
      if (rms[index] < dipThreshold) {
        let dipEnd = index;
        while (dipEnd + 1 <= segment.last && rms[dipEnd + 1] < dipThreshold) dipEnd += 1;
        if (dipEnd - index + 1 >= 2) {
          const center = Math.floor((index + dipEnd) / 2);
          pieces.push({ first: pieceStart, last: center - 1 });
          pieceStart = center + 1;
        }
        index = dipEnd + 1;
      } else {
        index += 1;
      }
    }
    pieces.push({ first: pieceStart, last: segment.last });

    for (const piece of pieces) {
      const pieceLength = piece.last - piece.first + 1;
      if (pieceLength < minFrames) continue;
      if (pieceLength > maxFrames) {
        // Sustained note with no internal dips — keep the middle window.
        const excess = pieceLength - maxFrames;
        out.push({ first: piece.first + Math.floor(excess / 2), last: piece.last - Math.ceil(excess / 2) });
      } else {
        out.push(piece);
      }
    }
  }
  return out;
}

/** Scan a decoded vocal stem for the best chops, ranked by score. */
export function detectVocalChops(buffer: PcmBuffer, options: ChopScanOptions = {}): ChopDetection[] {
  const {
    minDurationMs = 120,
    maxDurationMs = 1500,
    maxChops = 12,
    minClarity = 0.45,
    minVoicedRatio = 0.5,
  } = options;
  const mono = downmix(buffer);
  const { sampleRate } = buffer;
  if (mono.length < FRAME_SIZE) return [];

  const frameCount = 1 + Math.floor((mono.length - FRAME_SIZE) / HOP_SIZE);
  const rms = new Float32Array(frameCount);
  let peakRms = 0;
  for (let index = 0; index < frameCount; index += 1) {
    let sum = 0;
    const start = index * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      const value = mono[start + i];
      sum += value * value;
    }
    rms[index] = Math.sqrt(sum / FRAME_SIZE);
    if (rms[index] > peakRms) peakRms = rms[index];
  }
  if (peakRms < ABS_SILENCE_RMS) return [];
  const voicedThreshold = peakRms * VOICED_RMS_RATIO;

  // Merge voiced frames into segments (bridging tiny gaps).
  const segments: Array<{ first: number; last: number }> = [];
  let current: { first: number; last: number } | null = null;
  let silenceRun = 0;
  for (let index = 0; index < frameCount; index += 1) {
    if (rms[index] >= voicedThreshold) {
      if (current === null) current = { first: index, last: index };
      else current.last = index;
      silenceRun = 0;
    } else if (current !== null) {
      silenceRun += 1;
      if (silenceRun > BRIDGE_FRAMES) {
        segments.push(current);
        current = null;
      }
    }
  }
  if (current !== null) segments.push(current);

  // Dense vocals (rap, sustained vowels) can be one long voiced run with no
  // silence gaps at all — split those at internal energy dips (syllable
  // boundaries) so they still produce chops.
  const frameMs = (HOP_SIZE * 1000) / sampleRate;
  const pieces = splitSegmentsAtDips(rms, segments, frameMs, minDurationMs, maxDurationMs);

  const detections: ChopDetection[] = [];
  for (const segment of pieces) {
    // Bounds padded one frame each side so attacks keep their consonant.
    const startFrame = Math.max(0, segment.first - 1);
    const endFrame = Math.min(frameCount - 1, segment.last + 1);
    const startMs = Math.round((startFrame * HOP_SIZE * 1000) / sampleRate);
    const endMs = Math.round(((endFrame * HOP_SIZE + FRAME_SIZE) * 1000) / sampleRate);
    const durationMs = endMs - startMs;
    if (durationMs < minDurationMs || durationMs > maxDurationMs) continue;

    // Pitch every second frame inside the segment.
    const midis: number[] = [];
    let claritySum = 0;
    let clarityCount = 0;
    for (let index = segment.first; index <= segment.last; index += 2) {
      const frame = mono.subarray(index * HOP_SIZE, index * HOP_SIZE + FRAME_SIZE);
      const pitch = estimateFramePitch(frame, sampleRate, minClarity);
      if (pitch !== null) {
        midis.push(hzToMidi(pitch.hz));
        claritySum += pitch.clarity;
        clarityCount += 1;
      }
    }
    const totalFrames = Math.floor((segment.last - segment.first) / 2) + 1;
    if (clarityCount === 0 || clarityCount / totalFrames < minVoicedRatio) continue;

    const clarity = claritySum / clarityCount;
    if (clarity < minClarity) continue;
    const medianMidi = median(midis);
    const rootMidi = Math.round(medianMidi);
    const cents = (medianMidi - rootMidi) * 100;

    // Pitch stability: median absolute cents deviation from the segment
    // median (MAD — robust against edge frames that only partially overlap
    // the note and can pitch wildly for a frame or two).
    const deviations = midis.map((value) => Math.abs(value - medianMidi) * 100);
    const stability = Math.max(0, 1 - median(deviations) / 100);

    // Length preference: 150–800 ms is the sweet spot for chops.
    let lengthFit: number;
    if (durationMs >= 150 && durationMs <= 800) lengthFit = 1;
    else if (durationMs < 150) lengthFit = Math.max(0, (durationMs - minDurationMs) / (150 - minDurationMs));
    else lengthFit = Math.max(0, 1 - (durationMs - 800) / (maxDurationMs - 800));

    let levelSum = 0;
    for (let index = segment.first; index <= segment.last; index += 1) levelSum += rms[index];
    const level = Math.min(1, levelSum / (segment.last - segment.first + 1) / (peakRms * 0.5));

    const score = 0.45 * clarity + 0.25 * stability + 0.2 * lengthFit + 0.1 * level;
    detections.push({
      startMs,
      durationMs,
      rootMidi,
      cents: Math.round(cents),
      clarity,
      stability,
      voicedRatio: clarityCount / totalFrames,
      score,
    });
  }

  detections.sort((left, right) => right.score - left.score);
  return detections.slice(0, maxChops);
}

export type ExtractedChop = {
  detection: ChopDetection;
  /** Mono, peak-normalised, edge-faded one-shot ready for WAV storage. */
  sample: Float32Array;
};

/** Slice + normalise + fade one detection out of the decoded stem. */
export function extractChopSample(
  buffer: PcmBuffer,
  detection: ChopDetection,
  padMs = 10,
  fadeMs = 8,
): ExtractedChop {
  const mono = downmix(buffer);
  const { sampleRate } = buffer;
  const padFrames = Math.round((padMs / 1000) * sampleRate);
  const start = Math.max(0, Math.round((detection.startMs / 1000) * sampleRate) - padFrames);
  const end = Math.min(
    mono.length,
    Math.round(((detection.startMs + detection.durationMs) / 1000) * sampleRate) + padFrames,
  );
  const sample = mono.slice(start, end);

  let peak = 0;
  for (let i = 0; i < sample.length; i += 1) peak = Math.max(peak, Math.abs(sample[i]));
  if (peak > 0) {
    const gain = CHOP_PEAK / peak;
    for (let i = 0; i < sample.length; i += 1) sample[i] *= gain;
  }

  const fadeFrames = Math.min(Math.floor((fadeMs / 1000) * sampleRate), Math.floor(sample.length / 2));
  for (let i = 0; i < fadeFrames; i += 1) {
    const factor = i / fadeFrames;
    sample[i] *= factor;
    sample[sample.length - 1 - i] *= factor;
  }
  return { detection, sample };
}

/** Detect + extract in one pass — the API scan entry point. */
export function scanVocalStemForChops(buffer: PcmBuffer, options?: ChopScanOptions): ExtractedChop[] {
  return detectVocalChops(buffer, options).map((detection) => extractChopSample(buffer, detection));
}

// ---------------------------------------------------------------------------
// Chipmunk rendering — pattern playback through the chops.
// ---------------------------------------------------------------------------

export type ChopSample = {
  /** Mono one-shot PCM at its own rate (as stored). */
  sample: Float32Array;
  sampleRate: number;
  rootMidi: number;
};

/** Build a playback-ready chop from a decoded (stored) chop WAV. */
export function chopSampleFromDecoded(
  decoded: { samples: Float32Array; channels: number; sampleRate: number },
  rootMidi: number,
): ChopSample {
  return { sample: downmix(decoded), sampleRate: decoded.sampleRate, rootMidi };
}

export type ChopPatternEvent = {
  startMs: number;
  durationMs: number;
  /** Target pitch — the chop is resampled up/down to reach it. */
  midi: number;
  velocity: number;
  /** Index into the chops array. */
  chopIndex: number;
};

/**
 * Render a chop pattern: each event plays its chop resampled by
 * 2^((midi − rootMidi)/12) — pitching UP shortens and brightens the sample
 * (the chipmunk effect); pitching down lengthens and darkens it. Events cut
 * at their drawn end (with a 5 ms fade); shorter drawn lengths stop the
 * chop early, longer ones let it ring to its natural end.
 */
export function renderChopPattern(
  events: readonly ChopPatternEvent[],
  chops: readonly ChopSample[],
  sampleRate: number,
  durationSeconds: number,
): StereoBuffer {
  const totalFrames = Math.max(1, Math.round(durationSeconds * sampleRate));
  const out = new Float32Array(totalFrames * 2);
  const fadeFrames = Math.round((RENDER_FADE_MS / 1000) * sampleRate);

  for (const event of events) {
    const chop = chops[event.chopIndex];
    if (chop === undefined) continue;
    const pitchRatio = Math.pow(2, (event.midi - chop.rootMidi) / 12);
    // One output frame consumes pitchRatio input frames (rate-compensated).
    const step = pitchRatio * (chop.sampleRate / sampleRate);
    if (step <= 0) continue;

    const startFrame = Math.round((event.startMs / 1000) * sampleRate);
    if (startFrame >= totalFrames) continue;
    const naturalFrames = Math.floor(chop.sample.length / step);
    const eventFrames = Math.round((event.durationMs / 1000) * sampleRate);
    const lengthFrames = Math.max(1, Math.min(naturalFrames, eventFrames));
    const gain = event.velocity / 127;

    for (let frame = 0; frame < lengthFrames; frame += 1) {
      const outIndex = startFrame + frame;
      if (outIndex >= totalFrames) break;
      const source = frame * step;
      const sourceIndex = Math.floor(source);
      const frac = source - sourceIndex;
      const left = chop.sample[sourceIndex] ?? 0;
      const right = chop.sample[sourceIndex + 1] ?? left;
      let value = (left + (right - left) * frac) * gain;
      // Fade the cut so an early stop never clicks.
      const framesLeft = lengthFrames - frame;
      if (framesLeft <= fadeFrames) value *= framesLeft / fadeFrames;
      const outOffset = outIndex * 2;
      out[outOffset] += value;
      out[outOffset + 1] += value;
    }
  }

  // Bus clamp — stacked chops must never clip past full scale.
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] > 1) out[i] = 1;
    else if (out[i] < -1) out[i] = -1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Note-id convention — per-note chop assignment inside the piano roll.
// A chop pattern note carries its chop in the id: "<chopId>:<suffix>".
// ---------------------------------------------------------------------------

export function chopNoteId(chopId: string, suffix: string): string {
  return `${chopId}:${suffix}`;
}

const CHOP_NOTE_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):[0-9a-zA-Z_-]+$/;

/** Parse "<uuid>:<suffix>" → the chop id, or null for foreign note ids. */
export function parseChopNoteId(noteId: string): string | null {
  const match = CHOP_NOTE_ID_RE.exec(noteId);
  return match === null ? null : match[1];
}

/** Assign the armed chop to any note whose id is not already chop-stamped
 *  (fresh draws, duplicates, imports) — the UI's onChange normaliser. */
export function assignChopToNewNotes<T extends { id: string }>(
  notes: readonly T[],
  armedChopId: string,
): T[] {
  let counter = 0;
  return notes.map((note) => {
    if (parseChopNoteId(note.id) !== null) return note;
    counter += 1;
    return { ...note, id: chopNoteId(armedChopId, `n${counter}`) };
  });
}
