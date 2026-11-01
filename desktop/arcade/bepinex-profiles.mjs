import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { writeSyncedAtomic } from "../atomic-file.mjs";
import { BEPINEX_RELEASES } from "./bepinex.mjs";
import { stageBepInExDistribution } from "./bepinex-distribution.mjs";
import { safePackagePath } from "./packages.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function directoryTree(folder, create = false) {
  const absolute = path.resolve(folder);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) await mkdir(current).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Loader storage has a linked or non-directory ancestor.");
  }
}
export async function ordinaryFile(file, maxBytes) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes)
    throw new Error("Loader storage contains a linked, special or oversized file.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.nlink !== 1 || !opened.isFile() || opened.size > maxBytes)
      throw new Error("Loader file changed while opening.");
    const buffer = Buffer.alloc(opened.size + 1);
    let position = 0;
    while (position < buffer.length) {
      const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    if (position !== opened.size) throw new Error("Loader file changed while reading.");
    return buffer.subarray(0, position);
  } finally { await handle.close(); }
}
async function inspectCore(folder, expected) {
  await directoryTree(folder);
  const inventory = new Map(expected.map(file => [file.path, file]));
  const entries = await readdir(folder, { withFileTypes: true });
  if (entries.length !== expected.length) throw new Error("Loader core has missing or unexpected files. Repair before use.");
  for (const entry of entries) {
    const file = inventory.get(entry.name);
    if (!file || sha(await ordinaryFile(path.join(folder, entry.name), 4 * 1024 * 1024)) !== file.sha256)
      throw new Error("Loader core integrity failed. Repair before use.");
  }
}

// Companion state for an EXISTING Workshop profile. No parallel game/profile
// identities, no shared saves, and no game/plugin execution in this service.
export class BepInExProfiles {
  constructor(context) { this.context = context; }
  async location(key, profileId) {
    if (!uuid.test(profileId)) throw new Error("Select an existing Workshop profile.");
    const context = await this.context(key, profileId);
    if (context.shareSaves) throw new Error("Loader preparation currently requires a profile with its own saves.");
    return context;
  }
  async read(context) {
    try {
      await directoryTree(context.storage);
      const state = JSON.parse((await ordinaryFile(path.join(context.storage, "index.json"), 128 * 1024)).toString());
      const pin = BEPINEX_RELEASES[context.host];
      if (state.schema !== 1 || !Array.isArray(state.history) || state.history.length > 4)
        throw new Error("Loader history is incompatible or corrupt.");
      for (const record of [state, ...state.history]) {
        if (!pin || !uuid.test(record.generation) || record.baseVersion !== context.baseVersion ||
            record.archiveSha256 !== pin.sha256 || record.version !== pin.version ||
            !Array.isArray(record.core) || !record.core.length || record.core.length > 64)
          throw new Error("Loader profile state is incompatible or corrupt; existing saves were retained.");
        const names = new Set();
        for (const file of record.core) {
          safePackagePath(file.path);
          if (file.path.includes("/") || names.has(file.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(file.sha256) ||
              !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 4 * 1024 * 1024)
            throw new Error("Invalid loader core inventory.");
          names.add(file.path.toLowerCase());
        }
        if (!names.has("bepinex.preloader.dll") || !names.has("bepinex.dll")) throw new Error("Loader core inventory is incomplete.");
      }
      return state;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async inspect(key, profileId) {
    return this.inspectContext(await this.location(key, profileId));
  }
  async inspectContext(context) {
    const state = await this.read(context);
    if (!state) return { status: "not-prepared", candidate: context.candidate, diagnostic: context.diagnostic ?? "",
      gameplayVerified: false, canLaunch: false, rollbackAvailable: false };
    let integrity = true, diagnostic = "";
    try { await inspectCore(path.join(context.runtime, "BepInEx", "core"), state.core); }
    catch (error) { integrity = false; diagnostic = error.message; }
    let log = "";
    try {
      await directoryTree(path.join(context.runtime, "BepInEx"));
      const file = path.join(context.runtime, "BepInEx", "LogOutput.log");
      // Never expose arbitrary profile files or follow a game-planted link.
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Loader log is not an ordinary file.");
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (opened.ino !== info.ino || opened.dev !== info.dev || !opened.isFile() || opened.nlink !== 1)
          throw new Error("Loader log changed while opening.");
        const bytes = Buffer.alloc(8192), { bytesRead } = await handle.read(bytes, 0, bytes.length, Math.max(0, info.size - bytes.length));
        log = bytes.subarray(0, bytesRead).toString("utf8");
      } finally { await handle.close(); }
    } catch (error) { if (error.code !== "ENOENT") diagnostic = `${diagnostic} Log unavailable: ${error.message}`.trim(); }
    return { status: integrity ? "prepared-unverified" : "repair-needed", candidate: context.candidate, integrity, diagnostic,
      version: state.version, archiveSha256: state.archiveSha256, coreFiles: state.core.length,
      log, rollbackAvailable: !!state.history.length, gameplayVerified: false, canLaunch: false };
  }
  async change(key, profileId, { archive, repair = false, rollback = false }) {
    const context = await this.location(key, profileId);
    if (!context.candidate) throw new Error("This game's Unity Mono compatibility assessment must pass before preparation.");
    if (context.running) throw new Error("Stop the native game before changing its loader files.");
    if (context.checkSpace) await context.checkSpace(64 * 1024 * 1024);
    await directoryTree(context.storage, true);
    const lockFile = path.join(context.storage, "prepare.lock");
    const lock = await open(lockFile, "wx").catch(error => {
      if (error.code === "EEXIST") throw new Error("Loader preparation is already active or was interrupted. No profile was changed.");
      throw error;
    });
    let newGeneration, coreStage, oldCore, oldCoreMoved = false, switched = false, committed = false;
    const core = path.join(context.runtime, "BepInEx", "core");
    try {
      let state = await this.read(context);
      const previousState = state;
      if (!state && (repair || rollback)) throw new Error("Prepare the pinned loader before attempting recovery.");
      if (rollback) {
        if (!state.history.length) throw new Error("No prior loader preparation is available.");
        state = { schema: 1, ...state.history[0], history: state.history.slice(1) };
      }
      if (!repair && !rollback) {
        newGeneration = randomUUID();
        const result = await stageBepInExDistribution({
          archive, host: context.host, destination: path.join(context.storage, newGeneration),
        });
        const previous = previousState ? (({ history, schema, ...record }) => record)(previousState) : null;
        state = { schema: 1, baseVersion: context.baseVersion, generation: newGeneration,
          version: result.version, archiveSha256: result.archiveSha256,
          history: previous ? [previous, ...previousState.history].slice(0, 4) : [],
          core: result.files.filter(file => file.path.startsWith("BepInEx/core/"))
            .map(file => ({ ...file, path: file.path.slice("BepInEx/core/".length) })) };
      }
      const source = path.join(context.storage, state.generation, "BepInEx", "core");
      await inspectCore(source, state.core);
      if (repair && context.clearLaunchCache) await context.clearLaunchCache();
      await directoryTree(path.join(context.runtime, "BepInEx"), true);
      // Config/cache/logs and ordinary saves are deliberately never copied,
      // removed, restored or migrated by core preparation/repair.
      coreStage = path.join(context.runtime, "BepInEx", `.core-stage-${randomUUID()}`);
      await mkdir(coreStage);
      for (const file of state.core) {
        const target = path.join(coreStage, file.path);
        await copyFile(path.join(source, file.path), target);
        if (sha(await ordinaryFile(target, 4 * 1024 * 1024)) !== file.sha256) throw new Error("Loader core changed during preparation.");
      }
      try {
        // A previous game can tamper with its writable core. Refuse links and
        // special files even during repair; never traverse them for deletion.
        await directoryTree(core);
        if (!previousState) throw new Error("This profile already has an unmanaged loader core; review it before preparation.");
        const entries = await readdir(core);
        if (entries.length > 128) throw new Error("Unexpected loader core inventory; manual review required.");
        for (const name of entries) await ordinaryFile(path.join(core, name), 4 * 1024 * 1024);
        oldCore = path.join(context.runtime, "BepInEx", `.core-previous-${randomUUID()}`);
        await rename(core, oldCore);
        oldCoreMoved = true;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await rename(coreStage, core); coreStage = null; switched = true;
      await writeSyncedAtomic(path.join(context.storage, "index.json"), JSON.stringify(state));
      committed = true;
      // This cleanup is non-authoritative; failure must not roll back a
      // successfully committed pointer and leave it referring to deleted bytes.
      if (oldCoreMoved) await rm(oldCore, { recursive: true, force: true }).catch(() => {});
      const retained = new Set([state.generation, ...state.history.map(record => record.generation)]);
      for (const record of previousState ? [previousState, ...previousState.history] : []) {
        if (!retained.has(record.generation)) await rm(path.join(context.storage, record.generation), { recursive: true, force: true }).catch(() => {});
      }
      return await this.inspectContext(context);
    } catch (error) {
      if (!committed && switched) await rm(core, { recursive: true, force: true });
      if (!committed && oldCoreMoved) await rename(oldCore, core);
      if (!committed && newGeneration) await rm(path.join(context.storage, newGeneration), { recursive: true, force: true });
      throw error;
    } finally {
      if (coreStage) await rm(coreStage, { recursive: true, force: true });
      await lock.close(); await rm(lockFile, { force: true });
    }
  }
}
