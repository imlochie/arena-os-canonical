import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { BepInExProfiles } from "./arcade/bepinex-profiles.mjs";

const archive = fileURLToPath(new URL("../generated-artifacts/bepinex-research/linux.zip", import.meta.url));
let present = true; try { await access(archive); } catch { present = false; }
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
test("real loader cores prepare, repair and roll back independently without touching saves/configuration", { skip: !present }, async () => {
  // Actual pinned loader bytes; profile filesystem fixture only. No Unity
  // executable, runtime/plugin loading, LPAC or gameplay is represented here.
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-loader-profiles-"));
  const a = randomUUID(), b = randomUUID();
  const contexts = new Map([a, b].map(id => [id, {
    storage: path.join(root, "protected", id), runtime: path.join(root, "profiles", id),
    host: "linux-x64", baseVersion: "sha256:" + "a".repeat(64), candidate: true, shareSaves: false, running: false,
  }]));
  const manager = new BepInExProfiles(async (_key, id) => contexts.get(id));
  try {
    assert.equal((await manager.inspect("fixture", a)).status, "not-prepared");
    await manager.change("fixture", a, { archive });
    await manager.change("fixture", b, { archive });
    const ca = contexts.get(a), cb = contexts.get(b);
    for (const [context, label] of [[ca, "A"], [cb, "B"]]) {
      await mkdir(path.join(context.runtime, "BepInEx", "config"), { recursive: true });
      await writeFile(path.join(context.runtime, "BepInEx", "config", "fixture.cfg"), label);
      await writeFile(path.join(context.runtime, "save.dat"), `save-${label}`);
      await writeFile(path.join(context.runtime, "BepInEx", "LogOutput.log"), `log-${label}`);
    }
    const target = path.join(ca.runtime, "BepInEx", "core", "BepInEx.dll");
    const original = digest(await readFile(target));
    await chmod(target, 0o600); await writeFile(target, "tampered");
    assert.equal((await manager.inspect("fixture", a)).status, "repair-needed");
    await manager.change("fixture", a, { repair: true });
    assert.equal(digest(await readFile(target)), original);
    assert.equal((await manager.inspect("fixture", b)).status, "prepared-unverified");
    const previous = JSON.parse(await readFile(path.join(ca.storage, "index.json"), "utf8")).generation;
    await manager.change("fixture", a, { archive });
    assert.equal((await manager.inspect("fixture", a)).rollbackAvailable, true);
    await manager.change("fixture", a, { rollback: true });
    assert.equal(JSON.parse(await readFile(path.join(ca.storage, "index.json"), "utf8")).generation, previous);
    for (const [context, label] of [[ca, "A"], [cb, "B"]]) {
      assert.equal(await readFile(path.join(context.runtime, "save.dat"), "utf8"), `save-${label}`);
      assert.equal(await readFile(path.join(context.runtime, "BepInEx", "config", "fixture.cfg"), "utf8"), label);
      const report = await manager.inspect("fixture", label === "A" ? a : b);
      assert.equal(report.log, `log-${label}`); assert.equal(report.canLaunch, false); assert.equal(report.gameplayVerified, false);
    }
    ca.running = true;
    await assert.rejects(manager.change("fixture", a, { repair: true }), /Stop the native game/);
    ca.running = false; ca.shareSaves = true;
    await assert.rejects(manager.change("fixture", a, { archive }), /own saves/);
    ca.shareSaves = false; ca.checkSpace = async () => { throw new Error("disk reserve"); };
    await assert.rejects(manager.change("fixture", a, { repair: true }), /disk reserve/);
    delete ca.checkSpace;
    await writeFile(path.join(ca.storage, "prepare.lock"), "held");
    await assert.rejects(manager.change("fixture", a, { repair: true }), /already active/);
    await rm(path.join(ca.storage, "prepare.lock"));
    assert.ok(!(await readdir(path.join(ca.runtime, "BepInEx"))).some(name => name.startsWith(".core-")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed preparation and planted links preserve the existing profile", { skip: !present || process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-loader-links-")), id = randomUUID();
  const context = { storage: path.join(root, "protected"), runtime: path.join(root, "runtime"),
    host: "linux-x64", baseVersion: "sha256:" + "b".repeat(64), candidate: true, shareSaves: false, running: false };
  const manager = new BepInExProfiles(async () => context);
  try {
    await manager.change("fixture", id, { archive });
    const before = await readFile(path.join(context.storage, "index.json"), "utf8");
    const outside = path.join(root, "outside"); await writeFile(outside, "private");
    const coreFile = path.join(context.runtime, "BepInEx", "core", "BepInEx.dll");
    await rm(coreFile); await symlink(outside, coreFile);
    await assert.rejects(manager.change("fixture", id, { repair: true }), /linked/);
    assert.equal(await readFile(outside, "utf8"), "private");
    assert.equal(await readFile(path.join(context.storage, "index.json"), "utf8"), before);
    await symlink(outside, path.join(context.runtime, "BepInEx", "LogOutput.log"));
    assert.match((await manager.inspect("fixture", id)).diagnostic, /ordinary/);
    assert.equal((await manager.inspect("fixture", id)).log, "");
    assert.ok(!(await readdir(context.storage)).includes("prepare.lock"));
    const invalid = path.join(root, "bad.zip"); await writeFile(invalid, "invalid");
    await assert.rejects(manager.change("fixture", id, { archive: invalid }), /file\/size/);
    assert.equal(await readFile(path.join(context.storage, "index.json"), "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
