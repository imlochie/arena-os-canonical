/**
 * Dither — TPDF dither and requantization with optional first-order
 * error-feedback noise shaping — offline whole-buffer, in-place.
 *
 * Adapted from SoundCraft's Dither plugin (crates/dsp/src/plugins/utility.rs),
 * Copyright (c) 2026 ArtCraft Team and SoundCraft contributors,
 * dual-licensed MIT OR Apache-2.0 (https://github.com/storytold/soundcraft).
 * Clean-room TypeScript port: the quantization math (two uniform samples →
 * TPDF at ±½ LSB, round-to-nearest requantization, error feedback) is
 * preserved; a seeded LCG replaces their RNG so offline renders are
 * deterministic, and digital silence passes through as silence.
 */

import { clamp } from "./types";
import type { StereoBuffer } from "./dsp";

export type DitherParams = {
  /** Target bit depth: 16, 20, or 24 (24 is effectively transparent). */
  bitDepth: number; // 16..24
  /** First-order error-feedback noise shaping on/off (accepts 0 | 1). */
  noiseShaping: boolean | number;
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
 * Requantize to `bitDepth` bits with TPDF dither (and optional first-order
 * error-feedback noise shaping). Output stays on the quantization grid and
 * is clamped to [−1, 1 − LSB] — the honest representable range of an
 * N-bit two's-complement stream. Digital silence passes through as
 * silence. In-place; length unchanged.
 */
export function applyDither(buffer: StereoBuffer, params: DitherParams): void {
  const frames = buffer.length / 2;
  const bits = clamp(Math.round(params.bitDepth), 16, 24);
  const lsb = Math.pow(2, 1 - bits);
  const shape = params.noiseShaping === true || params.noiseShaping === 1;
  const rng = new Lcg(0xd17e);
  let errL = 0;
  let errR = 0;

  for (let n = 0; n < frames; n += 1) {
    for (let c = 0; c < 2; c += 1) {
      const idx = n * 2 + c;
      const x = buffer[idx];
      if (x === 0 || !Number.isFinite(x)) {
        buffer[idx] = 0;
        if (c === 0) errL = 0;
        else errR = 0;
        continue;
      }
      const err = c === 0 ? errL : errR;
      const v = shape ? x - err : x;
      // TPDF: the sum of two uniform sources, scaled to ±½ LSB.
      const d = (rng.bipolar() + rng.bipolar()) * 0.5 * lsb;
      const q = Math.round((v + d) / lsb) * lsb;
      if (c === 0) errL = q - v;
      else errR = q - v;
      buffer[idx] = clamp(q, -1, 1 - lsb);
    }
  }
}
