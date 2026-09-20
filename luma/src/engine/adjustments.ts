/**
 * Pure adjustment math: clamping, blending, and composition.
 *
 * This module has NO native or React dependencies so it is fully unit-testable
 * and deterministic. It defines how a Preset recipe + intensity + manual user
 * offsets combine into the single effective `Adjustments` set that the renderer
 * consumes.
 *
 *   effective = clamp( preset.adjustments * intensity + manualOffsets )
 *
 * Manual offsets are additive on top of the (intensity-scaled) preset so that
 * the two are independent: dialing preset intensity never destroys a user's
 * manual tweaks, which keeps editing genuinely non-destructive and predictable.
 */

import {
  ADJUSTMENT_KEYS,
  ADJUSTMENT_SPECS,
  Adjustments,
  EditRecipe,
  NEUTRAL_ADJUSTMENTS,
  Preset,
} from './types';

/** Clamp a single adjustment value to its spec range. */
export function clampAdjustment(key: keyof Adjustments, value: number): number {
  const spec = ADJUSTMENT_SPECS[key];
  // NaN has no meaningful position on the scale -> fall back to neutral/min.
  if (Number.isNaN(value)) return spec.bipolar ? 0 : spec.min;
  // +/-Infinity clamp naturally to the range extremes.
  return Math.min(spec.max, Math.max(spec.min, value));
}

/** Clamp every field of an Adjustments object to valid ranges. */
export function clampAdjustments(adj: Adjustments): Adjustments {
  const out = {} as Adjustments;
  for (const key of ADJUSTMENT_KEYS) {
    out[key] = clampAdjustment(key, adj[key]);
  }
  return out;
}

/**
 * Expand a preset's Partial<Adjustments> into a full Adjustments object,
 * filling unspecified keys with neutral values.
 */
export function fullPresetAdjustments(preset: Preset): Adjustments {
  return { ...NEUTRAL_ADJUSTMENTS, ...preset.adjustments };
}

/**
 * Scale a full adjustment set toward neutral by `intensity` in [0,1].
 * intensity=0 -> neutral, intensity=1 -> full recipe.
 */
export function scaleTowardNeutral(adj: Adjustments, intensity: number): Adjustments {
  const t = Math.min(1, Math.max(0, intensity));
  const out = {} as Adjustments;
  for (const key of ADJUSTMENT_KEYS) {
    // Neutral is 0 for every parameter in our schema, so this is a simple
    // multiply; kept explicit in case a future param has a non-zero neutral.
    const neutral = NEUTRAL_ADJUSTMENTS[key];
    out[key] = neutral + (adj[key] - neutral) * t;
  }
  return out;
}

/** Add two adjustment sets field-by-field (used for manual offsets). */
export function addAdjustments(a: Adjustments, b: Adjustments): Adjustments {
  const out = {} as Adjustments;
  for (const key of ADJUSTMENT_KEYS) {
    out[key] = a[key] + b[key];
  }
  return out;
}

/**
 * Compose the *effective* adjustments the renderer should apply for a recipe,
 * given the preset it references (or null for "Original").
 *
 * This is the single canonical definition of how an edit resolves to pixels'
 * parameters, and is the most heavily tested function in the engine.
 */
export function composeEffectiveAdjustments(
  recipe: EditRecipe,
  preset: Preset | null,
): Adjustments {
  const base = preset
    ? scaleTowardNeutral(fullPresetAdjustments(preset), recipe.presetIntensity)
    : { ...NEUTRAL_ADJUSTMENTS };
  const composed = addAdjustments(base, recipe.adjustments);
  return clampAdjustments(composed);
}

/** True if a recipe has no visible effect (neutral, no preset). */
export function isRecipeNeutral(recipe: EditRecipe): boolean {
  if (recipe.presetId !== null) return false;
  return ADJUSTMENT_KEYS.every((k) => recipe.adjustments[k] === NEUTRAL_ADJUSTMENTS[k]);
}

/** Deep-ish clone of an Adjustments object (flat scalars => shallow is fine). */
export function cloneAdjustments(adj: Adjustments): Adjustments {
  return { ...adj };
}
