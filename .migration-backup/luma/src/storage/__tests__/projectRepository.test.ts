import { ProjectRepository, createProject } from '../projectRepository';
import { MemoryKVStore } from '../kvStore';
import { SourceAsset } from '../../engine/types';

const source: SourceAsset = { uri: 'file:///photo.jpg', width: 4000, height: 3000 };

describe('ProjectRepository', () => {
  let repo: ProjectRepository;

  beforeEach(() => {
    repo = new ProjectRepository(new MemoryKVStore());
  });

  it('starts empty', async () => {
    expect(await repo.list()).toEqual([]);
  });

  it('creates a project with a neutral recipe and empty canvas', () => {
    const p = createProject(source, 'My Edit');
    expect(p.recipe.presetId).toBeNull();
    expect(p.canvas.layers).toEqual([]);
    expect(p.source.uri).toBe(source.uri);
  });

  it('saves and retrieves a project', async () => {
    const p = createProject(source);
    const saved = await repo.save(p);
    const got = await repo.get(p.id);
    expect(got?.id).toBe(p.id);
    expect(saved.updatedAt).toBeGreaterThanOrEqual(p.createdAt);
  });

  it('does not modify the source asset uri (non-destructive)', async () => {
    const p = createProject(source);
    await repo.save(p);
    const got = await repo.get(p.id);
    expect(got?.source.uri).toBe(source.uri);
  });

  it('updates an existing project in place', async () => {
    const p = createProject(source);
    await repo.save(p);
    await repo.save({ ...p, name: 'Renamed' });
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('Renamed');
  });

  it('lists most-recently-updated first', async () => {
    const a = createProject(source);
    const b = createProject(source);
    await repo.save({ ...a, updatedAt: 1000 });
    await repo.save({ ...b, updatedAt: 2000 });
    const list = await repo.list();
    // save() bumps updatedAt to now, so both are recent; ensure ordering is by updatedAt desc.
    expect(list[0]!.updatedAt).toBeGreaterThanOrEqual(list[1]!.updatedAt);
  });

  it('removes a project', async () => {
    const p = createProject(source);
    await repo.save(p);
    await repo.remove(p.id);
    expect(await repo.get(p.id)).toBeNull();
  });

  it('survives corrupt storage gracefully', async () => {
    const store = new MemoryKVStore();
    await store.setItem('luma.projects.v1', '{not json');
    const r = new ProjectRepository(store);
    expect(await r.list()).toEqual([]);
  });

  it('persists across repository instances sharing a store', async () => {
    const store = new MemoryKVStore();
    const r1 = new ProjectRepository(store);
    const p = createProject(source);
    await r1.save(p);
    const r2 = new ProjectRepository(store);
    expect(await r2.get(p.id)).not.toBeNull();
  });
});
