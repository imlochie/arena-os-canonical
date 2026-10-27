/**
 * Real DSP kernels for Waveyard — pure functions over interleaved stereo
 * PCM (Float32Array [L,R,L,R,…]). These are the same kernels used by the
 * insert chain processor, the offline render path, and the tests; nothing
 * here is decorative. All state is explicit so calls stay deterministic.
 */

import { clamp } from "./types";

export type StereoBuffer = Float32Array; // interleaved L,R pairs

export function frameCount(buffer: StereoBuffer): number {
  return buffer.length >> 1;
}

/** dB helpers re-exported for DSP users. */
export const dspDbToGain = (db: number) => Math.pow(10, db / 20);
export const dspGainToDb = (gain: number) =>
  gain <= 0 ? -Infinity : 20 * Math.log10(gain);

// ---------------------------------------------------------------------------
// Level / phase / image
// ---------------------------------------------------------------------------

export function applyGain(buffer: StereoBuffer, gain: number): void {
  if (gain === 1) return;
  for (let i = 0; i < buffer.length; i++) buffer[i] *= gain;
}

/** Polarity inversion of one or both channels. */
export function invertPolarity(
  buffer: StereoBuffer,
  invertLeft: boolean,
  invertRight: boolean,
): void {
  if (!invertLeft && !invertRight) return;
  for (let i = 0; i < buffer.length; i += 2) {
    if (invertLeft) buffer[i] = -buffer[i];
    if (invertRight) buffer[i + 1] = -buffer[i + 1];
  }
}

/** Sum to mono (amount 0..1 crossfades between stereo and mono). */
export function toMono(buffer: StereoBuffer, amount = 1): void {
  const a = clamp(amount, 0, 1);
  if (a === 0) return;
  for (let i = 0; i < buffer.length; i += 2) {
    const mono = (buffer[i] + buffer[i + 1]) * 0.7071067811865476;
    buffer[i] = buffer[i] * (1 - a) + mono * a;
    buffer[i + 1] = buffer[i + 1] * (1 - a) + mono * a;
  }
}

/** Normalized equal-power pan — same law as gain.ts panGains (unity center). */
export function applyPan(buffer: StereoBuffer, pan: number): void {
  const p = clamp(pan, -1, 1);
  const angle = ((p + 1) / 2) * (Math.PI / 2);
  const left = Math.min(1, Math.cos(angle) / Math.SQRT1_2);
  const right = Math.min(1, Math.sin(angle) / Math.SQRT1_2);
  if (left === 1 && right === 1) return;
  for (let i = 0; i < buffer.length; i += 2) {
    buffer[i] *= left;
    buffer[i + 1] *= right;
  }
}

/** Mid/side stereo width. width 0 = mono, 1 = unchanged, >1 = wider. */
export function applyStereoWidth(buffer: StereoBuffer, width: number): void {
  const w = clamp(width, 0, 4);
  for (let i = 0; i < buffer.length; i += 2) {
    const mid = (buffer[i] + buffer[i + 1]) * 0.5;
    const side = (buffer[i] - buffer[i + 1]) * 0.5;
    buffer[i] = mid + side * w;
    buffer[i + 1] = mid - side * w;
  }
}

/** Mix a processed copy over the dry signal (wet 0..1). */
export function mixDryWet(buffer: StereoBuffer, processed: StereoBuffer, wet: number): void {
  const w = clamp(wet, 0, 1);
  const d = 1 - w;
  for (let i = 0; i < buffer.length; i++) buffer[i] = buffer[i] * d + processed[i] * w;
}

// ---------------------------------------------------------------------------
// Biquads (RBJ audio cookbook) — per-channel state
// ---------------------------------------------------------------------------

export type BiquadType =
  | "lowpass"
  | "highpass"
  | "peaking"
  | "lowshelf"
  | "highshelf"
  | "notch";

export type BiquadCoeffs = { b0: number; b1: number; b2: number; a1: number; a2: number };

export type BiquadSpec = {
  type: BiquadType;
  freqHz: number;
  /** Q for lowpass/highpass/notch/peaking (default 0.7071). */
  q?: number;
  /** Gain in dB for peaking/shelf filters. */
  gainDb?: number;
};

export function designBiquad(spec: BiquadSpec, sampleRate: number): BiquadCoeffs {
  const q = clamp(spec.q ?? 0.7071, 0.0001, 1000);
  const gainDb = clamp(spec.gainDb ?? 0, -24, 24);
  const f0 = clamp(spec.freqHz, 1, sampleRate * 0.49);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cosW0 = Math.cos(w0);
  const a = Math.pow(10, gainDb / 40); // A per RBJ

  switch (spec.type) {
    case "lowpass":
      return finishBiquad({ b0: (1 - cosW0) / 2, b1: 1 - cosW0, b2: (1 - cosW0) / 2, a0: 1 + alpha, a1: -2 * cosW0, a2: 1 - alpha });
    case "highpass":
      return finishBiquad({ b0: (1 + cosW0) / 2, b1: -(1 + cosW0), b2: (1 + cosW0) / 2, a0: 1 + alpha, a1: -2 * cosW0, a2: 1 - alpha });
    case "notch":
      return finishBiquad({ b0: 1, b1: -2 * cosW0, b2: 1, a0: 1 + alpha, a1: -2 * cosW0, a2: 1 - alpha });
    case "peaking":
      return finishBiquad({ b0: 1 + alpha * a, b1: -2 * cosW0, b2: 1 - alpha * a, a0: 1 + alpha / a, a1: -2 * cosW0, a2: 1 - alpha / a });
    case "lowshelf": {
      const twoSqrtAAlpha = 2 * Math.sqrt(a) * alpha;
      return finishBiquad({
        b0: a * (a + 1 - (a - 1) * cosW0 + twoSqrtAAlpha),
        b1: 2 * a * (a - 1 - (a + 1) * cosW0),
        b2: a * (a + 1 - (a - 1) * cosW0 - twoSqrtAAlpha),
        a0: a + 1 + (a - 1) * cosW0 + twoSqrtAAlpha,
        a1: -2 * (a - 1 + (a + 1) * cosW0),
        a2: a + 1 + (a - 1) * cosW0 - twoSqrtAAlpha,
      });
    }
    case "highshelf": {
      const twoSqrtAAlpha = 2 * Math.sqrt(a) * alpha;
      return finishBiquad({
        b0: a * (a + 1 + (a - 1) * cosW0 + twoSqrtAAlpha),
        b1: -2 * a * (a - 1 + (a + 1) * cosW0),
        b2: a * (a + 1 + (a - 1) * cosW0 - twoSqrtAAlpha),
        a0: a + 1 - (a - 1) * cosW0 + twoSqrtAAlpha,
        a1: 2 * (a - 1 - (a + 1) * cosW0),
        a2: a + 1 - (a - 1) * cosW0 - twoSqrtAAlpha,
      });
    }
  }
}

function finishBiquad(c: Partial<BiquadCoeffs> & { a0: number }): BiquadCoeffs {
  return {
    b0: c.b0! / c.a0,
    b1: c.b1! / c.a0,
    b2: c.b2! / c.a0,
    a1: c.a1! / c.a0,
    a2: c.a2! / c.a0,
  };
}

export type BiquadState = { x1: number; x2: number; y1: number; y2: number };

export function newBiquadState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

export function biquadSample(coeffs: BiquadCoeffs, state: BiquadState, x: number): number {
  const y = coeffs.b0 * x + coeffs.b1 * state.x1 + coeffs.b2 * state.x2
    - coeffs.a1 * state.y1 - coeffs.a2 * state.y2;
  state.x2 = state.x1; state.x1 = x;
  state.y2 = state.y1; state.y1 = y;
  return y;
}

/** Run a biquad independently over both channels (shared coefficients). */
export function applyBiquad(
  buffer: StereoBuffer,
  coeffs: BiquadCoeffs,
  left: BiquadState,
  right: BiquadState,
): void {
  for (let i = 0; i < buffer.length; i += 2) {
    buffer[i] = biquadSample(coeffs, left, buffer[i]);
    buffer[i + 1] = biquadSample(coeffs, right, buffer[i + 1]);
  }
}

// ---------------------------------------------------------------------------
// Dynamics
// ---------------------------------------------------------------------------

export type CompressorParams = {
  thresholdDb: number; // −60..0
  ratio: number; // 1..20
  attackMs: number; // 0.1..200
  releaseMs: number; // 5..2000
  makeupDb: number; // −12..+24
  sampleRate: number;
};

/**
 * Feed-forward compressor with peak detection, applied as linked stereo
 * (one detector over max(|L|,|R|)). Deterministic, allocation-free.
 */
export function applyCompressor(buffer: StereoBuffer, params: CompressorParams): void {
  const { thresholdDb, ratio, makeupDb, sampleRate } = params;
  const attackCoeff = Math.exp(-1 / ((params.attackMs / 1000) * sampleRate));
  const releaseCoeff = Math.exp(-1 / ((params.releaseMs / 1000) * sampleRate));
  const makeup = dspDbToGain(makeupDb);
  let envelope = 0;
  for (let i = 0; i < buffer.length; i += 2) {
    const level = Math.max(Math.abs(buffer[i]), Math.abs(buffer[i + 1]));
    const detected = level > envelope ? attackCoeff * envelope + (1 - attackCoeff) * level
      : releaseCoeff * envelope + (1 - releaseCoeff) * level;
    envelope = detected;
    let gain = 1;
    const detectedDb = dspGainToDb(detected);
    if (detectedDb > thresholdDb && ratio > 1) {
      const reductionDb = (detectedDb - thresholdDb) * (1 - 1 / ratio);
      gain = dspDbToGain(-reductionDb);
    }
    const g = gain * makeup;
    buffer[i] *= g;
    buffer[i + 1] *= g;
  }
}

export type GateParams = {
  thresholdDb: number; // −90..0
  attackMs: number;
  releaseMs: number;
  holdMs: number;
  sampleRate: number;
};

/** Simple hold-gate: below threshold the signal decays to silence. */
export function applyGate(buffer: StereoBuffer, params: GateParams): void {
  const threshold = dspDbToGain(params.thresholdDb);
  const attack = Math.exp(-1 / ((params.attackMs / 1000) * params.sampleRate));
  const release = Math.exp(-1 / ((params.releaseMs / 1000) * params.sampleRate));
  const holdSamples = Math.round((params.holdMs / 1000) * params.sampleRate);
  let gain = 0;
  let hold = 0;
  for (let i = 0; i < buffer.length; i += 2) {
    const level = Math.max(Math.abs(buffer[i]), Math.abs(buffer[i + 1]));
    if (level >= threshold) hold = holdSamples;
    else if (hold > 0) hold -= 1;
    const open = level >= threshold || hold > 0;
    const target = open ? 1 : 0;
    const coeff = open ? attack : release; // attack ramps up quickly when opening
    gain = target > gain ? coeff * gain + (1 - coeff) * target : coeff * gain + (1 - coeff) * target;
    buffer[i] *= gain;
    buffer[i + 1] *= gain;
  }
}

// ---------------------------------------------------------------------------
// Saturation / clipping
// ---------------------------------------------------------------------------

/** Tanh soft saturation. drive 1 = gentle, higher = harder. */
export function applySaturation(buffer: StereoBuffer, drive: number): void {
  const d = clamp(drive, 0.1, 20);
  const norm = 1 / Math.tanh(d);
  for (let i = 0; i < buffer.length; i++)
    buffer[i] = norm * Math.tanh(d * buffer[i]);
}

/** Hard ceiling with soft knee near the top (limiter-style soft clip). */
export function applySoftClipCeiling(buffer: StereoBuffer, ceilingDb: number): void {
  const ceiling = dspDbToGain(clamp(ceilingDb, -24, 0));
  const knee = ceiling * 0.85;
  for (let i = 0; i < buffer.length; i++) {
    const x = Math.abs(buffer[i]);
    if (x <= knee) continue;
    const sign = buffer[i] < 0 ? -1 : 1;
    const over = (x - knee) / Math.max(1e-9, ceiling - knee);
    buffer[i] = sign * (knee + (ceiling - knee) * Math.tanh(over));
  }
}

// ---------------------------------------------------------------------------
// Delay (feedback echo)
// ---------------------------------------------------------------------------

export type DelayParams = {
  delayMs: number; // 1..2000
  feedback: number; // 0..0.95
  mix: number; // 0..1 wet amount
  sampleRate: number;
};

/**
 * Feedback delay. Returns a new buffer; the input is untouched.
 * tail[n] = dry[n−D] + feedback·tail[n−D]; out = dry·(1−mix) + tail·mix.
 */
export function applyDelay(buffer: StereoBuffer, params: DelayParams): StereoBuffer {
  const delaySamples = Math.max(
    1,
    Math.round((clamp(params.delayMs, 1, 2000) / 1000) * params.sampleRate),
  );
  const feedback = clamp(params.feedback, 0, 0.95);
  const wet = clamp(params.mix, 0, 1);
  const dry = 1 - wet;
  const out = new Float32Array(buffer.length);
  const tail = new Float32Array(buffer.length);
  const frames = frameCount(buffer);
  for (let frame = 0; frame < frames; frame += 1) {
    const src = frame - delaySamples;
    for (let channel = 0; channel < 2; channel += 1) {
      const idx = frame * 2 + channel;
      tail[idx] =
        src >= 0
          ? buffer[src * 2 + channel] + feedback * tail[src * 2 + channel]
          : 0;
      out[idx] = buffer[idx] * dry + tail[idx] * wet;
    }
  }
  return out;
}
