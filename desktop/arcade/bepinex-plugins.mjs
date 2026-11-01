import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeSyncedAtomic } from "../atomic-file.mjs";
import { directoryTree, ordinaryFile } from "./bepinex-profiles.mjs";
import { inspectBepInExAssembly } from "./bepinex-metadata.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const MiB = 1024 * 1024;
const record = ({ history, ...value }) => value;

export function resolveBepInExPlugins(assemblies, executable = "") {
  const plugins = new Map();
  for (const assembly of assemblies.filter(item => item.enabled)) for (const plugin of assembly.metadata.plugins) {
    if (plugins.has(plugin.id)) throw new Error(`Duplicate enabled plugin GUID: ${plugin.id}`);
    const process = path.posix.basename(executable.replaceAll("\\", "/")).toLowerCase();
    if (plugin.processes.length && !plugin.processes.some(name =>
      [process, process.replace(/\.exe$/, "")].includes(name.toLowerCase())))
      throw new Error(`${plugin.name} is restricted to: ${plugin.processes.join(", ")}`);
    plugins.set(plugin.id, plugin);
  }
  const visiting = new Set(), visited = new Set(), order = [];
  const visit = id => {
    if (visiting.has(id)) throw new Error(`Cyclic plugin dependency at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    const plugin = plugins.get(id);
    for (const conflict of plugin.incompatible) if (plugins.has(conflict)) throw new Error(`${id} is incompatible with ${conflict}.`);
    for (const dependency of plugin.requires) {
      const installed = plugins.get(dependency.id);
      if (!installed) { if (!dependency.soft) throw new Error(`${id} requires enabled plugin ${dependency.id}.`); continue; }
      if (dependency.minimum) {
        const current = installed.version.split(".").map(Number), minimum = dependency.minimum.split(".").map(Number);
        let comparison = 0;
        for (let i = 0; i < 4 && !comparison; i++) comparison = (current[i] ?? -1) - (minimum[i] ?? -1);
        if (comparison < 0) throw new Error(`${id} requires ${dependency.id} >= ${dependency.minimum}.`);
      }
      visit(dependency.id);
    }
    visiting.delete(id); visited.add(id); order.push(id);
  };
  for (const id of plugins.keys()) visit(id);
  return order;
}

export class BepInExPlugins {
  async read(context) {
    try {
      await directoryTree(context.storage);
      const state = JSON.parse((await ordinaryFile(path.join(context.storage, "plugin-index.json"), MiB)).toString());
      if (state.schema !== 1 || state.baseVersion !== context.baseVersion || !Number.isSafeInteger(state.revision) ||
          !Array.isArray(state.history) || state.history.length > 4) throw new Error("Plugin profile state is incompatible or corrupt.");
      for (const snapshot of [state, ...state.history]) {
        if (snapshot.baseVersion !== context.baseVersion || !Array.isArray(snapshot.assemblies) || snapshot.assemblies.length > 16) throw new Error("Invalid plugin inventory.");
        const names = new Set();
        for (const assembly of snapshot.assemblies) {
          if (!/^[A-Za-z0-9_.-]{1,180}$/.test(assembly.id) || names.has(assembly.id.toLowerCase()) ||
              !/^[a-f0-9]{64}$/.test(assembly.sha256) || typeof assembly.enabled !== "boolean" ||
              !Number.isSafeInteger(assembly.bytes) || assembly.bytes < 1 || assembly.bytes > 16 * MiB ||
              typeof assembly.license !== "string" || assembly.license.length > 1000)
            throw new Error("Invalid plugin assembly record.");
          names.add(assembly.id.toLowerCase());
          const bytes = await this.bytes(context, assembly);
          // Never trust cached attribute declarations in the index.
          assembly.metadata = inspectBepInExAssembly(bytes);
          if (assembly.metadata.assembly !== assembly.id) throw new Error("Plugin assembly identity mismatch.");
        }
      }
      return state;
    } catch (error) { if (error.code === "ENOENT") {
      // Missing index means an empty profile, not missing payload recovery.
      try { await lstat(path.join(context.storage, "plugin-index.json")); } catch (missing) {
        if (missing.code === "ENOENT") return { schema: 1, baseVersion: context.baseVersion, revision: 0, assemblies: [], history: [] };
      }
      throw new Error("A protected plugin payload is missing. Restore its original DLL; no game was launched.");
    } throw error; }
  }
  async bytes(context, assembly) {
    await directoryTree(path.join(context.storage, "plugin-blobs"));
    const bytes = await ordinaryFile(path.join(context.storage, "plugin-blobs", `${assembly.sha256}.dll`), 16 * MiB);
    if (bytes.length !== assembly.bytes || sha(bytes) !== assembly.sha256) throw new Error("Protected plugin integrity failed.");
    return bytes;
  }
  async verifyRuntime(context, state) {
    const folder = path.join(context.runtime, "BepInEx", "plugins");
    const enabled = state.assemblies.filter(item => item.enabled);
    try { await directoryTree(folder); } catch (error) { if (error.code === "ENOENT" && !enabled.length) return; throw error; }
    const names = await readdir(folder);
    if (names.length !== enabled.length) throw new Error("Plugin runtime inventory differs. Repair plugins before launch.");
    for (const assembly of enabled) {
      const bytes = await ordinaryFile(path.join(folder, `${assembly.id}.dll`), 16 * MiB);
      if (sha(bytes) !== assembly.sha256) throw new Error("Plugin runtime integrity failed. Repair plugins before launch.");
    }
  }
  async inspectContext(context) {
    const state = await this.read(context);
    let diagnostic = "";
    try { resolveBepInExPlugins(state.assemblies, context.entry); await this.verifyRuntime(context, state); }
    catch (error) { diagnostic = error.message; }
    return { revision: state.revision, assemblies: state.assemblies,
      rollbackAvailable: !!state.history.length, diagnostic };
  }
  async change(context, change, expectedRevision) {
    if (!context.candidate || context.running || context.shareSaves) throw new Error("Use a compatible, stopped game profile with independent saves.");
    if (context.checkSpace) await context.checkSpace(64 * MiB);
    await directoryTree(context.storage, true);
    const lockPath = path.join(context.storage, "prepare.lock"), lock = await open(lockPath, "wx").catch(error => {
      if (error.code === "EEXIST") throw new Error("Another loader operation is active or interrupted.");
      throw error;
    });
    let stage, old, newBlob, moved = false, switched = false, committed = false;
    const target = path.join(context.runtime, "BepInEx", "plugins");
    try {
      const previous = await this.read(context);
      if (previous.revision !== expectedRevision) throw new Error("Plugin profile changed; refresh before applying this edit.");
      let next = structuredClone(previous);
      if (change.kind === "import") {
        if (change.authorized !== true || typeof change.license !== "string" || !change.license.trim() || change.license.length > 1000)
          throw new Error("Confirm permission and record the plugin's license/use terms.");
        const metadata = inspectBepInExAssembly(change.bytes), digest = sha(change.bytes);
        const existing = next.assemblies.findIndex(item => item.id.toLowerCase() === metadata.assembly.toLowerCase());
        if (existing < 0 && next.assemblies.length >= 16) throw new Error("A profile supports up to 16 managed assemblies.");
        const assembly = { id: metadata.assembly, sha256: digest, bytes: change.bytes.length, metadata,
          enabled: existing >= 0 ? next.assemblies[existing].enabled : false, license: change.license.trim() };
        if (existing >= 0) next.assemblies[existing] = assembly; else next.assemblies.push(assembly);
        await directoryTree(path.join(context.storage, "plugin-blobs"), true);
        const file = path.join(context.storage, "plugin-blobs", `${digest}.dll`);
        try { await writeFile(file, change.bytes, { flag: "wx", mode: 0o400 }); newBlob = file; }
        catch (error) { if (error.code !== "EEXIST") throw error; await this.bytes(context, assembly); }
      } else if (change.kind === "toggle") {
        const assembly = next.assemblies.find(item => item.id === change.id);
        if (!assembly || typeof change.enabled !== "boolean") throw new Error("Select an installed assembly.");
        assembly.enabled = change.enabled;
      } else if (change.kind === "rollback") {
        if (!previous.history.length) throw new Error("No previous plugin inventory.");
        next = { ...previous.history[0], history: previous.history.slice(1) };
      } else if (change.kind !== "repair") throw new Error("Unsupported plugin profile change.");
      resolveBepInExPlugins(next.assemblies, context.entry);
      if (!["repair", "rollback"].includes(change.kind))
        next.history = [record(previous), ...previous.history].slice(0, 4);
      next.revision = previous.revision + 1;
      const retained = new Map([next, ...next.history].flatMap(item => item.assemblies).map(item => [item.sha256, item.bytes]));
      if ([...retained.values()].reduce((a, b) => a + b, 0) > 64 * MiB) throw new Error("Plugin inventory/history exceeds the 64 MiB profile budget.");
      await directoryTree(path.dirname(target), true);
      stage = path.join(path.dirname(target), `.plugins-stage-${randomUUID()}`); await mkdir(stage);
      for (const assembly of next.assemblies.filter(item => item.enabled))
        await writeFile(path.join(stage, `${assembly.id}.dll`), await this.bytes(context, assembly), { flag: "wx", mode: 0o400 });
      try {
        await directoryTree(target);
        const names = await readdir(target);
        if (!previous.revision && names.length) throw new Error("Unmanaged plugin files exist; review them before importing.");
        if (names.length > 32) throw new Error("Unexpected plugin files; manual review required.");
        for (const name of names) await ordinaryFile(path.join(target, name), 16 * MiB);
        old = path.join(path.dirname(target), `.plugins-previous-${randomUUID()}`);
        await rename(target, old); moved = true;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await rename(stage, target); stage = null; switched = true;
      const json = JSON.stringify(next);
      if (Buffer.byteLength(json) > MiB) throw new Error("Plugin metadata/history exceeds its 1 MiB budget.");
      await writeSyncedAtomic(path.join(context.storage, "plugin-index.json"), json); committed = true;
      if (moved) await rm(old, { recursive: true, force: true }).catch(() => {});
      for (const name of await readdir(path.join(context.storage, "plugin-blobs")).catch(() => []))
        if (/^[a-f0-9]{64}\.dll$/.test(name) && !retained.has(name.slice(0, -4)))
          await rm(path.join(context.storage, "plugin-blobs", name)).catch(() => {});
      return await this.inspectContext(context);
    } catch (error) {
      if (!committed && switched) await rm(target, { recursive: true, force: true });
      if (!committed && moved) await rename(old, target);
      throw error;
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true });
      if (!committed && newBlob) await rm(newBlob, { force: true });
      await lock.close(); await rm(lockPath, { force: true });
    }
  }
}
