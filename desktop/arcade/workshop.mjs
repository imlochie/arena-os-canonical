import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { ModWorkshopEngine } from "../../lib/arena/src/lib/games/mod-workshop-engine.ts";
import { modHash } from "../../lib/arena/src/lib/games/mod-workshop.ts";
import { safePackagePath } from "./packages.mjs";
import { assessUnityMonoLayout, identifyUnityVersion } from "./bepinex.mjs";
import { BepInExProfiles, directoryTree } from "./bepinex-profiles.mjs";
import { nativeProfileDirectory } from "./profile-paths.mjs";
import { BepInExPlugins, resolveBepInExPlugins } from "./bepinex-plugins.mjs";
import { prepareBepInExLaunch, clearBepInExLaunchCache } from "./bepinex-launch.mjs";
import { downloadBepInExDistribution } from "./bepinex-distribution.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
const MiB = 1024 * 1024;
async function fileHash(filename) { const hash = createHash("sha256"); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest("hex"); }
async function ordinary(filename, directory = false) {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw new Error("Workshop storage contains a link or special file.");
  return info;
}
export class NativeModWorkshop {
  constructor(packages, host) {
    this.packages = packages; this.host = host; this.root = path.join(packages.root, "workshop");
    this.loaders = new BepInExProfiles(async (key, profileId) => {
      const state = await this.read(key), profile = state?.profiles.find(profile => profile.id === profileId);
      if (!profile) throw new Error("Choose an existing Workshop profile.");
      const descriptor = this.packages.catalog.get(key), assessment = await this.assessLoader(key);
      if (state.baseVersion !== `sha256:${descriptor.sha256}`) throw new Error("This Workshop profile belongs to a different base version.");
      const launchStorage = path.join(this.root, "runs", hash(`${key}:${profileId}`).slice(0, 16));
      return {
        shareSaves: profile.shareSaves, candidate: assessment.candidate, host: descriptor.host,
        diagnostic: assessment.blockers.join(" "),
        descriptor, entry: descriptor.entry, install: this.packages.filename(key),
        launchStorage, clearLaunchCache: () => clearBepInExLaunchCache({ launchStorage }),
        baseVersion: `sha256:${descriptor.sha256}`,
        storage: path.join(this.folder(key), "loaders", profileId),
        runtime: nativeProfileDirectory(this.packages.root, descriptor.id, `mod-${profileId}`),
        running: [...this.host.runs.values()].some(run => run.child),
        checkSpace: async bytes => {
          const storage = await this.packages.storage();
          if (storage.freeBytes < storage.reserveBytes + bytes)
            throw new Error("Not enough free space to prepare loader files while retaining the disk reserve.");
          const sizes = ["downloads", "staging", "installed", "profiles", "build-cache", "workshop"]
            .map(name => storage[name] === null ? NaN : storage[name] ?? 0);
          if (!Number.isFinite(storage.budgetBytes) || sizes.some(size => !Number.isFinite(size)) ||
              sizes.reduce((sum, size) => sum + size, 0) + bytes > storage.budgetBytes)
            throw new Error("The managed storage budget cannot accommodate this loader operation. Free managed storage first.");
        },
      };
    });
    this.plugins = new BepInExPlugins();
    this.engine = new ModWorkshopEngine({
      base: (key, paths) => this.base(key, paths),
      read: key => this.read(key),
      package: async digest => { if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid package digest."); const file = path.join(this.root, "packages", digest + ".json"); if ((await ordinary(file)).size > 24 * MiB) throw new Error("Stored mod package is oversized."); return readFile(file, "utf8"); },
      commit: (...args) => this.commit(...args),
    });
  }
  async initialize() {
    await ordinary(this.packages.root, true);
    await mkdir(this.root, { recursive: true }); await ordinary(this.root, true);
    await mkdir(path.join(this.root, "packages"), { recursive: true }); await ordinary(path.join(this.root, "packages"), true);
  }
  folder(key) { return path.join(this.root, hash(key)); }
  async inspectLoader(key, profileId) {
    const context = await this.loaders.location(key, profileId);
    const core = await this.loaders.inspectContext(context), plugins = await this.plugins.inspectContext(context);
    const launchSupported = !!this.host.requirements?.().supportedHost && context.host === "windows-x64";
    return { ...core, plugins, launchSupported,
      canLaunch: launchSupported && !!core.integrity && !plugins.diagnostic && context.candidate && !context.running,
      launchBytes: context.descriptor.files.reduce((sum, file) => sum + file.bytes, 0),
      run: await this.loaderRun(key, profileId) };
  }
  async downloadLoader(key, profileId) {
    const context = await this.loaders.location(key, profileId);
    if (!context.candidate || context.running) throw new Error("Use a compatible, stopped Unity Mono profile.");
    await context.checkSpace(64 * MiB);
    await directoryTree(context.storage, true);
    const temporary = path.join(context.storage, `.download-${randomUUID()}.zip`);
    try {
      await downloadBepInExDistribution({ host: context.host, destination: temporary });
      await this.loaders.change(key, profileId, { archive: temporary });
      return this.inspectLoader(key, profileId);
    } finally { await rm(temporary, { force: true }); }
  }
  async loaderRun(key, profileId) {
    const state = await this.read(key), descriptor = this.packages.catalog.get(key);
    if (!descriptor || !state?.profiles.some(profile => profile.id === profileId)) throw new Error("Choose an existing native profile.");
    const directory = nativeProfileDirectory(this.packages.root, descriptor.id, `mod-${profileId}`);
    const run = [...this.host.runs.values()].filter(run => run.profile === directory).at(-1);
    return run ? { id: run.id, phase: run.phase, logs: run.logs, exitCode: run.exitCode, gameplayVerified: false } : null;
  }
  async changePlugins(key, profileId, change, revision) {
    const context = await this.loaders.location(key, profileId);
    if (!await this.loaders.read(context)) throw new Error("Prepare the pinned BepInEx loader first.");
    await this.plugins.change(context, change, revision);
    return this.inspectLoader(key, profileId);
  }
  async launchLoader(key, profileId) {
    const context = await this.loaders.location(key, profileId);
    if (!this.host.requirements().supportedHost || context.host !== "windows-x64")
      throw new Error("Modded launch requires the Windows x64 native host with a successful LPAC/Job containment probe.");
    if (context.running) throw new Error("Stop the current native game first.");
    if (!context.candidate) throw new Error("Unity Mono assessment failed.");
    await this.host.probe();
    const lockFile = path.join(context.storage, "prepare.lock");
    await directoryTree(context.storage, true);
    const lock = await open(lockFile, "wx").catch(error => {
      if (error.code === "EEXIST") throw new Error("Another loader operation is active or interrupted.");
      throw error;
    });
    try {
      const state = await this.loaders.read(context), core = await this.loaders.inspectContext(context);
      if (!state || !core.integrity) throw new Error("Prepare/repair the loader core before launch.");
      const plugins = await this.plugins.read(context);
      const order = resolveBepInExPlugins(plugins.assemblies, context.entry);
      await this.plugins.verifyRuntime(context, plugins);
      const { result } = await this.engine.play(key, profileId);
      const install = await prepareBepInExLaunch(context, state, result.files);
      await this.host.launch(key, { install, dataProfile: `mod-${profileId}`,
        bepinex: { version: state.version, archiveSha256: state.archiveSha256, plugins: order, gameplayVerified: false } });
    } finally { await lock.close(); await rm(lockFile, { force: true }); }
    return this.inspectLoader(key, profileId);
  }
  async assessLoader(key) {
    // Assess only immutable, hash-verified managed bytes. The preflight does
    // not stage files, enable plugin permissions or launch a game.
    const descriptor = await this.packages.verify(key);
    if (descriptor.kind !== "game" || !descriptor.entry || descriptor.runtimeEntry)
      throw new Error("Loader assessment requires a directly executable managed game.");
    safePackagePath(descriptor.entry);
    const filename = path.join(this.packages.filename(key), ...descriptor.entry.split("/"));
    await ordinary(filename);
    const file = await open(filename, "r");
    let header;
    try {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      header = buffer.subarray(0, bytesRead);
    } finally { await file.close(); }
    const root = path.posix.dirname(descriptor.entry), name = path.posix.basename(descriptor.entry).replace(/\.(?:exe|x86_64|x86)$/i, "");
    const metadataPath = `${root === "." ? "" : root + "/"}${name}_Data/globalgamemanagers`;
    let unityVersion = null;
    if (descriptor.files.some(file => file.path === metadataPath)) {
      const metadataFile = path.join(this.packages.filename(key), ...metadataPath.split("/"));
      await ordinary(metadataFile);
      const handle = await open(metadataFile, "r");
      try {
        const bytes = Buffer.alloc(256), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        unityVersion = identifyUnityVersion(bytes.subarray(0, bytesRead));
      } finally { await handle.close(); }
    }
    return assessUnityMonoLayout({
      files: descriptor.files.map(file => file.path), entry: descriptor.entry,
      header, host: descriptor.host, unityVersion,
    });
  }
  async read(key) {
    try {
      const filename = path.join(this.folder(key), "index.json"); await ordinary(this.folder(key), true);
      const info = await ordinary(filename); if (info.size > MiB) throw new Error("Workshop index is oversized.");
      return JSON.parse(await readFile(filename, "utf8")).state;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async base(key, paths) {
    const descriptor = this.packages.catalog.get(key);
    if (!descriptor || descriptor.kind !== "game" || this.packages.state.packages[key]?.phase !== "ready") throw new Error("Install a verified managed game first.");
    const files = Object.create(null);
    if (paths !== undefined) {
      await this.packages.verify(key); let total = 0;
      for (const filename of paths) {
        safePackagePath(filename);
        const original = descriptor.files.find(file => file.path.toLowerCase() === filename.toLowerCase());
        if (original && original.path !== filename) throw new Error("Overlay target differs from a base path only by case.");
        if (!original) continue;
        total += original.bytes; if (total > 64 * MiB) throw new Error("Modified native base files are limited to 64 MiB per review; untouched files are streamed separately.");
        const location = path.join(this.packages.filename(key), ...filename.split("/")); await ordinary(location);
        files[filename] = new Uint8Array(await readFile(location));
      }
    }
    return { id: descriptor.id, gameKey: key, title: descriptor.title ?? descriptor.id, version: `sha256:${descriptor.sha256}`, kind: "native", files,
      metadata: descriptor.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })) };
  }
  async commit(key, revision, base, state, additions, result) {
    const folder = this.folder(key); await mkdir(folder, { recursive: true }); await ordinary(folder, true);
    const lockPath = path.join(folder, "write.lock");
    let lock;
    try { lock = await open(lockPath, "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      await ordinary(lockPath);
      const owner = JSON.parse(await readFile(lockPath, "utf8").catch(() => "{}"));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("An interrupted empty workshop lock needs explicit recovery after closing other Arena instances. The retained profile is still playable.");
      let alive = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
      if (alive) throw new Error("Another native workshop write is active. No active profile was replaced.");
      await rm(lockPath); lock = await open(lockPath, "wx");
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync();
    let stage, promoted;
    try {
      if ((await this.read(key))?.revision !== revision && !((await this.read(key)) === null && revision === 0)) throw new Error("Workshop changed in another window. Refresh.");
      if ([...this.host.runs.values()].some(run => run.child && run.key === key)) throw new Error("Stop this game's running process before changing its profile.");
      const descriptor = await this.packages.verify(key);
      if (`sha256:${descriptor.sha256}` !== base.version) throw new Error("Base version changed after review.");
      const volume = await statfs(folder), extra = Object.values(additions).reduce((n, json) => n + Buffer.byteLength(json), 0) + (result ? descriptor.unpackedBytes + Object.values(result.files).reduce((n, bytes) => n + bytes.length, 0) : 0);
      if (Number(volume.bavail * volume.bsize) < extra + this.packages.reserveBytes) throw new Error("Insufficient space for atomic mod staging plus the retained active installation. No base or profile was deleted.");
      if (this.packages.storage) {
        const usage = await this.packages.storage(), sizes = ["downloads", "staging", "installed", "profiles", "build-cache", "workshop"].map(name => usage[name]);
        if (sizes.some(size => !Number.isFinite(size)) || sizes.reduce((sum, size) => sum + size, 0) + extra > this.packages.budgetBytes) throw new Error("Native disk accounting or storage budget prevents safe mod staging.");
      }
      let previous;
      try { previous = JSON.parse(await readFile(path.join(folder, "index.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      let generation = previous?.generation ?? null;
      // Recovery removes generated, unreferenced staging only; saves, mods and
      // the active generation remain authoritative and are never swept here.
      for (const name of await readdir(folder)) {
        if ((/^staging-[a-f0-9-]{36}$/.test(name) || /^index-[a-f0-9-]{36}\.tmp$/.test(name) || /^[a-f0-9-]{36}$/.test(name)) && name !== generation?.id) {
          const filename = path.join(folder, name), info = await lstat(filename);
          if (info.isSymbolicLink()) throw new Error("Unsafe abandoned workshop staging entry.");
          await rm(filename, { recursive: info.isDirectory(), force: true });
        }
      }
      if (result) {
        stage = path.join(folder, `staging-${randomUUID()}`); await mkdir(stage); await ordinary(stage, true);
        for (const file of descriptor.files) {
          const source = path.join(this.packages.filename(key), ...file.path.split("/")); await ordinary(source);
          const target = path.join(stage, ...file.path.split("/")); await mkdir(path.dirname(target), { recursive: true }); await copyFile(source, target);
          if (await fileHash(target) !== file.sha256) throw new Error("Base file changed while staging.");
        }
        for (const [filename, bytes] of Object.entries(result.files)) {
          const target = path.join(stage, ...safePackagePath(filename).split("/")); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
        }
        const hashes = new Map(descriptor.files.map(file => [file.path, file.sha256]));
        for (const [filename, bytes] of Object.entries(result.files)) hashes.set(filename, await modHash(bytes));
        const inventory = [...hashes].sort(([a], [b]) => a.localeCompare(b)).map(([filename, sha256]) => ({ path: filename, sha256 }));
        for (const file of inventory) await chmod(path.join(stage, ...file.path.split("/")), 0o444);
        generation = { id: randomUUID(), profileId: state.activeProfileId, files: inventory };
        promoted = path.join(folder, generation.id); await rename(stage, promoted); stage = null;
      }
      for (const [digest, json] of Object.entries(additions)) {
        const filename = path.join(this.root, "packages", `${digest}.json`);
        try { await ordinary(filename); if (await readFile(filename, "utf8") !== json) throw new Error("Immutable package content differs."); }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          const temporary = `${filename}.${randomUUID()}.tmp`, file = await open(temporary, "wx", 0o600);
          try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
          await rename(temporary, filename);
        }
      }
      const temporary = path.join(folder, `index-${randomUUID()}.tmp`), file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ state, generation })); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path.join(folder, "index.json")); promoted = null;
      if (previous?.generation?.id && previous.generation.id !== generation?.id) await rm(path.join(folder, previous.generation.id), { recursive: true, force: true }).catch(() => {});
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
      if (promoted) await rm(promoted, { recursive: true, force: true }).catch(() => {});
      await lock.close(); await rm(path.join(folder, "write.lock"), { force: true });
    }
  }
  async launch(key, profileId) {
    const state = await this.read(key);
    if (!state || state.activeProfileId !== profileId) throw new Error("Activate this reviewed profile before native launch.");
    const { profile, result } = await this.engine.play(key, profileId);
    const folder = this.folder(key), indexFile = path.join(folder, "index.json"); await ordinary(indexFile);
    const index = JSON.parse(await readFile(indexFile, "utf8")), generation = index.generation;
    if (!generation || generation.profileId !== profileId || !/^[a-f0-9-]{36}$/.test(generation.id)) throw new Error("The active mod installation is unavailable. Activate again to reconstruct it.");
    const install = path.join(folder, generation.id); await ordinary(install, true);
    const expected = new Map(this.packages.catalog.get(key).files.map(file => [file.path, file.sha256]));
    for (const [filename, bytes] of Object.entries(result.files)) expected.set(filename, await modHash(bytes));
    let count = 0;
    const verifyTree = async (directory, prefix = "") => {
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.length > 2000) throw new Error("Unexpected mod installation inventory.");
      for (const entry of entries) {
        const relative = prefix + entry.name, filename = path.join(directory, entry.name);
        safePackagePath(relative); if (relative.split("/").length > 20) throw new Error("Mod installation paths are too deep.");
        if (entry.isDirectory()) { await ordinary(filename, true); await verifyTree(filename, relative + "/"); }
        else {
          if (++count > 2128 || !expected.has(relative)) throw new Error("Unlisted file in mod installation.");
          await ordinary(filename);
          if (await fileHash(filename) !== expected.get(relative)) throw new Error("Active mod installation integrity failed. Activate again; no unverified code was launched.");
        }
      }
    };
    await verifyTree(install);
    if (count !== expected.size) throw new Error("Mod installation is missing expected files.");
    return this.host.launch(key, { install, dataProfile: profile.shareSaves ? "default" : `mod-${profile.id}` });
  }
}
