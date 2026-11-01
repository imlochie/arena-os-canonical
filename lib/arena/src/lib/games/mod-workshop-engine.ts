import { composeMods, encodeModPackage, modHash, modKey, parseModPackage, type ModBase, type ModPackage, type ModProfile } from "./mod-workshop";
export type WorkshopState = { revision: number; baseVersion: string; packages: Record<string, { digest: string; bytes: number }>; profiles: (ModProfile & { history: ModProfile[] })[]; activeProfileId: string | null };
export type WorkshopBase = ModBase & { title: string; gameKey: string; guard?: unknown; metadata?: { path: string; bytes: number; sha256: string }[] };
export type WorkshopStore = {
  base(key: string, paths?: string[]): Promise<WorkshopBase>;
  read(key: string): Promise<WorkshopState | null>;
  package(digest: string): Promise<string>;
  commit(key: string, expectedRevision: number, base: WorkshopBase, next: WorkshopState, packages: Record<string, string>, result?: Awaited<ReturnType<typeof composeMods>>): Promise<void>;
  validate?(base: WorkshopBase, result: Awaited<ReturnType<typeof composeMods>>): void;
};
type Change = { packageJson?: string; enabled?: string[]; order?: string[]; settings?: ModProfile["settings"]; remove?: string; restoreJson?: string };
const clone = <T>(value: T): T => structuredClone(value);
export class ModWorkshopEngine {
  private reviews = new Map<string, { key: string; revision: number; baseVersion: string; next: WorkshopState; additions: Record<string, string>; profileId: string; expiresAt: number }>();
  constructor(readonly store: WorkshopStore) {}
  private async context(key: string, revision?: number) {
    const base = await this.store.base(key), state = await this.store.read(key) ?? { revision: 0, baseVersion: base.version, packages: {}, profiles: [], activeProfileId: null };
    if (state.baseVersion !== base.version) throw new Error("The base game changed. Existing mod profiles are retained, but need an explicit compatible rebase; no profile was overwritten.");
    if (revision !== undefined && state.revision !== revision) throw new Error("Workshop changed in another window. Refresh before retrying.");
    return { base, state: clone(state) };
  }
  private async inventory(state: WorkshopState, additions: Record<string, string> = {}) {
    if (Object.keys(state.packages).length > 32 || Object.values(state.packages).reduce((n, p) => n + p.bytes, 0) > 24 * 1024 * 1024) throw new Error("This game's mod inventory is limited to 32 packages / 24 MiB JSON.");
    return Promise.all(Object.entries(state.packages).map(async ([key, reference]) => {
      const json = additions[reference.digest] ?? await this.store.package(reference.digest), mod = await parseModPackage(json);
      if (mod.digest !== reference.digest || modKey(mod) !== key) throw new Error("Stored mod integrity verification failed.");
      return mod;
    }));
  }
  private profile(state: WorkshopState, id: string) { const profile = state.profiles.find(item => item.id === id); if (!profile) throw new Error("Choose an existing mod profile."); return profile; }
  private async compose(key: string, packages: ModPackage[], profile: ModProfile) {
    const paths = [...new Set(packages.flatMap(mod => Object.keys(mod.manifest.base.files)))];
    const base = await this.store.base(key, paths), result = await composeMods(base, packages, profile);
    this.store.validate?.(base, result); return { base, result };
  }
  async inspect(key: string) {
    const { base, state } = await this.context(key), packages = await this.inventory(state);
    const files = base.metadata ?? await Promise.all(Object.entries(base.files).map(async ([path, bytes]) => ({ path, bytes: bytes.length, sha256: await modHash(bytes) })));
    return { revision: state.revision, game: { id: key, identity: base.id, title: base.title, kind: base.kind, version: base.version, files },
      packages: packages.map(mod => ({ key: modKey(mod), id: mod.manifest.id, name: mod.manifest.name, version: mod.manifest.version, license: mod.manifest.license.spdx, source: mod.manifest.source.url ?? "Local reviewed package", permissions: mod.manifest.permissions, settings: mod.manifest.settings })),
      profiles: state.profiles.map(({ history, ...profile }) => ({ ...profile, history: history.length })), activeProfileId: state.activeProfileId };
  }
  async create(key: string, name: string, shareSaves: boolean, revision: number) {
    if (typeof name !== "string" || !name.trim() || name.length > 80 || typeof shareSaves !== "boolean") throw new Error("Name the profile and explicitly choose save sharing.");
    const { base, state } = await this.context(key, revision);
    if (state.profiles.length >= 8) throw new Error("A game supports up to eight independent mod profiles.");
    state.profiles.push({ id: crypto.randomUUID(), name: name.trim(), enabled: [], order: [], settings: {}, shareSaves, history: [] });
    state.revision++; await this.store.commit(key, revision, base, state, {}); return this.inspect(key);
  }
  async review(key: string, profileId: string, change: Change, revision: number) {
    if (!change || typeof change !== "object" || Object.keys(change).some(k => !["packageJson", "enabled", "order", "settings", "remove", "restoreJson"].includes(k))) throw new Error("Invalid workshop change.");
    const { base, state } = await this.context(key, revision), additions: Record<string, string> = {};
    let profile = this.profile(state, profileId);
    const previous: ModProfile = clone(profile); delete (previous as any).history;
    if (change.restoreJson) {
      if (change.restoreJson.length > 28 * 1024 * 1024) throw new Error("Profile backup is oversized.");
      const backup = JSON.parse(change.restoreJson);
      if (backup.format !== "arena.arcade.mod-profile" || backup.schemaVersion !== 1 || backup.base?.id !== base.id || backup.base?.version !== base.version || !Array.isArray(backup.packages) || backup.packages.length > 32 || !Array.isArray(backup.excluded)) throw new Error("Profile backup needs this exact compatible base game.");
      for (const json of backup.packages) {
        const mod = await parseModPackage(json), encoded = encodeModPackage(mod);
        const existing = state.packages[modKey(mod)]; if (existing && existing.digest !== mod.digest) throw new Error("A package with this id/version has different bytes. Use a new version.");
        state.packages[modKey(mod)] = { digest: mod.digest, bytes: encoded.length }; additions[mod.digest] = encoded;
      }
      if (backup.excluded.some((reference: any) => !reference || state.packages[reference.key]?.digest !== reference.digest)) throw new Error("Restricted mod payloads were excluded. Import their exact licensed packages locally before restoring.");
      change = { ...change, enabled: backup.profile?.enabled, order: backup.profile?.order, settings: backup.profile?.settings };
    }
    if (change.packageJson) {
      const mod = await parseModPackage(change.packageJson), encoded = encodeModPackage(mod), existing = state.packages[modKey(mod)];
      if (existing && existing.digest !== mod.digest) throw new Error("This mod id/version already has different bytes. Updates need a new version.");
      state.packages[modKey(mod)] = { digest: mod.digest, bytes: encoded.length }; additions[mod.digest] = encoded;
      // Explicit update of an enabled version replaces only that mod's selection.
      profile.enabled = profile.enabled.filter(key => !key.startsWith(`${mod.manifest.id}@`)); profile.enabled.push(modKey(mod));
    }
    if (change.enabled !== undefined) profile.enabled = clone(change.enabled);
    if (change.order !== undefined) profile.order = clone(change.order);
    if (change.settings !== undefined) profile.settings = clone(change.settings);
    if (!Array.isArray(profile.enabled) || profile.enabled.some(key => typeof key !== "string") || !Array.isArray(profile.order) || profile.order.some(key => typeof key !== "string") || !profile.settings || Array.isArray(profile.settings) || typeof profile.settings !== "object" || JSON.stringify(profile.settings).length > 32768) throw new Error("Invalid profile selection/settings.");
    if (change.remove) profile.enabled = profile.enabled.filter(key => key !== change.remove);
    const packages = await this.inventory(state, additions), { result } = await this.compose(key, packages, profile);
    // Materialized dependency selection is explicit in the approved snapshot.
    profile.enabled = result.order; profile.order = result.order;
    profile.history = [previous, ...profile.history].slice(0, 8);
    state.revision++;
    const id = crypto.randomUUID(); for (const [id, item] of this.reviews) if (item.expiresAt < Date.now()) this.reviews.delete(id);
    if (this.reviews.size >= 16) throw new Error("Too many pending reviews. Commit or wait for a review to expire.");
    this.reviews.set(id, { key, revision, baseVersion: base.version, next: state, additions, profileId, expiresAt: Date.now() + 300000 });
    return { id, gameId: key, profileId, name: profile.name, order: result.order, addedDependencies: result.addedDependencies, changes: result.changes,
      warnings: ["Base files stay unchanged. Rollback restores mod content/settings, not older saves.", ...(profile.shareSaves ? ["This profile explicitly shares saves with the unmodified base game."] : []), "UPS, xdelta and framework plugins need independently installed, verified adapters; they are unavailable here."],
      permissions: [...new Set(packages.filter(p => result.order.includes(modKey(p))).flatMap(p => p.manifest.permissions))] };
  }
  async commit(id: string) {
    const review = this.reviews.get(id); if (!review || review.expiresAt < Date.now()) throw new Error("Mod preview expired. Review again.");
    const { base, state } = await this.context(review.key, review.revision);
    if (base.version !== review.baseVersion) throw new Error("The reviewed base changed.");
    const profile = this.profile(review.next, review.profileId), packages = await this.inventory(review.next, review.additions), composition = await this.compose(review.key, packages, profile);
    await this.store.commit(review.key, state.revision, composition.base, review.next, review.additions, review.next.activeProfileId === profile.id ? composition.result : undefined);
    this.reviews.delete(id); return this.inspect(review.key);
  }
  async activate(key: string, id: string, revision: number) {
    const { state } = await this.context(key, revision), profile = this.profile(state, id), packages = await this.inventory(state), { base, result } = await this.compose(key, packages, profile);
    state.activeProfileId = id; state.revision++; await this.store.commit(key, revision, base, state, {}, result); return this.inspect(key);
  }
  async rollback(key: string, id: string, revision: number) {
    const { state } = await this.context(key, revision), profile = this.profile(state, id), prior = profile.history[0];
    if (!prior) throw new Error("No known-good profile snapshot is available.");
    const packages = await this.inventory(state), { base, result } = await this.compose(key, packages, prior);
    Object.assign(profile, clone(prior), { history: profile.history.slice(1) });
    state.revision++; await this.store.commit(key, revision, base, state, {}, state.activeProfileId === id ? result : undefined); return this.inspect(key);
  }
  async export(key: string, id: string) {
    const { base, state } = await this.context(key), profile = this.profile(state, id), inventory = await this.inventory(state), resolved = await this.compose(key, inventory, profile);
    const packages = inventory.filter(mod => resolved.result.order.includes(modKey(mod))), excluded = packages.filter(mod => !mod.manifest.license.redistributable).map(mod => ({ key: modKey(mod), digest: mod.digest }));
    const { history: _, ...settings } = profile;
    return { json: JSON.stringify({ format: "arena.arcade.mod-profile", schemaVersion: 1, base: { id: base.id, version: base.version }, profile: settings,
      packages: packages.filter(mod => mod.manifest.license.redistributable).map(encodeModPackage), excluded }), excluded: excluded.map(item => item.key) };
  }
  async play(key: string, id: string) {
    const { state } = await this.context(key), profile = this.profile(state, id), packages = await this.inventory(state);
    return { ...await this.compose(key, packages, profile), profile };
  }
}
