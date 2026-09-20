import {
  addAdjustments,
  clampAdjustment,
  clampAdjustments,
  composeEffectiveAdjustments,
  fullPresetAdjustments,
  isRecipeNeutral,
  scaleTowardNeutral,
} from '../adjustments';
import {
  Adjustments,
  EditRecipe,
  EMPTY_RECIPE,
  NEUTRAL_ADJUSTMENTS,
  Preset,
} from '../types';

const preset: Preset = {
  id: 'test',
  name: 'Test',
  family: 'Digital',
  builtIn: true,
  defaultIntensity: 1,
  adjustments: { contrast: 0.4, saturation: 0.2, grain: 0.5 },
};

function recipe(over: Partial<EditRecipe> = {}): EditRecipe {
  return {
    ...EMPTY_RECIPE,
    adjustments: { ...NEUTRAL_ADJUSTMENTS },
    crop: { ...EMPTY_RECIPE.crop },
    ...over,
  };
}

describe('clamping', () => {
  it('clamps a value to its spec range', () => {
    expect(clampAdjustment('exposure', 5)).toBe(2);
    expect(clampAdjustment('exposure', -5)).toBe(-2);
    expect(clampAdjustment('grain', -1)).toBe(0);
    expect(clampAdjustment('saturation', 0.3)).toBe(0.3);
  });

  it('handles NaN/Infinity safely', () => {
    expect(clampAdjustment('contrast', NaN)).toBe(0);
    // +Infinity clamps to the range max; -Infinity to the min.
    expect(clampAdjustment('grain', Infinity)).toBe(1);
    expect(clampAdjustment('grain', -Infinity)).toBe(0);
  });

  it('clamps a whole adjustment set', () => {
    const dirty = { ...NEUTRAL_ADJUSTMENTS, exposure: 10, grain: -3 } as Adjustments;
    const clean = clampAdjustments(dirty);
    expect(clean.exposure).toBe(2);
    expect(clean.grain).toBe(0);
  });
});

describe('preset expansion', () => {
  it('fills unspecified keys with neutral', () => {
    const full = fullPresetAdjustments(preset);
    expect(full.contrast).toBe(0.4);
    expect(full.exposure).toBe(0);
    expect(full.vignette).toBe(0);
  });
});

describe('intensity scaling', () => {
  it('intensity 0 => neutral', () => {
    const full = fullPresetAdjustments(preset);
    const scaled = scaleTowardNeutral(full, 0);
    expect(scaled.contrast).toBe(0);
    expect(scaled.grain).toBe(0);
  });

  it('intensity 1 => full recipe', () => {
    const full = fullPresetAdjustments(preset);
    const scaled = scaleTowardNeutral(full, 1);
    expect(scaled.contrast).toBeCloseTo(0.4);
  });

  it('intensity 0.5 => halfway', () => {
    const full = fullPresetAdjustments(preset);
    const scaled = scaleTowardNeutral(full, 0.5);
    expect(scaled.contrast).toBeCloseTo(0.2);
    expect(scaled.grain).toBeCloseTo(0.25);
  });

  it('clamps intensity outside [0,1]', () => {
    const full = fullPresetAdjustments(preset);
    expect(scaleTowardNeutral(full, 2).contrast).toBeCloseTo(0.4);
    expect(scaleTowardNeutral(full, -1).contrast).toBe(0);
  });
});

describe('composition', () => {
  it('adds two adjustment sets', () => {
    const a = { ...NEUTRAL_ADJUSTMENTS, contrast: 0.2 };
    const b = { ...NEUTRAL_ADJUSTMENTS, contrast: 0.1, exposure: 0.5 };
    const sum = addAdjustments(a, b);
    expect(sum.contrast).toBeCloseTo(0.3);
    expect(sum.exposure).toBeCloseTo(0.5);
  });

  it('composes preset*intensity + manual offsets', () => {
    const r = recipe({
      presetId: 'test',
      presetIntensity: 0.5,
      adjustments: { ...NEUTRAL_ADJUSTMENTS, contrast: 0.1 },
    });
    const eff = composeEffectiveAdjustments(r, preset);
    // preset contrast 0.4 * 0.5 = 0.2, + manual 0.1 => 0.3
    expect(eff.contrast).toBeCloseTo(0.3);
    // preset saturation 0.2 * 0.5 = 0.1
    expect(eff.saturation).toBeCloseTo(0.1);
  });

  it('with no preset uses only manual adjustments', () => {
    const r = recipe({ adjustments: { ...NEUTRAL_ADJUSTMENTS, exposure: 0.3 } });
    const eff = composeEffectiveAdjustments(r, null);
    expect(eff.exposure).toBeCloseTo(0.3);
    expect(eff.contrast).toBe(0);
  });

  it('clamps the composed result', () => {
    const strong: Preset = { ...preset, adjustments: { contrast: 1 } };
    const r = recipe({
      presetId: 'test',
      presetIntensity: 1,
      adjustments: { ...NEUTRAL_ADJUSTMENTS, contrast: 1 },
    });
    const eff = composeEffectiveAdjustments(r, strong);
    expect(eff.contrast).toBe(1); // clamped from 2
  });
});

describe('neutrality', () => {
  it('detects a neutral recipe', () => {
    expect(isRecipeNeutral(recipe())).toBe(true);
  });
  it('a preset makes it non-neutral', () => {
    expect(isRecipeNeutral(recipe({ presetId: 'x' }))).toBe(false);
  });
  it('an adjustment makes it non-neutral', () => {
    expect(isRecipeNeutral(recipe({ adjustments: { ...NEUTRAL_ADJUSTMENTS, grain: 0.1 } }))).toBe(false);
  });
});
