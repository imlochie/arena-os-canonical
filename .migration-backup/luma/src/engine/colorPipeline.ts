/**
 * colorPipeline — pure color math that turns normalised adjustments into a
 * Skia-compatible 4x5 color matrix and runtime-shader uniforms.
 *
 * A Skia color matrix multiplies each pixel's [R,G,B,A,1] vector:
 *
 *   | m0  m1  m2  m3  m4 |   | R |
 *   | m5  m6  m7  m8  m9 | * | G |
 *   | m10 m11 m12 m13 m14|   | B |
 *   | m15 m16 m17 m18 m19|   | A |
 *                            | 1 |
 *
 * We build separate matrices for each operation and multiply them in a fixed,
 * photographically sensible order, then flatten to the 20-element array Skia
 * expects. All inputs are the engine-agnostic ranges defined in types.ts.
 *
 * This file is pure (no native imports) and is the backbone of the engine test
 * suite — the same math runs in tests and on-device.
 */

import { Adjustments } from './types';
import { ColorMatrix, ShaderUniforms } from './ProcessingEngine';

// Rec. 709 luma coefficients (perceptual brightness weights).
const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

/** 4x5 matrix represented as 4 rows of 5. */
type M45 = [
  [number, number, number, number, number],
  [number, number, number, number, number],
  [number, number, number, number, number],
  [number, number, number, number, number],
];

function identity(): M45 {
  return [
    [1, 0, 0, 0, 0],
    [0, 1, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 1, 0],
  ];
}

/**
 * Multiply two 4x5 color matrices. Treated as 4x5 acting on the homogeneous
 * vector [R,G,B,A,1]; the implicit 5th row is [0,0,0,0,1].
 */
function multiply(a: M45, b: M45): M45 {
  const out = identity();
  for (let r = 0; r < 4; r++) {
    const ar = a[r]!;
    const outR = out[r]!;
    for (let c = 0; c < 5; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += ar[k]! * b[k]![c]!;
      }
      // The +1 (bias) column: add a's bias term times b's implicit 1.
      if (c === 4) sum += ar[4]!;
      outR[c] = sum;
    }
  }
  return out;
}

/** Combine an ordered list of matrices (applied left-to-right on the pixel). */
function combine(...mats: M45[]): M45 {
  // Applying m1 then m2 then m3 to a pixel p is m3*(m2*(m1*p)) => product
  // m3*m2*m1. We fold from the right so the first listed is applied first.
  return mats.reduce((acc, m) => multiply(m, acc), identity());
}

/** Exposure in stops -> uniform RGB gain of 2^stops. */
function exposureMatrix(stops: number): M45 {
  const g = Math.pow(2, stops);
  return [
    [g, 0, 0, 0, 0],
    [0, g, 0, 0, 0],
    [0, 0, g, 0, 0],
    [0, 0, 0, 1, 0],
  ];
}

/**
 * Contrast around mid-grey (0.5). amount in [-1,1] maps to a scale in
 * [0.25, 2.0] which feels natural without clipping too aggressively.
 */
function contrastMatrix(amount: number): M45 {
  const scale = amount >= 0 ? 1 + amount : 1 / (1 - amount * 0.75);
  const t = 0.5 * (1 - scale);
  return [
    [scale, 0, 0, 0, t],
    [0, scale, 0, 0, t],
    [0, 0, scale, 0, t],
    [0, 0, 0, 1, 0],
  ];
}

/**
 * Saturation. amount in [-1,1]; -1 = greyscale, 0 = unchanged, 1 = +100%.
 * Standard luma-preserving saturation matrix.
 */
function saturationMatrix(amount: number): M45 {
  const s = 1 + amount; // [0,2]
  const inv = 1 - s;
  return [
    [inv * LR + s, inv * LG, inv * LB, 0, 0],
    [inv * LR, inv * LG + s, inv * LB, 0, 0],
    [inv * LR, inv * LG, inv * LB + s, 0, 0],
    [0, 0, 0, 1, 0],
  ];
}

/**
 * White balance. temperature in [-1,1] (warm+ / cool-), tint in [-1,1]
 * (magenta+ / green-). Implemented as gentle per-channel gains that preserve
 * overall brightness reasonably well.
 */
function whiteBalanceMatrix(temperature: number, tint: number): M45 {
  const t = temperature * 0.2; // keep it subtle
  const g = tint * 0.2;
  const rGain = 1 + t;
  const bGain = 1 - t;
  // Tint pushes green vs magenta: positive tint reduces green (more magenta).
  const gGain = 1 - g;
  const rgGain = 1 + g * 0.5; // slight red/blue lift for magenta
  return [
    [rGain * rgGain, 0, 0, 0, 0],
    [0, gGain, 0, 0, 0],
    [0, 0, bGain * rgGain, 0, 0],
    [0, 0, 0, 1, 0],
  ];
}

/**
 * Highlights/shadows approximation via a tone offset. A true tone curve needs a
 * shader/LUT (reserved for a later engine). For V1 we approximate:
 *  - shadows > 0 lifts the black point (adds a small bias).
 *  - highlights < 0 pulls the white point down (slight gain reduction).
 * This is intentionally gentle and monotonic.
 */
function toneMatrix(highlights: number, shadows: number): M45 {
  const lift = shadows * 0.12; // bias added to all channels
  // Highlights: negative reduces gain a touch (recover), positive adds gain.
  const hlGain = 1 + highlights * 0.12;
  return [
    [hlGain, 0, 0, 0, lift],
    [0, hlGain, 0, 0, lift],
    [0, 0, hlGain, 0, lift],
    [0, 0, 0, 1, 0],
  ];
}

/**
 * Fade / matte look: lifts blacks and slightly compresses the range, giving the
 * classic faded-film feel. amount in [0,1]. The grain/vignette parts of "fade"
 * live in the shader; this is just the tonal lift.
 */
function fadeMatrix(amount: number): M45 {
  const lift = amount * 0.18; // raise black point
  const scale = 1 - amount * 0.15; // compress toward the lift
  return [
    [scale, 0, 0, 0, lift],
    [0, scale, 0, 0, lift],
    [0, 0, scale, 0, lift],
    [0, 0, 0, 1, 0],
  ];
}

/** Flatten a 4x5 matrix into Skia's 20-element row-major array. */
function flatten(m: M45): ColorMatrix {
  return [...m[0], ...m[1], ...m[2], ...m[3]];
}


/**
 * Build the full effective color matrix for a set of adjustments.
 * Order (applied to the pixel in sequence):
 *   exposure -> white balance -> tone(hi/sh) -> contrast -> saturation -> fade
 */
export function buildColorMatrix(adj: Adjustments): ColorMatrix {
  const m = combine(
    exposureMatrix(adj.exposure),
    whiteBalanceMatrix(adj.temperature, adj.tint),
    toneMatrix(adj.highlights, adj.shadows),
    contrastMatrix(adj.contrast),
    saturationMatrix(adj.saturation),
    fadeMatrix(adj.fade),
  );
  return flatten(m);
}

/** The identity color matrix (no color change), useful as a default/fallback. */
export function identityColorMatrix(): ColorMatrix {
  return flatten(identity());
}

/** Build runtime-shader uniforms for effects a color matrix cannot express. */
export function buildShaderUniforms(adj: Adjustments, seed = 0): ShaderUniforms {
  return {
    grain: Math.max(0, Math.min(1, adj.grain)),
    vignette: Math.max(0, Math.min(1, adj.vignette)),
    fade: Math.max(0, Math.min(1, adj.fade)),
    grainSeed: seed,
  };
}

// Exposed for tests that want to check individual stages.
export const __test = {
  identity,
  multiply,
  combine,
  exposureMatrix,
  contrastMatrix,
  saturationMatrix,
  whiteBalanceMatrix,
  toneMatrix,
  fadeMatrix,
  flatten,
};
