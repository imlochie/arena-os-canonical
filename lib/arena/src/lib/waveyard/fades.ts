/**
 * Fade curves for clip edits and bounces.
 *
 * Adapted from SoundCraft's offline fade shapes (crates/dsp/src/offline.rs),
 * Copyright (c) 2026 ArtCraft Team and SoundCraft contributors,
 * dual-licensed MIT OR Apache-2.0 (https://github.com/storytold/soundcraft).
 * Clean-room TypeScript port of FadeShape::gain and the whole-buffer fade.
 *
 * `fadeGainAt` is the fade-IN curve; a fade-out uses gain(1 − t). The
 * platform default everywhere today is "linear" (the existing linear ramps
 * in preview and export), so adopting other shapes is opt-in per clip.
 */

import type { StereoBuffer } from "./mixer/dsp";

export const FADE_SHAPES = ["linear", "equal-power", "s-curve", "exponential", "logarithmic"] as const;

export type FadeShape = (typeof FADE_SHAPES)[number];

export function isFadeShape(value: unknown): value is FadeShape {
  return typeof value === "string" && (FADE_SHAPES as readonly string[]).includes(value);
}

/**
 * Shapes a persisted CLIP fade may use — the subset BOTH engines render
 * identically: the Web Audio preview (fadeGainAt curves) and the bundled
 * ffmpeg 4.1 afade (tri / qsin / hsin). "exponential" and "logarithmic"
 * remain available to applyFades (TS processing) but have no exact afade
 * equivalent, so they are deliberately not clip shapes — preview and
 * export must never disagree.
 */
export const CLIP_FADE_SHAPES = ["linear", "equal-power", "s-curve"] as const;

export type ClipFadeShape = (typeof CLIP_FADE_SHAPES)[number];

export function isClipFadeShape(value: unknown): value is ClipFadeShape {
  return typeof value === "string" && (CLIP_FADE_SHAPES as readonly string[]).includes(value);
}

/** Missing/undefined means "linear" (the historical behaviour). */
export function clipFadeShapeOrLinear(value: unknown): ClipFadeShape {
  return isClipFadeShape(value) ? value : "linear";
}

/**
 * Sample `count` (>= 2) gain points of the fade-in curve between `fromT`
 * and `toT` (positions in 0..1), endpoints inclusive. Used by the preview
 * to schedule exact curve segments — including resuming INTO a fade, where
 * fromT > 0. Returns gains in 0..1; callers scale by their base gain.
 */
export function fadeCurveSamples(
  shape: FadeShape,
  fromT: number,
  toT: number,
  count: number,
): Float32Array {
  const n = Math.max(2, Math.floor(count));
  const from = Number.isFinite(fromT) ? Math.min(1, Math.max(0, fromT)) : 0;
  const to = Number.isFinite(toT) ? Math.min(1, Math.max(0, toT)) : 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = from + (to - from) * (i / (n - 1));
    out[i] = fadeGainAt(shape, t);
  }
  return out;
}

/** Curve steepness for the exponential/logarithmic shapes. */
const K = 4;

/**
 * Fade-in gain at position t in 0..1 (0 → silent, 1 → unity). Out-of-range
 * and NaN inputs clamp to the endpoints.
 */
export function fadeGainAt(shape: FadeShape, t: number): number {
  const x = Number.isNaN(t) ? 0 : clamp01(t);
  switch (shape) {
    case "linear":
      return x;
    case "equal-power":
      // sin: constant power — for crossfades between uncorrelated material.
      return Math.sin((x * Math.PI) / 2);
    case "s-curve":
      // Raised cosine.
      return 0.5 - 0.5 * Math.cos(Math.PI * x);
    case "exponential":
      // Slow start, fast finish.
      return (Math.exp(K * x) - 1) / (Math.exp(K) - 1);
    case "logarithmic":
      // Fast start, slow finish.
      return Math.log(1 + (Math.exp(K) - 1) * x) / K;
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Fade a stereo buffer in over the first `fadeInFrames` frames and out over
 * the last `fadeOutFrames` frames, in place. Counts longer than the buffer
 * clamp to the buffer length; the curves never multiply by more than 1.
 */
export function applyFades(
  buffer: StereoBuffer,
  fadeInFrames: number,
  fadeOutFrames: number,
  shape: FadeShape = "linear",
): void {
  const frames = buffer.length / 2;
  const fi = Math.max(0, Math.min(Math.floor(fadeInFrames), frames));
  if (fi > 0) {
    for (let i = 0; i < fi; i += 1) {
      const g = fadeGainAt(shape, i / fi);
      buffer[i * 2] *= g;
      buffer[i * 2 + 1] *= g;
    }
  }
  const fo = Math.max(0, Math.min(Math.floor(fadeOutFrames), frames));
  if (fo > 0) {
    for (let j = 0; j < fo; j += 1) {
      // Fade-out mirrors the fade-in: the last frame is fully faded.
      const g = fadeGainAt(shape, (fo - 1 - j) / fo);
      const frame = frames - fo + j;
      buffer[frame * 2] *= g;
      buffer[frame * 2 + 1] *= g;
    }
  }
}
