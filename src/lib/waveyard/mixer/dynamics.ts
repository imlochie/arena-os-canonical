/**
 * Dynamics processors — de-esser and maximizer (lookahead brickwall
 * limiter) — offline whole-buffer, in-place.
 *
 * Adapted from SoundCraft's dynamics plugins (crates/dsp/src/plugins/
 * dynamics.rs), Copyright (c) 2026 ArtCraft Team and SoundCraft
 * contributors, dual-licensed MIT OR Apache-2.0
 * (https://github.com/storytold/soundcraft). Clean-room TypeScript port:
 * topology preserved (stereo-linked detection, block-redesigned shelf for
 * the de-esser, min-hold + moving-average lookahead for the maximizer),
 * realtime smoothers replaced by static gains.
 */

import { dbToGain, gainToDb } from "./gain";
import { biquadSample, designBiquad, newBiquadState, type BiquadCoeffs, type StereoBuffer } from "./dsp";
import { clamp } from "./types";

/** One-pole time coefficient for a time constant in ms. */
function timeCoef(ms: number, sampleRate: number): number {
  const tau = Math.max(1, (ms / 1000) * sampleRate);
  return Math.exp(-1 / tau);
}

function ballistic(state: number, target: number, attack: number, release: number): number {
  const c = target > state ? attack : release;
  return target + (state - target) * c;
}

// ---------------------------------------------------------------------------
// De-esser — dynamic-EQ sibilance control
// ---------------------------------------------------------------------------

export type DeEsserParams = {
  /** Sibilance band frequency (sidechain high-pass, shelf sits at 0.8×). */
  freqHz: number; // 2000..16000
  /** Detection threshold in dBFS. */
  thresholdDb: number; // −60..0
  /** Maximum shelf dip in dB. */
  rangeDb: number; // 0..40
  sampleRate: number;
};

/** Identity coefficients: the shelf is flat while no reduction is needed. */
const IDENTITY_COEFFS: BiquadCoeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };

function designShelf(freqHz: number, gainDb: number, sampleRate: number): BiquadCoeffs {
  if (gainDb < 0.01) return IDENTITY_COEFFS;
  return designBiquad(
    { type: "highshelf", freqHz, q: 0.8, gainDb: -gainDb },
    sampleRate,
  );
}

/**
 * Dynamic-EQ de-esser: a high-pass sidechain detects sibilance and a high
 * shelf at 0.8·freq dips by up to `rangeDb` dB while it exceeds the
 * threshold. At rest the shelf is flat, so the signal passes untouched.
 * In-place; the input's length is unchanged.
 */
export function applyDeEsser(buffer: StereoBuffer, params: DeEsserParams): void {
  const sampleRate = Math.max(1, params.sampleRate);
  const frames = buffer.length / 2;
  const freq = clamp(params.freqHz, 2000, 16000);
  const threshold = clamp(params.thresholdDb, -60, 0);
  const range = clamp(params.rangeDb, 0, 40);

  const hpCoeffs = designBiquad({ type: "highpass", freqHz: freq, q: Math.SQRT1_2 }, sampleRate);
  const hpL = newBiquadState();
  const hpR = newBiquadState();
  const attack = timeCoef(0.5, sampleRate);
  const release = timeCoef(60, sampleRate);

  let shelfCoeffs = IDENTITY_COEFFS;
  const shelfL = newBiquadState();
  const shelfR = newBiquadState();
  let env = 0;
  let shelfGr = 0;

  const CHUNK = 16;
  let n = 0;
  while (n < frames) {
    const len = Math.min(CHUNK, frames - n);
    // Detect: stereo-linked sibilance envelope from the high-passed signal.
    for (let i = 0; i < len; i += 1) {
      const idx = (n + i) * 2;
      const hl = biquadSample(hpCoeffs, hpL, buffer[idx]);
      const hr = biquadSample(hpCoeffs, hpR, buffer[idx + 1]);
      const level = Math.max(Math.abs(hl), Math.abs(hr));
      env = ballistic(env, level, attack, release);
      if (!Number.isFinite(env)) env = 0;
    }
    const gr = clamp(gainToDb(env) - threshold, 0, range);
    // Redesign the shelf only when the dip actually moved.
    if (Math.abs(gr - shelfGr) > 0.05 || (gr === 0 && shelfGr !== 0)) {
      shelfGr = gr;
      shelfCoeffs = designShelf(freq * 0.8, gr, sampleRate);
    }
    // Process the chunk through the (possibly flat) shelf.
    for (let i = 0; i < len; i += 1) {
      const idx = (n + i) * 2;
      buffer[idx] = biquadSample(shelfCoeffs, shelfL, buffer[idx]);
      buffer[idx + 1] = biquadSample(shelfCoeffs, shelfR, buffer[idx + 1]);
    }
    n += len;
  }
}

// ---------------------------------------------------------------------------
// Maximizer — lookahead brickwall limiter
// ---------------------------------------------------------------------------

export type MaximizerParams = {
  /** Input drive: −threshold dB of gain before limiting. */
  thresholdDb: number; // −30..0 (0 = no drive)
  /** Hard output ceiling. */
  ceilingDb: number; // −30..0
  releaseMs: number; // 1..1000
  sampleRate: number;
};

const MAX_LOOKAHEAD_MS = 1.5;

/**
 * Lookahead brickwall limiter: the input is driven by −threshold dB and
 * never exceeds the ceiling. Gain is a min-hold over the lookahead window
 * followed by an equal-length moving average, which ramps the gain down
 * before each peak reaches the output. In-place; length unchanged.
 */
export function applyMaximizer(buffer: StereoBuffer, params: MaximizerParams): void {
  const sampleRate = Math.max(1, params.sampleRate);
  const frames = buffer.length / 2;
  const drive = dbToGain(-clamp(params.thresholdDb, -30, 0));
  const ceiling = dbToGain(clamp(params.ceilingDb, -30, 0));
  const release = timeCoef(clamp(params.releaseMs, 1, 1000), sampleRate);

  const la = Math.max(1, Math.round((MAX_LOOKAHEAD_MS / 1000) * sampleRate));
  // Frame delay ring: each entry is an interleaved L/R pair.
  const delay = new Float32Array((la + 2) * 2);
  let w = 0;
  const req = new Float64Array(la).fill(1);
  const smooth = new Float64Array(la).fill(1);
  let sum = la; // sum of `smooth`
  let held = 1;
  let idx = 0;

  for (let n = 0; n < frames; n += 1) {
    const xL = (Number.isFinite(buffer[n * 2]) ? buffer[n * 2] : 0) * drive;
    const xR = (Number.isFinite(buffer[n * 2 + 1]) ? buffer[n * 2 + 1] : 0) * drive;

    delay[w * 2] = xL;
    delay[w * 2 + 1] = xR;
    w = (w + 1) % (la + 2);

    const peak = Math.max(Math.abs(xL), Math.abs(xR));
    req[idx] = peak > ceiling ? ceiling / peak : 1;

    let hold = 1;
    for (let i = 0; i < la; i += 1) if (req[i] < hold) hold = req[i];
    // Instant attack down, smoothed release up.
    held = hold < held ? hold : hold + (held - hold) * release;

    sum += held - smooth[idx];
    smooth[idx] = held;
    idx += 1;
    if (idx >= la) {
      idx = 0;
      // Re-sum once per window to cancel floating-point drift.
      sum = 0;
      for (let i = 0; i < la; i += 1) sum += smooth[i];
    }
    const g = clamp(sum / la, 0, 1);

    const tapFrame = (w - la + (la + 2)) % (la + 2);
    buffer[n * 2] = clamp(delay[tapFrame * 2] * g, -ceiling, ceiling);
    buffer[n * 2 + 1] = clamp(delay[tapFrame * 2 + 1] * g, -ceiling, ceiling);
  }
}
