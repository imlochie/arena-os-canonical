import { getEngine, setEngine } from '../index';
import { SkiaProcessingEngine } from '../SkiaProcessingEngine';
import {
  ProcessingEngine,
  ExportResult,
} from '../ProcessingEngine';
import {
  Adjustments,
  EditRecipe,
  EMPTY_RECIPE,
  NEUTRAL_ADJUSTMENTS,
  Preset,
  SourceAsset,
} from '../types';
import { identityColorMatrix } from '../colorPipeline';

describe('engine selection + isolation', () => {
  it('default engine is the Skia backend', () => {
    setEngine(new SkiaProcessingEngine());
    const e = getEngine();
    expect(e.capabilities.name).toMatch(/Skia/);
    expect(e.capabilities.colorMatrix).toBe(true);
  });

  it('pure math (no native) works: neutral => identity matrix', () => {
    const e = new SkiaProcessingEngine();
    const m = e.computeColorMatrix(NEUTRAL_ADJUSTMENTS);
    expect(m).toEqual(identityColorMatrix());
  });

  it('shader uniforms are computed without native code', () => {
    const e = new SkiaProcessingEngine();
    const u = e.computeShaderUniforms({ ...NEUTRAL_ADJUSTMENTS, grain: 0.5 }, 3);
    expect(u.grain).toBe(0.5);
    expect(u.grainSeed).toBe(3);
  });

  it('a replacement engine can be swapped in behind the interface', async () => {
    const calls: EditRecipe[] = [];
    const fake: ProcessingEngine = {
      capabilities: { colorMatrix: true, runtimeShader: false, export: true, name: 'Fake' },
      computeColorMatrix: () => identityColorMatrix(),
      computeShaderUniforms: () => ({ grain: 0, vignette: 0, fade: 0, grainSeed: 0 }),
      async exportImage(_s: SourceAsset, r: EditRecipe): Promise<ExportResult> {
        calls.push(r);
        return { uri: 'file:///out.jpg', width: 10, height: 10 };
      },
    };
    setEngine(fake);
    const e = getEngine();
    const preset: Preset | null = null;
    const recipe: EditRecipe = { ...EMPTY_RECIPE, adjustments: { ...NEUTRAL_ADJUSTMENTS } };
    const out = await e.exportImage!(
      { uri: 'file:///in.jpg', width: 10, height: 10 },
      recipe,
      preset,
    );
    expect(out.uri).toBe('file:///out.jpg');
    expect(calls).toHaveLength(1);
    // restore default for other suites
    setEngine(new SkiaProcessingEngine());
  });
});

describe('deterministic image-processing fixture', () => {
  // A tiny deterministic "image" is a set of representative pixels. We push them
  // through the engine's color matrix and assert stable, expected outcomes.
  const engine = new SkiaProcessingEngine();

  function apply(m: number[], px: [number, number, number, number]) {
    const [r, g, b, a] = px;
    const out: number[] = [];
    for (let row = 0; row < 4; row++) {
      const o = row * 5;
      out.push(m[o]! * r + m[o + 1]! * g + m[o + 2]! * b + m[o + 3]! * a + m[o + 4]!);
    }
    return out;
  }

  const fixture: [number, number, number, number][] = [
    [0, 0, 0, 1], // black
    [1, 1, 1, 1], // white
    [0.5, 0.5, 0.5, 1], // grey
    [0.8, 0.2, 0.2, 1], // red-ish
  ];

  it('is stable and reproducible for a given recipe', () => {
    const adj: Adjustments = { ...NEUTRAL_ADJUSTMENTS, contrast: 0.3, saturation: -0.5 };
    const m1 = engine.computeColorMatrix(adj);
    const m2 = engine.computeColorMatrix(adj);
    expect(m1).toEqual(m2); // deterministic
    const results = fixture.map((px) => apply(m1, px));
    // Snapshot-like invariants (kept numeric so no external files needed):
    expect(results[0]![0]).toBeLessThan(0.2); // black stays dark
    expect(results[1]![0]).toBeGreaterThan(0.8); // white stays bright
  });
});
