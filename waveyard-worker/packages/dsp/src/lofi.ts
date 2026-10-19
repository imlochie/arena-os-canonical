/**
 * Lo-Fi (bit crush + sample-and-hold decimation + hiss) and Rectifier
 * (half/full-wave with DC removal) — offline whole-buffer, in-place.
 *
 * Adapted from SoundCraft's harmonic plugins (crates/dsp/src/plugins/
 * harmonic.rs), Copyright (c) 2026 ArtCraft Team and SoundCraft
 * contributors, dual-licensed MIT OR Apache-2.0
 * (https://github.com/storytold/soundcraft). Clean-room TypeScript port:
 * quantization/hold math, noise shaping (percent² · 0.1), and the DC-blocker
 * release are preserved; a seeded LCG replaces their RNG for deterministic
 * offline renders, and the hold phase stays shared across channels so the
 * stereo image holds together.
 */

import { dspDbToGain, type StereoBuffer } from "./dsp";
import { clamp } from "./types";

// ---------------------------------------------------------------------------
// Lo-Fi
// ---------------------------------------------------------------------------

export type LoFiParams = {
  /** Quantization bit depth 1..24 (24 = effectively transparent). */
  bits: number;
  /** Sample-and-hold rate 500..sampleRate Hz. */
  sampleRateHz: number;
  /** Hiss amount 0..100 %. */
  noisePercent: number;
  /** Wet amount 0..1. */
  mix: number;
  sampleRate: number;
};

/** Deterministic bipolar noise source (LCG, fixed seed). */
class Lcg {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  bipolar(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return (this.state / 0xffffffff) * 2 - 1;
  }
}

/**
 * Bit crusher and sample-and-hold decimator with optional hiss. The hold
 * phase is shared across channels; quantization happens at grab time so the
 * held value carries the crunch. In-place; length unchanged.
 */
export function applyLoFi(buffer: StereoBuffer, params: LoFiParams): void {
  const sampleRate = Math.max(1, params.sampleRate);
  const frames = buffer.length / 2;
  const bits = clamp(params.bits, 1, 24);
  const step = Math.pow(2, 1 - bits);
  const inc = Math.min(1, clamp(params.sampleRateHz, 500, 48000) / sampleRate);
  const noise = clamp(params.noisePercent, 0, 100);
  const nz = Math.pow(noise / 100, 2) * 0.1;
  const mix = clamp(params.mix, 0, 1);
  const dry = 1 - mix;

  let heldLeft = 0;
  let heldRight = 0;
  let phase = 1;
  const rng = new Lcg(77);

  for (let n = 0; n < frames; n += 1) {
    phase += inc;
    const grab = phase >= 1;
    if (grab) phase -= 1;
    const xl = Number.isFinite(buffer[n * 2]) ? buffer[n * 2] : 0;
    const xr = Number.isFinite(buffer[n * 2 + 1]) ? buffer[n * 2 + 1] : xl;
    if (grab) {
      const nl = nz > 0 ? rng.bipolar() * nz : 0;
      const nr = nz > 0 ? rng.bipolar() * nz : 0;
      heldLeft = Math.round((xl + nl) / step) * step;
      heldRight = Math.round((xr + nr) / step) * step;
    }
    buffer[n * 2] = xl * dry + heldLeft * mix;
    buffer[n * 2 + 1] = xr * dry + heldRight * mix;
  }
}

// ---------------------------------------------------------------------------
// Rectifier
// ---------------------------------------------------------------------------

export type RectifierParams = {
  /** 0 = half wave (asymmetric, adds even harmonics + DC), 1 = full wave. */
  mode: number; // 0 | 1
  /** Wet amount 0..1. */
  mix: number;
  /** Output gain in dB −24..12. */
  outputDb: number;
  sampleRate: number;
};

/** DC blocker state (per channel): y = x − x₁ + R·y₁ at ~10 Hz. */
type DcBlocker = { x1: number; y1: number };

function dcBlockSample(state: DcBlocker, x: number, r: number): number {
  const y = x - state.x1 + r * state.y1;
  state.x1 = x;
  state.y1 = y;
  return y;
}

/**
 * Half/full-wave rectifier (octave-up harmonics) with DC removal on the
 * wet path. In-place; length unchanged.
 */
export function applyRectifier(buffer: StereoBuffer, params: RectifierParams): void {
  const sampleRate = Math.max(1, params.sampleRate);
  const frames = buffer.length / 2;
  const full = clamp(params.mode, 0, 1) >= 0.5;
  const mix = clamp(params.mix, 0, 1);
  const dry = 1 - mix;
  const out = dspDbToGain(clamp(params.outputDb, -24, 12));
  const r = 1 - (2 * Math.PI * 10) / sampleRate;

  const dcL: DcBlocker = { x1: 0, y1: 0 };
  const dcR: DcBlocker = { x1: 0, y1: 0 };
  for (let n = 0; n < frames; n += 1) {
    const xl = Number.isFinite(buffer[n * 2]) ? buffer[n * 2] : 0;
    const xr = Number.isFinite(buffer[n * 2 + 1]) ? buffer[n * 2 + 1] : xl;
    const wl = full ? Math.abs(xl) : Math.max(xl, 0);
    const wr = full ? Math.abs(xr) : Math.max(xr, 0);
    const yl = dcBlockSample(dcL, wl, r);
    const yr = dcBlockSample(dcR, wr, r);
    buffer[n * 2] = (xl * dry + yl * mix) * out;
    buffer[n * 2 + 1] = (xr * dry + yr * mix) * out;
  }
}
