import {
  normalizePickerResult,
  resolvePermission,
} from '../permissions';

describe('resolvePermission', () => {
  it('granted', () => {
    expect(resolvePermission({ granted: true, canAskAgain: true })).toBe('granted');
  });
  it('denied but can retry', () => {
    expect(resolvePermission({ granted: false, canAskAgain: true })).toBe('denied-can-retry');
  });
  it('permanently denied -> open settings', () => {
    expect(resolvePermission({ granted: false, canAskAgain: false })).toBe(
      'denied-open-settings',
    );
  });
});

describe('normalizePickerResult', () => {
  it('returns null when cancelled', () => {
    expect(normalizePickerResult({ canceled: true })).toBeNull();
  });
  it('returns null when no assets', () => {
    expect(normalizePickerResult({ canceled: false, assets: [] })).toBeNull();
    expect(normalizePickerResult({ canceled: false, assets: null })).toBeNull();
  });
  it('normalises the first asset with fallbacks', () => {
    const out = normalizePickerResult({
      canceled: false,
      assets: [{ uri: 'file:///x.jpg', width: null, height: undefined, assetId: 'abc' }],
    });
    expect(out).toEqual({ uri: 'file:///x.jpg', width: 0, height: 0, assetId: 'abc' });
  });
  it('drops null assetId to undefined', () => {
    const out = normalizePickerResult({
      canceled: false,
      assets: [{ uri: 'file:///y.jpg', width: 10, height: 20, assetId: null }],
    });
    expect(out?.assetId).toBeUndefined();
    expect(out?.width).toBe(10);
  });
});
