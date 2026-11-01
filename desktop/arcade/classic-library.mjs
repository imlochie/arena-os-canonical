import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { writeSyncedAtomic } from "../atomic-file.mjs";
import path from "node:path";
import { CLASSIC_ADAPTERS, backupClassicConfiguration, classicBinding } from "./classic.mjs";
import { packageDirectory } from "./directory-package.mjs";
import { packageKey, safePackagePath, validatePackageDescriptor } from "./packages.mjs";
import { sha256File } from "./pinned-zip.mjs";

const digest = s => createHash("sha256").update(s).digest("hex");
const MiB = 1024 * 1024;
export class ClassicLibrary {
  constructor({ packages, host }) { this.packages = packages; this.host = host; this.catalog = []; this.pins = []; }
  async initialize() {
    try {
      const raw = await readFile(path.join(this.packages.root, "classic-catalog.json"), "utf8");
      if (raw.length > 16 * MiB) throw new Error("Private classic catalog is too large.");
      const value = JSON.parse(raw);
      if (value.schemaVersion !== 1 || !Array.isArray(value.games) || value.games.length > 128 || !Array.isArray(value.pins) || value.pins.length > 64)
        throw new Error("Private classic catalog is malformed.");
      if (value.games.some(d => d.kind !== "game" || !d.classic) || value.pins.some(d => d.kind !== "runtime" || !d.classicRuntime))
        throw new Error("Private classic games and independently pinned runtimes have distinct catalog roles.");
      for (const d of [...value.pins, ...value.games]) {
        validatePackageDescriptor(d);
        if (!(d.kind === "game" ? d.classic : d.classicRuntime)) throw new Error("Unexpected private classic descriptor.");
        const old = this.packages.catalog.get(packageKey(d));
        if (old && old.sha256 !== d.sha256) throw new Error("A classic package identity was reused with different bytes.");
        this.packages.catalog.set(packageKey(d), structuredClone(d));
      }
      this.catalog = value.games; this.pins = value.pins;
      for (const d of this.catalog) classicBinding(d, this.packages.catalog);
    } catch (e) { if (e.code !== "ENOENT") throw new Error(`Classic catalog recovery stopped; original packages and saves were retained. ${e.message}`); }
  }
  choices() {
    const runtimes = [...this.packages.catalog.values()].filter(d => d.kind === "runtime" && d.classicRuntime);
    const choices = [];
    for (const [adapter, info] of Object.entries(CLASSIC_ADAPTERS)) {
      for (const rt of runtimes.filter(d => d.classicRuntime.adapter === (adapter === "libretro" ? "retroarch" : adapter))) {
        const cores = adapter === "libretro" ? runtimes.filter(d => d.classicRuntime.adapter === "gambatte-libretro" && d.classicRuntime.api === 1) : [null];
        for (const core of cores) {
          const runtime = packageKey(rt), coreKey = core ? packageKey(core) : undefined;
          choices.push({ id: digest(`${adapter}:${runtime}:${coreKey ?? ""}`).slice(0, 32), adapter, title: info.title, runtime, core: coreKey,
            ready: [runtime, coreKey].filter(Boolean).every(k => this.packages.state.packages[k]?.phase === "ready"),
            controls: info.controls, saves: info.saves, limitations: info.limitations,
            runtimeLicense: rt.classicRuntime.license, coreLicense: core?.classicRuntime.license ?? null });
        }
      }
    }
    return choices;
  }
  snapshot() {
    return { choices: this.choices(), imports: this.catalog.map(d => ({ key: packageKey(d), id: d.id, title: d.title ?? path.basename(d.entry), version: d.version, classic: d.classic })),
      adapters: Object.entries(CLASSIC_ADAPTERS).map(([id, info]) => ({ id, ...info, extension: undefined })),
      verification: "Windows execution/controls/audio/save acceptance is deferred. Installed packages and protocol tests are not gameplay proof." };
  }
  async persist() {
    const target = path.join(this.packages.root, "classic-catalog.json");
    await writeSyncedAtomic(target, JSON.stringify({ schemaVersion: 1, games: this.catalog, pins: this.pins }));
  }
  async rebind(key, choiceId, signal) {
    if (this.host.runningKeys().length) throw new Error("Stop the owned game before changing runtime bindings.");
    const old = this.catalog.find(d => packageKey(d) === key), choice = this.choices().find(c => c.id === choiceId);
    if (!old || !choice || old.classic.adapter !== choice.adapter) throw new Error("Runtime updates must retain the same verified adapter family.");
    if (old.classic.runtime === choice.runtime && old.classic.core === choice.core) throw new Error("This game is already pinned to that runtime/core.");
    const group = path.join(this.packages.root, "profiles", digest(old.id).slice(0, 32));
    const profiles = await readdir(group).catch(e => { if (e.code !== "ENOENT") throw e; return []; });
    for (const name of profiles.filter(n => /^(?:default|mod-[a-f0-9-]{36})$/.test(n)))
      await backupClassicConfiguration(path.join(group, name), this.packages.root);
    const existing = this.catalog.find(d => d.id === old.id && d.sha256 === old.sha256 &&
      d.classic.runtime === choice.runtime && d.classic.core === choice.core);
    if (existing) {
      await this.packages.install(packageKey(existing), path.join(this.packages.root, "downloads", `${existing.sha256}.tar`), signal);
      return existing;
    }
    await this.packages.verify(key, signal);
    return this.import({ choiceId, source: this.packages.filename(key), entry: old.entry, engine: old.classic.engine, signal,
      identity: { id: old.id, title: old.title, version: digest(`${key}:${choice.id}`).slice(0, 24) } });
  }
  async import({ choiceId, source, entry, engine, signal, identity }) {
    if (this.host.runningKeys().length) throw new Error("Stop the owned game before snapshotting classic data or changing runtime bindings.");
    if (this.catalog.length >= 128) throw new Error("Private classic catalog reached its managed limit.");
    const choice = this.choices().find(c => c.id === choiceId);
    if (!choice) throw new Error("Choose an exact trusted runtime/core combination.");
    if (choice.adapter === "scummvm" && !/^[a-z0-9][a-z0-9_-]{0,59}$/.test(engine ?? "")) throw new Error("Enter the explicit upstream ScummVM engine/game identifier.");
    safePackagePath(entry);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("Choose a regular authorized game folder.");
    const files = []; let bytes = 0, entries = 0;
    const walk = async (folder = "") => {
      for (const name of await readdir(path.join(source, folder))) {
        if ([".git", ".hg", ".svn"].includes(name)) continue;
        signal?.throwIfAborted();
        if (++entries > 4000) throw new Error("Classic source has too many directory entries.");
        const relative = folder ? `${folder}/${name}` : name; safePackagePath(relative);
        const info = await lstat(path.join(source, relative));
        if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw new Error("Classic input contains a link or special file.");
        if (info.isDirectory()) await walk(relative);
        else {
          if (relative.length > 100 || files.length >= 2000 || (bytes += info.size) > 256 * MiB) throw new Error("Classic inputs are limited to 2,000 files / 256 MiB.");
          files.push({ path: relative, bytes: info.size });
        }
      }
    };
    if (["libretro", "sameboy"].includes(choice.adapter)) {
      const info = await lstat(path.join(source, entry));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 0x150 || info.size > 8 * MiB)
        throw new Error("Choose a regular GB/GBC ROM between 336 bytes and 8 MiB.");
      files.push({ path: entry, bytes: info.size }); bytes = info.size;
    } else await walk();
    if (!files.some(f => f.path === entry)) throw new Error("Selected game entry is outside its authorized snapshot.");
    const usage = await this.packages.storage(), used = ["downloads", "staging", "installed", "profiles", "build-cache", "workshop"].reduce((sum, k) => sum + (usage[k] ?? Infinity), 0);
    const needed = bytes * 3 + files.length * 1024 + MiB;
    if (used + needed > usage.budgetBytes || usage.freeBytes - needed < usage.reserveBytes) throw new Error("Classic import would exceed the managed disk budget/reserve. No source was copied.");
    const work = path.join(this.packages.root, "staging", `classic-${randomUUID()}`), output = `${work}.tar`;
    await mkdir(work);
    try {
      for (const file of files) {
        signal?.throwIfAborted();
        const dest = path.join(work, file.path); await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(path.join(source, file.path), dest);
        const after = await lstat(dest);
        if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.size !== file.bytes) throw new Error("Source changed during its private snapshot.");
      }
      const classic = { adapter: choice.adapter, runtime: choice.runtime, ...(choice.core ? { core: choice.core } : {}),
        ...(choice.adapter === "scummvm" ? { engine } : {}) };
      const descriptor = await packageDirectory(work, output, { id: identity?.id ?? `private-classic-${randomUUID()}`, title: identity?.title ?? path.basename(entry, path.extname(entry)), version: identity?.version ?? "1", kind: "game", host: "windows-x64",
        license: "Owner-authorized personal game import. Copyright/data license not inferred. Not redistributable.",
        entry, arguments: [], runtimes: [choice.runtime, choice.core].filter(Boolean), classic }, signal);
      classicBinding(descriptor, this.packages.catalog);
      const target = path.join(this.packages.root, "downloads", `${descriptor.sha256}.tar`);
      try {
        await lstat(target);
        if (await sha256File(target, signal ?? new AbortController().signal) !== descriptor.sha256) throw new Error("Existing classic cache is corrupt; original games/saves were retained.");
        await rm(output);
      } catch (e) { if (e.code === "ENOENT") await rename(output, target); else throw e; }
      for (const pin of descriptor.runtimes) if (!this.pins.some(p => packageKey(p) === pin)) this.pins.push(structuredClone(this.packages.catalog.get(pin)));
      this.catalog.push(descriptor); await this.persist();
      this.packages.catalog.set(packageKey(descriptor), descriptor);
      await this.packages.install(packageKey(descriptor), target, { signal });
      return descriptor;
    } finally { await rm(work, { recursive: true, force: true }); await rm(output, { force: true }); }
  }
}
