/**
 * Elastic audio — pitch-preserving time stretch (WSOLA), windowed-sinc
 * resampling, and length-preserving pitch shift.
 *
 * Adapted from SoundCraft's offline processing (crates/dsp/src/offline.rs),
 * Copyright (c) 2026 ArtCraft Team and SoundCraft contributors,
 * dual-licensed MIT OR Apache-2.0 (https://github.com/storytold/soundcraft).
 * Clean-room TypeScript port: the WSOLA similarity search, Hann
 * overlap-add, Kaiser-windowed sinc table, and stretch-then-resample pitch
 * shift are preserved; interleaved stereo replaces planar channels and the
 * segment choices stay shared across channels so the image stays coherent.
 *
 * These are the SESSION layer's elastic primitives — clip warping, conformance
 * lengths, and key changes — as pure whole-buffer functions.
 */

import type { StereoBuffer } from "./mixer/dsp";

const MAX_RATIO = 10;
const MIN_RATIO = 0.1;
/** Sinc kernel: 32 zero crossings, 512 table steps per input sample. */
const SINC_ZC = 32;
const SINC_RES = 512;
const SINC_BETA = 9;

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 1;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

// ---------------------------------------------------------------------------
// Kaiser-windowed sinc resampling
// ---------------------------------------------------------------------------

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const y = (x * x) / 4;
  for (let k = 1; k < 64; k += 1) {
    term *= y / (k * k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

/** Precomputed one-sided windowed-sinc kernel for a cutoff (0..1 of Nyquist). */
class SincTable {
  readonly table: Float64Array;
  readonly halfWidth: number;

  constructor(cutoff: number) {
    const c = Math.min(1, Math.max(0.01, cutoff));
    const halfWidth = SINC_ZC / c;
    const n = Math.ceil(halfWidth * SINC_RES) + 2;
    const table = new Float64Array(n);
    const i0b = besselI0(SINC_BETA);
    for (let i = 0; i < n; i += 1) {
      const t = i / SINC_RES;
      const x = t / halfWidth;
      if (x >= 1) {
        table[i] = 0;
        continue;
      }
      const arg = Math.PI * c * t;
      const sinc = Math.abs(arg) < 1e-12 ? 1 : Math.sin(arg) / arg;
      const w = besselI0(SINC_BETA * Math.sqrt(Math.max(0, 1 - x * x))) / i0b;
      table[i] = c * sinc * w;
    }
    this.table = table;
    this.halfWidth = halfWidth;
  }

  /** Linearly-interpolated kernel value at distance `t` (samples). */
  at(t: number): number {
    const pos = Math.abs(t) * SINC_RES;
    const i = Math.floor(pos);
    if (i + 1 >= this.table.length) return this.table[Math.min(i, this.table.length - 1)] ?? 0;
    const f = pos - i;
    return this.table[i] + (this.table[i + 1] - this.table[i]) * f;
  }
}

function resampleChannel(
  x: Float64Array,
  ratio: number,
  outLen: number,
  table: SincTable,
): Float64Array {
  const len = x.length;
  const hw = table.halfWidth;
  const out = new Float64Array(outLen);
  for (let n = 0; n < outLen; n += 1) {
    const t = n / ratio;
    const lo = Math.max(0, Math.ceil(t - hw));
    const hi = Math.min(len - 1, Math.floor(t + hw));
    let acc = 0;
    for (let j = lo; j <= hi; j += 1) {
      acc += x[j] * table.at(t - j);
    }
    out[n] = acc;
  }
  return out;
}

function resampleRatio(left: Float64Array, right: Float64Array, ratio: number, outLen: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return [new Float64Array(outLen), new Float64Array(outLen)] as const;
  }
  // Anti-alias below the lower of the two Nyquists, with transition room.
  const cutoff = ratio < 1 ? ratio * 0.94 : 0.97;
  const table = new SincTable(cutoff);
  return [resampleChannel(left, ratio, outLen, table), resampleChannel(right, ratio, outLen, table)] as const;
}

/** High-quality sample-rate conversion; returns a new buffer. */
export function resampleBuffer(
  buffer: StereoBuffer,
  fromSampleRate: number,
  toSampleRate: number,
): StereoBuffer {
  const frames = buffer.length / 2;
  if (!Number.isFinite(fromSampleRate) || !Number.isFinite(toSampleRate) || fromSampleRate <= 0 || toSampleRate <= 0) {
    return new Float32Array(buffer);
  }
  if (fromSampleRate === toSampleRate) return Float32Array.from(buffer);
  const ratio = toSampleRate / fromSampleRate;
  const outLen = Math.max(0, Math.round(frames * ratio));
  const left = Float64Array.from(buffer.filter((_, i) => i % 2 === 0));
  const right = Float64Array.from(buffer.filter((_, i) => i % 2 === 1));
  const [outL, outR] = resampleRatio(left, right, ratio, outLen);
  const out = new Float32Array(outLen * 2);
  for (let i = 0; i < outLen; i += 1) {
    out[i * 2] = outL[i];
    out[i * 2 + 1] = outR[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// WSOLA time stretch
// ---------------------------------------------------------------------------

/**
 * Pitch-preserving time stretch by WSOLA (waveform-similarity overlap-add).
 * `ratio` = output length / input length, clamped to 0.1..10. The similarity
 * search runs on a mono guide mix so both channels share segment choices and
 * the stereo image stays coherent. Returns a new buffer of exactly
 * round(frames · ratio) frames.
 */
export function timeStretch(
  buffer: StereoBuffer,
  ratio: number,
  sampleRate: number,
): StereoBuffer {
  const frames = buffer.length / 2;
  const r = clampRatio(ratio);
  const outFrames = Math.round(frames * r);
  if (frames === 0) return new Float32Array(outFrames * 2);
  if (Math.abs(r - 1) < 1e-9) return Float32Array.from(buffer);

  const sr = Math.max(1, sampleRate);
  const frame = Math.min(8192, Math.max(64, Math.floor(sr * 0.04) & ~1));
  const hop = frame / 2;
  const tol = Math.min(2048, Math.max(8, Math.floor(sr * 0.01)));

  const window = new Float64Array(frame);
  for (let i = 0; i < frame; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
  }

  const left = Float64Array.from(buffer.filter((_, i) => i % 2 === 0));
  const right = Float64Array.from(buffer.filter((_, i) => i % 2 === 1));
  const guide = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) guide[i] = (left[i] + right[i]) / 2;
  const g = (i: number) => (i < 0 || i >= frames ? 0 : guide[i]);

  const bufLen = outFrames + frame;
  const outL = new Float64Array(bufLen);
  const outR = new Float64Array(bufLen);
  const wsum = new Float64Array(bufLen);

  /** Similarity of candidate start p with the natural continuation. */
  const score = (p: number, natural: number): number => {
    let xy = 0;
    let yy = 1e-9;
    for (let i = 0; i < hop; i += 2) {
      const a = g(natural + i);
      const b = g(p + i);
      xy += a * b;
      yy += b * b;
    }
    return xy / Math.sqrt(yy);
  };

  let prevIn = 0;
  let k = 0;
  for (;;) {
    const outPos = k * hop;
    if (outPos >= outFrames) break;
    let inPos: number;
    if (k === 0) {
      inPos = 0;
    } else {
      const nominal = Math.round(outPos / r);
      const natural = prevIn + hop;
      const lo = Math.max(nominal - tol, 0);
      const hi = nominal + tol;
      let best = Math.max(nominal, 0);
      let bestS = -Infinity;
      for (let p = lo; p <= hi; p += 4) {
        const s = score(p, natural);
        if (s > bestS) {
          bestS = s;
          best = p;
        }
      }
      const rlo = Math.max(best - 3, lo);
      const rhi = Math.min(best + 3, hi);
      for (let p = rlo; p <= rhi; p += 1) {
        const s = score(p, natural);
        if (s > bestS) {
          bestS = s;
          best = p;
        }
      }
      inPos = best;
    }
    for (let i = 0; i < frame; i += 1) {
      const w = window[i];
      const src = inPos + i;
      if (outPos + i >= bufLen) break;
      outL[outPos + i] += (src < frames ? left[src] : 0) * w;
      outR[outPos + i] += (src < frames ? right[src] : 0) * w;
      wsum[outPos + i] += w;
    }
    prevIn = inPos;
    k += 1;
  }

  const out = new Float32Array(outFrames * 2);
  for (let i = 0; i < outFrames; i += 1) {
    const w = wsum[i];
    const norm = w > 1e-3 ? 1 / w : 0;
    out[i * 2] = outL[i] * norm;
    out[i * 2 + 1] = outR[i] * norm;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pitch shift
// ---------------------------------------------------------------------------

/**
 * Length-preserving pitch shift by `semitones` (clamped to ±48): WSOLA
 * stretch by 2^(semitones/12) followed by windowed-sinc resampling back to
 * the original length. Returns a new buffer; ±0 semitones returns a copy.
 */
export function pitchShift(
  buffer: StereoBuffer,
  semitones: number,
  sampleRate: number,
): StereoBuffer {
  const st = Number.isFinite(semitones) ? Math.min(48, Math.max(-48, semitones)) : 0;
  if (Math.abs(st) < 1e-4) return Float32Array.from(buffer);
  const frames = buffer.length / 2;
  if (frames === 0) return new Float32Array(0);

  const factor = Math.pow(2, st / 12);
  const stretched = timeStretch(buffer, factor, sampleRate);
  const slen = stretched.length / 2;
  if (slen === 0) return new Float32Array(buffer.length);

  const ratio = frames / slen;
  const left = Float64Array.from(stretched.filter((_, i) => i % 2 === 0));
  const right = Float64Array.from(stretched.filter((_, i) => i % 2 === 1));
  const [outL, outR] = resampleRatio(left, right, ratio, frames);
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    out[i * 2] = outL[i];
    out[i * 2 + 1] = outR[i];
  }
  return out;
}
