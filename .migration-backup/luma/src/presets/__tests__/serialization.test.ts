import { BUILT_IN_PRESETS, getBuiltInPreset } from '../library';
import {
  deserializePreset,
  deserializePresetFile,
  duplicatePreset,
  isValidPreset,
  resetPresetTo,
  serializePreset,
  serializePresetFile,
} from '../serialization';
import { Preset } from '../../engine/types';

const sample: Preset = getBuiltInPreset('digi')!;

describe('preset validation', () => {
  it('accepts a valid preset', () => {
    expect(isValidPreset(sample)).toBe(true);
  });
  it('rejects non-objects and bad families', () => {
    expect(isValidPreset(null)).toBe(false);
    expect(isValidPreset({ ...sample, family: 'Nope' })).toBe(false);
    expect(isValidPreset({ ...sample, id: '' })).toBe(false);
  });
  it('rejects non-numeric adjustments', () => {
    expect(isValidPreset({ ...sample, adjustments: { contrast: 'x' } })).toBe(false);
  });
  it('ignores unknown/future adjustment keys', () => {
    expect(isValidPreset({ ...sample, adjustments: { contrast: 0.2, futureThing: 1 } })).toBe(true);
  });
});

describe('serialize / deserialize', () => {
  it('round-trips a single preset', () => {
    const json = serializePreset(sample);
    const back = deserializePreset(json);
    expect(back).toEqual(sample);
  });

  it('throws on invalid single preset json', () => {
    expect(() => deserializePreset('{"id":""}')).toThrow();
  });

  it('round-trips a preset file', () => {
    const presets = [duplicatePreset(sample), duplicatePreset(sample, ' Two')];
    const json = serializePresetFile(presets);
    const back = deserializePresetFile(json);
    expect(back).toHaveLength(2);
    expect(back[0]!.name).toContain('Copy');
  });

  it('drops invalid entries when loading a file', () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      presets: [sample, { id: '', name: 'bad' }],
    });
    const back = deserializePresetFile(payload);
    expect(back).toHaveLength(1);
    expect(back[0]!.id).toBe(sample.id);
  });

  it('every built-in preset survives a round-trip', () => {
    for (const p of BUILT_IN_PRESETS) {
      expect(deserializePreset(serializePreset(p))).toEqual(p);
    }
  });
});

describe('duplicate / reset', () => {
  it('duplicate creates an editable copy with a new id', () => {
    const copy = duplicatePreset(sample);
    expect(copy.id).not.toBe(sample.id);
    expect(copy.builtIn).toBe(false);
    expect(copy.name).toBe(`${sample.name} Copy`);
    // deep copy of adjustments
    copy.adjustments.contrast = 0.99;
    expect(sample.adjustments.contrast).not.toBe(0.99);
  });

  it('resetPresetTo restores recipe from a source', () => {
    const copy = duplicatePreset(sample);
    copy.adjustments = { contrast: 0 };
    const reset = resetPresetTo(copy, sample);
    expect(reset.adjustments).toEqual(sample.adjustments);
    expect(reset.id).toBe(copy.id); // identity preserved
  });
});

describe('built-in library integrity', () => {
  it('has unique ids', () => {
    const ids = BUILT_IN_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('covers all required families', () => {
    const families = new Set(BUILT_IN_PRESETS.map((p) => p.family));
    expect(families).toEqual(
      new Set(['Digital', 'Clean', 'Film', 'Black & White', 'Night']),
    );
  });
  it('all default intensities are within [0,1]', () => {
    for (const p of BUILT_IN_PRESETS) {
      expect(p.defaultIntensity).toBeGreaterThanOrEqual(0);
      expect(p.defaultIntensity).toBeLessThanOrEqual(1);
    }
  });
});
