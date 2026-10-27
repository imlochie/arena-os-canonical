import {
  CAMERAS,
  DEFAULT_CAMERA_ID,
  cameraForPresetId,
  getCamera,
} from '../catalog';
import { getBuiltInPreset } from '../../presets/library';
import { PRESET_FAMILIES } from '../../engine/types';

describe('camera catalog', () => {
  it('exposes exactly five cameras', () => {
    expect(CAMERAS).toHaveLength(5);
  });

  it('has unique ids and numbers', () => {
    expect(new Set(CAMERAS.map((c) => c.id)).size).toBe(5);
    expect(new Set(CAMERAS.map((c) => c.number)).size).toBe(5);
  });

  it('every camera maps to a real preset family', () => {
    for (const cam of CAMERAS) {
      expect(PRESET_FAMILIES).toContain(cam.family);
    }
  });

  it('every look id resolves to an existing built-in preset', () => {
    for (const cam of CAMERAS) {
      expect(cam.lookIds.length).toBeGreaterThan(0);
      for (const id of cam.lookIds) {
        expect(getBuiltInPreset(id)).toBeDefined();
      }
    }
  });

  it("each camera's looks all belong to its family", () => {
    for (const cam of CAMERAS) {
      for (const id of cam.lookIds) {
        expect(getBuiltInPreset(id)!.family).toBe(cam.family);
      }
    }
  });

  it('default look is one of the camera looks', () => {
    for (const cam of CAMERAS) {
      expect(cam.lookIds).toContain(cam.defaultLookId);
    }
  });

  it('collectively covers every preset family', () => {
    const families = new Set(CAMERAS.map((c) => c.family));
    expect(families).toEqual(new Set(PRESET_FAMILIES));
  });

  it('getCamera resolves and tolerates null/unknown', () => {
    expect(getCamera(CAMERAS[0]!.id)?.id).toBe(CAMERAS[0]!.id);
    expect(getCamera(null)).toBeUndefined();
    expect(getCamera('nope')).toBeUndefined();
  });

  it('DEFAULT_CAMERA_ID points to a real camera and its default look', () => {
    const camera = getCamera(DEFAULT_CAMERA_ID);
    expect(camera).toBeDefined();
    expect(camera?.defaultLookId).toBe('clean-girl');
    expect(camera?.lookIds).toContain(camera?.defaultLookId);
  });

  it('cameraForPresetId finds the owning camera', () => {
    const cam = cameraForPresetId('warm-film');
    expect(cam?.id).toBe('filmbox');
    expect(cameraForPresetId(null)).toBeUndefined();
    expect(cameraForPresetId('unknown-preset')).toBeUndefined();
  });

  it('hint values are within sane ranges', () => {
    for (const cam of CAMERAS) {
      expect(cam.hint.vignette).toBeGreaterThanOrEqual(0);
      expect(cam.hint.vignette).toBeLessThanOrEqual(1);
      expect(typeof cam.hint.mono).toBe('boolean');
    }
  });
});
