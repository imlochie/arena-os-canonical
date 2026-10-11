import {
  buildColorMatrix,
  buildShaderUniforms,
  identityColorMatrix,
  __test,
} from '../colorPipeline';
import { NEUTRAL_ADJUSTMENTS } from '../types';

/** Apply a Skia 4x5 matrix to an [r,g,b,a] pixel (values 0..1). */
function applyMatrix(m: number[], px: [number, number, number, number]) {
  const [r, g, b, a] = px;
  const out: number[] = [];
  for (let row = 0; row < 4; row++) {
    const o = row * 5;
    out.push(m[o]! * r + m[o + 1]! * g + m[o + 2]! * b + m[o + 3]! * a + m[o + 4]!);
  }
  return out as unknown as [number, number, number, number];
}

describe('matrix helpers', () => {
  it('identity is 20 elements and a true identity', () => {
    const id = identityColorMatrix();
    expect(id).toHaveLength(20);
    const px: [number, number, number, number] = [0.3, 0.6, 0.9, 1];
    const out = applyMatrix(id, px);
    expect(out[0]).toBeCloseTo(0.3);
    expect(out[1]).toBeCloseTo(0.6);
    expect(out[2]).toBeCloseTo(0.9);
  });

  it('multiply of identity*identity is identity', () => {
    const m = __test.multiply(__test.identity(), __test.identity());
    expect(__test.flatten(m)).toEqual(identityColorMatrix());
  });
});

describe('buildColorMatrix', () => {
  it('neutral adjustments produce identity', () => {
    const m = buildColorMatrix(NEUTRAL_ADJUSTMENTS);
    expect(m).toHaveLength(20);
    const px: [number, number, number, number] = [0.4, 0.5, 0.6, 1];
    const out = applyMatrix(m, px);
    expect(out[0]).toBeCloseTo(0.4, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBeCloseTo(0.6, 5);
  });

  it('positive exposure brightens', () => {
    const m = buildColorMatrix({ ...NEUTRAL_ADJUSTMENTS, exposure: 1 });
    const out = applyMatrix(m, [0.25, 0.25, 0.25, 1]);
    // +1 stop doubles luminance
    expect(out[0]).toBeCloseTo(0.5, 5);
  });

  it('full desaturation collapses channels to luma', () => {
    const m = buildColorMatrix({ ...NEUTRAL_ADJUSTMENTS, saturation: -1 });
    const out = applyMatrix(m, [1, 0, 0, 1]);
    // pure red -> its luma across all channels
    expect(out[0]).toBeCloseTo(out[1]!, 5);
    expect(out[1]).toBeCloseTo(out[2]!, 5);
    expect(out[0]).toBeCloseTo(0.2126, 3);
  });

  it('warm temperature raises red relative to blue', () => {
    const m = buildColorMatrix({ ...NEUTRAL_ADJUSTMENTS, temperature: 1 });
    const out = applyMatrix(m, [0.5, 0.5, 0.5, 1]);
    expect(out[0]).toBeGreaterThan(out[2]!);
  });

  it('shadow lift raises a black pixel', () => {
    const m = buildColorMatrix({ ...NEUTRAL_ADJUSTMENTS, shadows: 1 });
    const out = applyMatrix(m, [0, 0, 0, 1]);
    expect(out[0]).toBeGreaterThan(0);
  });

  it('contrast increases separation around mid-grey', () => {
    const m = buildColorMatrix({ ...NEUTRAL_ADJUSTMENTS, contrast: 1 });
    const dark = applyMatrix(m, [0.25, 0.25, 0.25, 1]);
    const light = applyMatrix(m, [0.75, 0.75, 0.75, 1]);
    expect(dark[0]).toBeLessThan(0.25);
    expect(light[0]).toBeGreaterThan(0.75);
  });
});

describe('buildShaderUniforms', () => {
  it('passes through and clamps character params', () => {
    const u = buildShaderUniforms({ ...NEUTRAL_ADJUSTMENTS, grain: 2, vignette: 0.5, fade: -1 }, 7);
    expect(u.grain).toBe(1);
    expect(u.vignette).toBe(0.5);
    expect(u.fade).toBe(0);
    expect(u.grainSeed).toBe(7);
  });
});
