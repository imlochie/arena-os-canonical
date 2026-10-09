import {
  DEFAULT_SETTINGS,
  SettingsRepository,
  exportParamsFor,
} from '../settings';
import { MemoryKVStore } from '../kvStore';

describe('settings', () => {
  it('exportParamsFor maps quality tiers', () => {
    expect(exportParamsFor('standard').maxDimension).toBe(2048);
    expect(exportParamsFor('high').maxDimension).toBe(4096);
    expect(exportParamsFor('max').maxDimension).toBeUndefined();
    expect(exportParamsFor('max').jpegQuality).toBe(1);
  });

  it('loads defaults when nothing is stored', async () => {
    const repo = new SettingsRepository(new MemoryKVStore());
    expect(await repo.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('saves and reloads settings', async () => {
    const store = new MemoryKVStore();
    const repo = new SettingsRepository(store);
    await repo.update({ haptics: false, exportQuality: 'max' });
    const again = new SettingsRepository(store);
    const loaded = await again.load();
    expect(loaded.haptics).toBe(false);
    expect(loaded.exportQuality).toBe('max');
  });

  it('merges partial updates over existing settings', async () => {
    const repo = new SettingsRepository(new MemoryKVStore());
    const next = await repo.update({ haptics: false });
    expect(next.haptics).toBe(false);
    expect(next.saveBehavior).toBe(DEFAULT_SETTINGS.saveBehavior);
  });

  it('falls back to defaults on corrupt data', async () => {
    const store = new MemoryKVStore();
    await store.setItem('luma.settings.v1', 'not json');
    const repo = new SettingsRepository(store);
    expect(await repo.load()).toEqual(DEFAULT_SETTINGS);
  });
});
