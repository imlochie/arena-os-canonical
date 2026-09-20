/**
 * Deterministic, local adaptive-look primitives.
 *
 * Analysis is deliberately represented as normalized statistics rather than a
 * semantic/AI label. The resolver changes how strongly a creative recipe is
 * expressed, never which look the user selected.
 */
import { ADJUSTMENT_KEYS, Adjustments, Preset } from './types';
import { clampAdjustment, fullPresetAdjustments, scaleTowardNeutral } from './adjustments';

export interface ImageAnalysis {
  luminance: { mean: number; median: number; shadows: number; midtones: number; highlights: number; dynamicRange: number };
  colour: { saturation: number; temperature: number; tint: number; dominantHue: number; colourVariance: number };
  image: { width: number; height: number; aspectRatio: number; contrast: number; edgeDensity: number; estimatedNoise: number };
  content: { skinLikelihood: number; nightLikelihood: number };
}

export interface ResolvedRecipe {
  adjustments: Adjustments;
  presetId: string;
  intensity: number;
  analysis: ImageAnalysis;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const damp = (value: number, factor: number) => value * clamp01(factor);

/** Resolve a preset against deterministic image statistics without mutating it. */
export function resolveAdaptiveLook(
  preset: Preset,
  analysis: ImageAnalysis,
  intensity: number,
): ResolvedRecipe {
  const base = fullPresetAdjustments(preset);
  const saturationRoom = 1 - clamp01(analysis.colour.saturation);
  const warmthRoom = 1 - clamp01((analysis.colour.temperature + 1) / 2);
  const highlightRoom = 1 - clamp01(analysis.luminance.highlights);
  const shadowNeed = clamp01(1 - analysis.luminance.mean);
  const contrastRoom = 1 - clamp01(analysis.image.contrast);
  const noiseRoom = 1 - clamp01(analysis.image.estimatedNoise);
  const adaptive = { ...base };

  // Preserve the recipe's direction, but reduce boosts that the source already has.
  adaptive.saturation = damp(base.saturation, saturationRoom);
  adaptive.temperature = base.temperature >= 0
    ? damp(base.temperature, warmthRoom)
    : damp(base.temperature, clamp01((analysis.colour.temperature + 1) / 2));
  adaptive.contrast = base.contrast >= 0 ? damp(base.contrast, contrastRoom) : base.contrast;
  adaptive.highlights = base.highlights < 0
    ? base.highlights * clamp01(1 + analysis.luminance.highlights)
    : damp(base.highlights, highlightRoom);
  adaptive.shadows = base.shadows >= 0 ? damp(base.shadows, shadowNeed + 0.35) : base.shadows;
  adaptive.exposure = base.exposure >= 0
    ? base.exposure * clamp01(0.65 + shadowNeed)
    : base.exposure * clamp01(0.65 + analysis.luminance.highlights);
  adaptive.grain = damp(base.grain, noiseRoom);
  adaptive.vignette = damp(base.vignette, clamp01(1 - analysis.luminance.shadows * 0.5));

  const expressed = scaleTowardNeutral(adaptive, intensity);
  const adjustments = {} as Adjustments;
  for (const key of ADJUSTMENT_KEYS) adjustments[key] = clampAdjustment(key, expressed[key]);
  return { adjustments, presetId: preset.id, intensity: clamp01(intensity), analysis };
}

/** Build analysis from a normalized luminance/RGB sample set. Useful for native adapters and tests. */
export function analyzeSamples(
  samples: { r: number; g: number; b: number }[],
  width: number,
  height: number,
): ImageAnalysis {
  if (!samples.length) throw new Error('LUMA: cannot analyze an empty image sample.');
  const luma = samples.map((p) => (p.r * 0.2126 + p.g * 0.7152 + p.b * 0.0722) / 255);
  const sorted = [...luma].sort((a, b) => a - b);
  const mean = luma.reduce((a, b) => a + b, 0) / luma.length;
  const median = sorted[Math.floor(sorted.length / 2)] ?? mean;
  const shadows = luma.filter((v) => v < 0.25).length / luma.length;
  const highlights = luma.filter((v) => v > 0.75).length / luma.length;
  const saturation = samples.reduce((sum, p) => sum + (Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b)) / 255, 0) / samples.length;
  const temperature = samples.reduce((sum, p) => sum + (p.r - p.b) / 255, 0) / samples.length;
  const variance = luma.reduce((sum, v) => sum + (v - mean) ** 2, 0) / luma.length;
  return {
    luminance: { mean, median, shadows, midtones: clamp01(1 - shadows - highlights), highlights, dynamicRange: (sorted[sorted.length - 1] ?? 0) - (sorted[0] ?? 0) },
    colour: { saturation: clamp01(saturation), temperature: Math.max(-1, Math.min(1, temperature)), tint: 0, dominantHue: 0, colourVariance: variance },
    image: { width, height, aspectRatio: width / Math.max(1, height), contrast: clamp01(Math.sqrt(variance) * 3), edgeDensity: 0, estimatedNoise: 0 },
    content: { skinLikelihood: 0, nightLikelihood: clamp01(1 - mean * 2) },
  };
}
