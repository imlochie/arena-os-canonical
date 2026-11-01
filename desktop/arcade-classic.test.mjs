import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArcadePackages, packageKey, validatePackageDescriptor } from "./arcade/packages.mjs";
import { buildPinnedPackage } from "./arcade/tar-build.mjs";
import { backupClassicConfiguration, classicBinding, prepareClassicLaunch } from "./arcade/classic.mjs";
import { ClassicLibrary } from "./arcade/classic-library.mjs";

// Storage/recipe fixtures only. None of these bytes is an executable or core.
function runtime(adapter, version = "1") {
  const entry = adapter === "gambatte-libretro" ? "core.dll" : "engine.exe";
  const pack = buildPinnedPackage({ id: adapter, version, kind: "runtime", license: "MIT original unit fixture",
    files: [{ path: entry, data: `Not an executable. ${adapter} ${version}` }] });
  pack.descriptor.classicRuntime = { adapter, entry, source: "https://example.org/original-unit-fixture", license: "MIT",
    ...(adapter === "gambatte-libretro" ? { api: 1 } : {}) };
  validatePackageDescriptor(pack.descriptor);
  return pack;
}
const bytes = Buffer.alloc(0x150, 0); // A bounded original fixture, not gameplay.
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-classic-unit-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test("four real adapter recipes bind pinned packages without executing mocked runtimes", async t => {
  const root = await temporary(t), profile = path.join(root, "profiles", "fixture"), install = path.join(root, "install");
  await mkdir(profile, { recursive: true }); await mkdir(install);
  const catalog = new Map(), pins = {};
  for (const id of ["dosbox-staging", "scummvm", "retroarch", "gambatte-libretro", "sameboy"]) {
    const p = runtime(id).descriptor; catalog.set(packageKey(p), p); pins[id] = packageKey(p);
  }
  for (const [adapter, entry] of [["dosbox-staging", "GAME.COM"], ["scummvm", "sky.dnr"], ["libretro", "game.gb"], ["sameboy", "game.gb"]]) {
    await writeFile(path.join(install, entry), bytes);
    const classic = { adapter, runtime: pins[adapter === "libretro" ? "retroarch" : adapter],
      ...(adapter === "libretro" ? { core: pins["gambatte-libretro"] } : {}), ...(adapter === "scummvm" ? { engine: "sky" } : {}) };
    const descriptor = { entry, files: [{ path: entry, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }], arguments: [], runtimes: [classic.runtime, classic.core].filter(Boolean), classic };
    const plan = await prepareClassicLaunch({ descriptor, catalog, filename: key => path.join(root, key), install, profile, root });
    assert.equal(plan.diagnostics.gameplayVerified, false);
    assert.equal(plan.diagnostics.adapter, adapter);
    if (adapter === "dosbox-staging") {
      assert.ok(plan.args.includes("config -securemode"));
      assert.ok(plan.args.some(s => s.startsWith("mount d ") && s.endsWith(" -ro")));
      assert.deepEqual(await readFile(path.join(profile, "saves", entry)), bytes);
      await writeFile(path.join(profile, "saves", "PROGRESS.SAV"), "existing progress");
      await writeFile(path.join(profile, "saves", entry), "game-written working-copy change");
      await prepareClassicLaunch({ descriptor, catalog, filename: key => path.join(root, key), install, profile, root });
      assert.equal(await readFile(path.join(profile, "saves", entry), "utf8"), "game-written working-copy change");
      assert.equal(await readFile(path.join(profile, "saves", "PROGRESS.SAV"), "utf8"), "existing progress");
    } else if (adapter === "scummvm") assert.ok(plan.args.includes("--gfx-mode=normal"));
    else if (adapter === "libretro") {
      assert.equal(plan.additionalReadRoots.length, 1);
      assert.ok(plan.args.includes("-L"));
      assert.match(await readFile(path.join(profile, "arena-retroarch.cfg"), "utf8"), /savestate_auto_load = "false"/);
      await writeFile(path.join(profile, "retroarch.cfg"), 'input_player1_a = "custom"\n');
      await prepareClassicLaunch({ descriptor, catalog, filename: key => path.join(root, key), install, profile, root });
      assert.match(await readFile(path.join(profile, "retroarch.cfg"), "utf8"), /custom/);
    } else {
      assert.equal(plan.args[1], path.join(profile, entry));
      await writeFile(path.join(profile, "game.sav"), "existing battery progress");
      await writeFile(path.join(profile, "game.gb"), "mutated ROM");
      await prepareClassicLaunch({ descriptor, catalog, filename: key => path.join(root, key), install, profile, root });
      assert.deepEqual(await readFile(path.join(profile, entry)), bytes);
      assert.equal(await readFile(path.join(profile, "game.sav"), "utf8"), "existing battery progress");
    }
  }
  await backupClassicConfiguration(profile, root);
  const configCopy = path.join(profile, `before-runtime-${createHash("sha256").update("retroarch.cfg").digest("hex").slice(0, 12)}-retroarch.cfg`);
  assert.match(await readFile(configCopy, "utf8"), /custom/);
  await writeFile(path.join(profile, "retroarch.cfg"), 'input_player1_a = "new-custom"\n');
  await backupClassicConfiguration(profile, root);
  assert.match(await readFile(configCopy, "utf8"), /new-custom/);
  assert.equal(await readFile(path.join(profile, "saves", "PROGRESS.SAV"), "utf8"), "existing progress");
});

test("classic binding and owner-side profile writes reject wrong cores, path injection and links", async t => {
  const root = await temporary(t), profile = path.join(root, "profiles", "fixture"), install = path.join(root, "install");
  await mkdir(profile, { recursive: true }); await mkdir(install);
  const rt = runtime("sameboy").descriptor, key = packageKey(rt), catalog = new Map([[key, rt]]);
  const descriptor = { entry: "game.gb", arguments: [], runtimes: [key], classic: { adapter: "sameboy", runtime: key } };
  await writeFile(path.join(install, "game.gb"), bytes);
  const outside = path.join(root, "outside"); await writeFile(outside, "private");
  await symlink(outside, path.join(profile, "bad"));
  await assert.rejects(prepareClassicLaunch({ descriptor, catalog, filename: () => install, install, profile, root }), /link/);
  assert.equal(await readFile(outside, "utf8"), "private");
  await rm(path.join(profile, "bad")); await link(outside, path.join(profile, "hardlink"));
  await assert.rejects(prepareClassicLaunch({ descriptor, catalog, filename: () => install, install, profile, root }), /link/);
  assert.throws(() => classicBinding({ ...descriptor, classic: { ...descriptor.classic, adapter: "libretro", core: key } }, catalog), /separately/);
  assert.throws(() => classicBinding({ ...descriptor, arguments: ["--arbitrary-command"] }, catalog), /generated/);
  assert.throws(() => classicBinding({ ...descriptor, classic: { ...descriptor.classic, engine: "sky & command" } }, catalog), /Engine/);
});

test("private classic imports and runtime updates preserve identities, pins and unrelated files", async t => {
  const root = await temporary(t), source = path.join(root, "source"); await mkdir(source);
  await writeFile(path.join(source, "Homebrew game.gb"), bytes);
  await writeFile(path.join(source, "unrelated-private.txt"), "Never import the ROM's parent folder");
  const rt = runtime("sameboy"), next = runtime("sameboy", "2");
  const packages = new ArcadePackages({ root: path.join(root, "managed"), catalog: [rt.descriptor, next.descriptor], reserveBytes: 0 });
  await packages.initialize();
  const library = new ClassicLibrary({ packages, host: { runningKeys: () => [] } }); await library.initialize();
  const choice = library.choices().find(c => c.runtime === packageKey(rt.descriptor));
  const game = await library.import({ choiceId: choice.id, source, entry: "Homebrew game.gb" });
  assert.deepEqual(game.files.map(f => f.path), ["Homebrew game.gb"]);
  assert.equal(await readFile(path.join(source, "unrelated-private.txt"), "utf8"), "Never import the ROM's parent folder");
  const copy = await library.import({ choiceId: choice.id, source, entry: "Homebrew game.gb" });
  assert.notEqual(copy.id, game.id, "identical ROM bytes must not silently merge private saves");
  const profile = path.join(packages.root, "profiles", createHash("sha256").update(game.id).digest("hex").slice(0, 32), "default");
  await mkdir(profile, { recursive: true }); await writeFile(path.join(profile, "game.sav"), "retained progress");
  const updated = await library.rebind(packageKey(game), library.choices().find(c => c.runtime === packageKey(next.descriptor)).id);
  const repeated = await library.rebind(packageKey(game), library.choices().find(c => c.runtime === packageKey(next.descriptor)).id);
  assert.equal(packageKey(repeated), packageKey(updated), "retrying the same pin update must not duplicate catalog versions");
  assert.equal(updated.id, game.id); assert.notEqual(updated.version, game.version);
  assert.equal(await readFile(path.join(profile, "game.sav"), "utf8"), "retained progress");
  assert.ok(packages.catalog.has(packageKey(game)));
  const recovered = new ArcadePackages({ root: packages.root, catalog: [], reserveBytes: 0 });
  const reopened = new ClassicLibrary({ packages: recovered, host: { runningKeys: () => [] } }); await reopened.initialize(); await recovered.initialize();
  assert.ok(recovered.catalog.has(packageKey(rt.descriptor)), "older pinned runtimes survive an app catalog update");
  assert.equal(reopened.catalog.length, 3);
});
