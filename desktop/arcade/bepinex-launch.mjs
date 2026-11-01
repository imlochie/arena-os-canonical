import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { directoryTree, ordinaryFile } from "./bepinex-profiles.mjs";
import { safePackagePath } from "./packages.mjs";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const proxyHash = "d3b62f4c9c3e2196ef82603c52d6b98c043a0d6c125c081fd33d7ca3798b41b8";
const cacheName = /^l-[a-f0-9]{24}$/;
export async function clearBepInExLaunchCache(context) {
  const storage = context.launchStorage ?? context.storage;
  try { await directoryTree(storage); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const names = await readdir(storage);
  if (names.length > 128) throw new Error("Unexpected loader launch cache inventory; review it before repair.");
  for (const name of names) if (cacheName.test(name)) {
    const folder = path.join(storage, name); await directoryTree(folder);
    await rm(folder, { recursive: true, force: true });
  }
}
async function fileHash(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Loader launch contains a link or special file.");
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Dedicated Windows Doorstop layout. It does not load a DLL in the main
// process, invoke shell hooks, or bypass NativeArcadeHost's LPAC/Job probe.
export async function prepareBepInExLaunch(context, state, overlays = {}) {
  if (context.host !== "windows-x64" || state.version !== "5.4.23.2")
    throw new Error("Modded launch is implemented only for the pinned Windows x64 BepInEx 5 distribution.");
  const descriptor = context.descriptor;
  const prefix = path.posix.dirname(descriptor.entry), root = prefix === "." ? "" : `${prefix}/`;
  const target = path.join(context.runtime, "BepInEx", "core", "BepInEx.Preloader.dll");
  if (/[\r\n\0]/.test(target)) throw new Error("Unsupported characters in the private loader path.");
  if (process.platform === "win32" && target.length >= 259) throw new Error("Use a shorter Arena data-folder path for portable Unity/BepInEx loading.");
  const ini = Buffer.from(`[General]\nenabled=true\ntarget_assembly=${target}\nredirect_output_log=false\nignore_disable_switch=false\n[UnityMono]\ndebug_enabled=false\n`);
  const proxy = await ordinaryFile(path.join(context.storage, state.generation, "winhttp.dll"), 4 * 1024 * 1024);
  if (digest(proxy) !== proxyHash) throw new Error("Pinned Doorstop proxy integrity failed; prepare the original loader ZIP again.");
  const generated = { [`${root}winhttp.dll`]: proxy, [`${root}doorstop_config.ini`]: ini };
  const expected = new Map(descriptor.files.map(file => [file.path, { sha256: file.sha256, bytes: file.bytes }]));
  for (const [file, bytes] of Object.entries(overlays)) {
    safePackagePath(file);
    if (file.toLowerCase().startsWith(`${root}bepinex/`.toLowerCase()) ||
        Object.keys(generated).some(name => name.toLowerCase() === file.toLowerCase()))
      throw new Error("A generic file mod conflicts with dedicated loader files.");
    expected.set(file, { sha256: digest(bytes), bytes: bytes.length });
  }
  for (const [file, bytes] of Object.entries(generated)) {
    if ([...expected.keys()].some(name => name.toLowerCase() === file.toLowerCase()))
      throw new Error("The base/mod profile already owns a Doorstop target.");
    expected.set(file, { sha256: digest(bytes), bytes: bytes.length });
  }
  const fingerprint = digest(JSON.stringify([...expected].sort((a, b) => a[0].localeCompare(b[0]))));
  // Keep Unity paths short enough for older Windows APIs; integrity is still
  // checked using full SHA-256 inventories, not the shortened directory key.
  const storage = context.launchStorage ?? context.storage;
  await directoryTree(storage, true);
  const cache = path.join(storage, `l-${fingerprint.slice(0, 24)}`);
  const verify = async folder => {
    await directoryTree(folder);
    let count = 0;
    const walk = async (directory, relative = "", depth = 0) => {
      if (depth > 20) throw new Error("Loader launch tree is too deep.");
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.length > 2200) throw new Error("Unexpected loader launch inventory.");
      for (const entry of entries) {
        const name = relative + entry.name, filename = path.join(directory, entry.name);
        safePackagePath(name);
        if (entry.isDirectory()) { await directoryTree(filename); await walk(filename, `${name}/`, depth + 1); }
        else {
          if (++count > 2200 || !expected.has(name) || await fileHash(filename) !== expected.get(name).sha256)
            throw new Error("Loader launch installation integrity failed.");
        }
      }
    };
    await walk(folder);
    if (count !== expected.size) throw new Error("Loader launch installation is incomplete.");
  };
  let exists = false;
  try { await lstat(cache); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (exists) {
    try { await verify(cache); return cache; }
    catch (error) { throw new Error(`${error.message} Remove/review the protected launch cache before retrying; the base is unchanged.`); }
  }
  if (context.checkSpace) await context.checkSpace([...expected.values()].reduce((sum, file) => sum + file.bytes, 0) + 64 * 1024 * 1024);
  const stage = path.join(storage, `.launch-stage-${randomUUID()}`); await mkdir(stage);
  try {
    for (const [file, bytes] of expected) {
      safePackagePath(file);
      const destination = path.join(stage, ...file.split("/")); await mkdir(path.dirname(destination), { recursive: true });
      if (process.platform === "win32" && path.join(cache, ...file.split("/")).length >= 259)
        throw new Error("Use a shorter Arena data-folder path; this Unity game exceeds portable Windows path limits.");
      if (Object.hasOwn(generated, file)) await writeFile(destination, generated[file], { flag: "wx", mode: 0o400 });
      else if (Object.hasOwn(overlays, file)) await writeFile(destination, overlays[file], { flag: "wx", mode: 0o400 });
      else await copyFile(path.join(context.install, ...file.split("/")), destination, constants.COPYFILE_FICLONE);
      if (await fileHash(destination) !== bytes.sha256) throw new Error("Base or reviewed overlay changed while constructing the loader installation.");
      await chmod(destination, 0o444);
    }
    await verify(stage); await rename(stage, cache);
    // Current cache only: ordinary profile rollback recomposes its cache from
    // protected base + reviewed overlays, rather than keeping full game copies.
    for (const name of await readdir(storage)) if (cacheName.test(name) && name !== path.basename(cache)) {
      const previous = path.join(storage, name);
      const info = await lstat(previous);
      if (info.isDirectory() && !info.isSymbolicLink()) await rm(previous, { recursive: true, force: true }).catch(() => {});
    }
    return cache;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
