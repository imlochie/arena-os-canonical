import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { inspectBepInExAssembly } from "./arcade/bepinex-metadata.mjs";
import { BepInExPlugins, resolveBepInExPlugins } from "./arcade/bepinex-plugins.mjs";
import { BepInExProfiles } from "./arcade/bepinex-profiles.mjs";
import { prepareBepInExLaunch, clearBepInExLaunchCache } from "./arcade/bepinex-launch.mjs";
import { nativeProfileDirectory } from "./arcade/profile-paths.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const research = fileURLToPath(new URL("../generated-artifacts/bepinex-research/", import.meta.url));
let actual = true;
try { for (const name of ["ConfigurationManager.dll", "windows.zip"]) await access(path.join(research, name)); } catch { actual = false; }

test("native profile preparation and host execution share the existing 32-character save namespace", () => {
  const id = "fixture.game", scope = `mod-${randomUUID()}`;
  assert.equal(nativeProfileDirectory("/fixture", id, scope), path.join("/fixture", "profiles", sha(id).slice(0, 32), scope));
  assert.throws(() => nativeProfileDirectory("/fixture", id, "../other"), /identity/);
});
test("managed assembly inspection refuses nonassemblies and out-of-range headers", () => {
  assert.throws(() => inspectBepInExAssembly(Buffer.alloc(16)), /size/);
  const corrupt = Buffer.alloc(256); corrupt.writeUInt16LE(0x5a4d); corrupt.writeUInt32LE(0xffffffff, 60);
  assert.throws(() => inspectBepInExAssembly(corrupt), /out-of-range/);
});
const plugin = (id, requires = [], extra = {}) => ({ id, name: id, version: "1.2.0", requires, incompatible: [], processes: [], ...extra });
const assembly = (...plugins) => ({ enabled: true, metadata: { plugins } });
test("actual GUID dependency graph rejects missing, old, cyclic, incompatible and wrong-process plugins", () => {
  const dependency = { id: "base", minimum: "1.1", soft: false };
  assert.deepEqual(resolveBepInExPlugins([assembly(plugin("mod", [dependency])), assembly(plugin("base"))]), ["base", "mod"]);
  assert.throws(() => resolveBepInExPlugins([assembly(plugin("mod", [dependency]))]), /requires enabled/);
  assert.throws(() => resolveBepInExPlugins([assembly(plugin("mod", [dependency])), assembly(plugin("base", [], { version: "1.0" }))]), />=/);
  assert.throws(() => resolveBepInExPlugins([assembly(plugin("a", [{ id: "b", soft: false }])), assembly(plugin("b", [{ id: "a", soft: false }]))]), /Cyclic/);
  assert.throws(() => resolveBepInExPlugins([assembly(plugin("a", [], { incompatible: ["b"] })), assembly(plugin("b"))]), /incompatible/);
  assert.throws(() => resolveBepInExPlugins([assembly(plugin("a", [], { processes: ["Other.exe"] }))], "Game.exe"), /restricted/);
  assert.deepEqual(resolveBepInExPlugins([assembly(plugin("a", [{ id: "missing", soft: true }]))]), ["a"]);
});
test("real third-party DLL metadata is inspected without loading or rewriting its assembly", { skip: !actual }, async () => {
  const bytes = await readFile(path.join(research, "ConfigurationManager.dll"));
  assert.equal(sha(bytes), "143bb25e8f03ed8728224de0b72752de29c0962ff69d20ec685831ec7491b323");
  const metadata = inspectBepInExAssembly(bytes);
  assert.equal(metadata.assembly, "ConfigurationManager");
  assert.equal(metadata.plugins[0].id, "com.bepis.bepinex.configurationmanager");
  assert.equal(metadata.plugins[0].version, "19.1");
});
test("two profiles import original DLLs, enable/disable, repair and roll back without rewinding settings/saves", { skip: !actual }, async () => {
  // Filesystem + metadata evidence only. No DLL is loaded and no game runs.
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-real-plugins-"));
  const manager = new BepInExPlugins();
  const context = id => ({ storage: path.join(root, "protected", id), runtime: path.join(root, "runtime", id),
    host: "windows-x64", entry: "Game.exe", baseVersion: "sha256:" + "c".repeat(64), candidate: true, running: false, shareSaves: false });
  const a = context("a"), b = context("b"), bytes = await readFile(path.join(research, "ConfigurationManager.dll"));
  try {
    for (const c of [a, b]) await manager.change(c, { kind: "import", bytes, license: "LGPL-3.0; upstream LICENSE retained with the original download", authorized: true }, 0);
    let report = await manager.change(a, { kind: "toggle", id: "ConfigurationManager", enabled: true }, 1);
    assert.equal(report.assemblies[0].enabled, true);
    assert.equal((await manager.inspectContext(b)).assemblies[0].enabled, false);
    const runtime = path.join(a.runtime, "BepInEx", "plugins", "ConfigurationManager.dll");
    assert.equal(sha(await readFile(runtime)), sha(bytes));
    await writeFile(path.join(a.runtime, "save.dat"), "new progress");
    await mkdir(path.join(a.runtime, "BepInEx", "config"), { recursive: true });
    await writeFile(path.join(a.runtime, "BepInEx", "config", "user.cfg"), "new settings");
    await chmod(runtime, 0o600); await writeFile(runtime, "tampered");
    assert.match((await manager.inspectContext(a)).diagnostic, /integrity/);
    await manager.change(a, { kind: "repair" }, 2);
    assert.equal(sha(await readFile(runtime)), sha(bytes));
    await manager.change(a, { kind: "toggle", id: "ConfigurationManager", enabled: false }, 3);
    assert.deepEqual(await readdir(path.dirname(runtime)), []);
    report = await manager.change(a, { kind: "rollback" }, 4);
    assert.equal(report.assemblies[0].enabled, true);
    assert.equal(await readFile(path.join(a.runtime, "save.dat"), "utf8"), "new progress");
    assert.equal(await readFile(path.join(a.runtime, "BepInEx", "config", "user.cfg"), "utf8"), "new settings");
    await assert.rejects(manager.change(a, { kind: "repair" }, 1), /changed/);
    a.running = true; await assert.rejects(manager.change(a, { kind: "repair" }, 5), /stopped/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("pinned Windows Doorstop launch layout preserves the base, binds the actual private profile and caches safely", { skip: !actual }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-doorstop-layout-")), profile = randomUUID();
  const source = path.join(root, "source"); await mkdir(source);
  // Marker is expressly not a Unity executable or gameplay test.
  const marker = Buffer.from("non-executable layout fixture");
  await writeFile(path.join(source, "Game.exe"), marker);
  const context = { storage: path.join(root, "protected"), runtime: nativeProfileDirectory(root, "fixture", `mod-${profile}`),
    install: source, host: "windows-x64", candidate: true, shareSaves: false, running: false, baseVersion: "sha256:" + sha(marker),
    descriptor: { entry: "Game.exe", files: [{ path: "Game.exe", sha256: sha(marker), bytes: marker.length }] } };
  try {
    const manager = new BepInExProfiles(async () => context);
    await manager.change("fixture", profile, { archive: path.join(research, "windows.zip") });
    const state = await manager.read(context), install = await prepareBepInExLaunch(context, state);
    assert.equal(await readFile(path.join(source, "Game.exe"), "utf8"), marker.toString());
    assert.match(await readFile(path.join(install, "doorstop_config.ini"), "utf8"), /enabled=true/);
    assert.ok((await readFile(path.join(install, "doorstop_config.ini"), "utf8")).includes(`target_assembly=${path.join(context.runtime, "BepInEx", "core", "BepInEx.Preloader.dll")}`));
    assert.equal(await prepareBepInExLaunch(context, state), install);
    await chmod(path.join(install, "Game.exe"), 0o600); await writeFile(path.join(install, "Game.exe"), "tampered");
    await assert.rejects(prepareBepInExLaunch(context, state), /integrity failed/);
    await clearBepInExLaunchCache(context);
    assert.equal(await prepareBepInExLaunch(context, state), install);
    assert.equal((await readdir(context.storage)).some(name => name.startsWith(".launch-stage")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
