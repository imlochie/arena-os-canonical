import { analyzeSamples, ImageAnalysis, resolveAdaptiveLook } from '../adaptive';
import { getBuiltInPreset } from '../../presets/library';

const base: ImageAnalysis = {
  luminance: { mean: 0.5, median: 0.5, shadows: 0.2, midtones: 0.6, highlights: 0.2, dynamicRange: 0.8 },
  colour: { saturation: 0.3, temperature: 0, tint: 0, dominantHue: 0, colourVariance: 0.1 },
  image: { width: 100, height: 100, aspectRatio: 1, contrast: 0.4, edgeDensity: 0.2, estimatedNoise: 0.1 },
  content: { skinLikelihood: 0, nightLikelihood: 0 },
};

describe('adaptive looks', () => {
  const preset = getBuiltInPreset('digi-x')!;
  it('adapts dark, bright, saturated, warm, noisy and balanced inputs deterministically', () => {
    const dark = resolveAdaptiveLook(preset, { ...base, luminance: { ...base.luminance, mean: 0.12, shadows: 0.8 } }, 1);
    const bright = resolveAdaptiveLook(preset, { ...base, luminance: { ...base.luminance, mean: 0.85, highlights: 0.8 } }, 1);
    const saturated = resolveAdaptiveLook(preset, { ...base, colour: { ...base.colour, saturation: 1 } }, 1);
    const warm = resolveAdaptiveLook(preset, { ...base, colour: { ...base.colour, temperature: 1 } }, 1);
    const noisy = resolveAdaptiveLook(preset, { ...base, image: { ...base.image, estimatedNoise: 1 } }, 1);
    expect(dark.adjustments.exposure).toBeGreaterThan(bright.adjustments.exposure);
    expect(saturated.adjustments.saturation).toBe(0);
    expect(warm.adjustments.temperature).toBe(0);
    expect(noisy.adjustments.grain).toBe(0);
    expect(resolveAdaptiveLook(preset, base, 1)).toEqual(resolveAdaptiveLook(preset, base, 1));
  });
  it('intensity controls expression after adaptation', () => {
    const zero = resolveAdaptiveLook(preset, base, 0);
    const half = resolveAdaptiveLook(preset, base, 0.5);
    const full = resolveAdaptiveLook(preset, base, 1);
    expect(zero.adjustments.saturation).toBe(0);
    expect(Math.abs(half.adjustments.saturation)).toBeLessThan(Math.abs(full.adjustments.saturation));
  });
  it('does not mutate the source preset', () => {
    const before = JSON.stringify(preset);
    resolveAdaptiveLook(preset, base, 0.5);
    expect(JSON.stringify(preset)).toBe(before);
  });
  it('derives deterministic statistics from samples', () => {
    const result = analyzeSamples([{ r: 10, g: 10, b: 10 }, { r: 250, g: 250, b: 250 }], 20, 10);
    expect(result.image.width).toBe(20);
    expect(result.luminance.dynamicRange).toBeGreaterThan(0.9);
  });
});
