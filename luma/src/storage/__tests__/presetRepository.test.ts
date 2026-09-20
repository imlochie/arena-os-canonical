import { PresetRepository } from '../presetRepository';
import { MemoryKVStore } from '../kvStore';
import { BUILT_IN_PRESETS, getBuiltInPreset } from '../../presets/library';
import { duplicatePreset } from '../../presets/serialization';

describe('PresetRepository', () => {
  let repo: PresetRepository;

  beforeEach(() => {
    repo = new PresetRepository(new MemoryKVStore());
  });

  it('lists built-ins even with no user presets', async () => {
    const all = await repo.listAll();
    expect(all.length).toBe(BUILT_IN_PRESETS.length);
    expect(await repo.listUser()).toEqual([]);
  });

  it('saves and lists a user preset after the built-ins', async () => {
    const copy = duplicatePreset(getBuiltInPreset('digi')!);
    await repo.saveUser(copy);
    const all = await repo.listAll();
    expect(all.length).toBe(BUILT_IN_PRESETS.length + 1);
    expect(all[all.length - 1]!.id).toBe(copy.id);
  });

  it('updates an existing user preset in place', async () => {
    const copy = duplicatePreset(getBuiltInPreset('clean')!);
    await repo.saveUser(copy);
    await repo.saveUser({ ...copy, name: 'Tuned' });
    const user = await repo.listUser();
    expect(user).toHaveLength(1);
    expect(user[0]!.name).toBe('Tuned');
  });

  it('removes a user preset', async () => {
    const copy = duplicatePreset(getBuiltInPreset('digi')!);
    await repo.saveUser(copy);
    await repo.removeUser(copy.id);
    expect(await repo.listUser()).toEqual([]);
  });

  it('reset removes user presets but keeps built-ins', async () => {
    await repo.saveUser(duplicatePreset(getBuiltInPreset('digi')!));
    await repo.resetToBuiltIns();
    expect(await repo.listUser()).toEqual([]);
    expect((await repo.listAll()).length).toBe(BUILT_IN_PRESETS.length);
  });

  it('refuses to save an invalid preset', async () => {
    await expect(
      repo.saveUser({ id: '', name: 'x' } as never),
    ).rejects.toThrow();
  });
});
