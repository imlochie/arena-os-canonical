import test from "node:test";
import assert from "node:assert/strict";
import { applyIps, applyBps, crc32, modHash, parseModPackage, composeMods, versionMatches, type ModManifest, type ModBase, type ModProfile } from "./mod-workshop";
import { ModWorkshopEngine, type WorkshopState, type WorkshopStore } from "./mod-workshop-engine";
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const source = bytes("<html><body>ORIGINAL GAME</body></html>");
async function fixture() {
  const sha = await modHash(source);
  const base = { id: "original:fixture", version: `sha256:${sha}`, kind: "html", files: { "game.html": source }, gameKey: "fixture", title: "Original authorized fixture" };
  const profile: ModProfile = { id: "profile-a", name: "A", enabled: [], order: [], settings: {}, shareSaves: false };
  return { base, profile };
}
async function packageJson(base: ModBase, id = "colour", content = "<html><body>BLUE GAME</body></html>", mutate?: (manifest: ModManifest) => void) {
  const payload = bytes(content);
  const manifest: ModManifest = { schema: "arena.arcade.mod", schemaVersion: 1, id, name: id, version: "1.0.0",
    license: { spdx: "MIT", text: "Original fixture. Permission to use, copy, modify and redistribute is granted.", redistributable: true },
    source: { kind: "local" }, base: { id: base.id, version: base.version, files: { "game.html": await modHash(source) } },
    adapter: "files", permissions: ["scripts"], requires: [], conflicts: [], after: [], settings: {},
    operations: [{ kind: "replace", target: "game.html", payload: "replacement.html", baseSha256: await modHash(source), resultSha256: await modHash(payload) }],
    payloads: { "replacement.html": await modHash(payload) } };
  mutate?.(manifest);
  return JSON.stringify({ manifest, files: { "replacement.html": btoa(text(payload)) } });
}
function variable(value: number) {
  const result: number[] = []; while (true) { const byte = value & 127; value = Math.floor(value / 128); if (!value) { result.push(byte | 128); break; } result.push(byte); value--; } return result;
}
function bps(source: Uint8Array, target: Uint8Array) {
  const header = [...bytes("BPS1"), ...variable(source.length), ...variable(target.length), ...variable(0), ...variable(((target.length - 1) * 4) + 1), ...target];
  const u32 = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24];
  header.push(...u32(crc32(source)), ...u32(crc32(target))); header.push(...u32(crc32(Uint8Array.from(header)))); return Uint8Array.from(header);
}
test("real IPS records, RLE, truncation, extension and malformed patches", () => {
  const patch = Uint8Array.from([...bytes("PATCH"), 0, 0, 1, 0, 2, 88, 89, 0, 0, 4, 0, 0, 0, 2, 90, ...bytes("EOF")]);
  assert.deepEqual([...applyIps(bytes("abcde"), patch)], [97, 88, 89, 100, 90, 90]);
  assert.equal(applyIps(bytes("abc"), Uint8Array.from([...bytes("PATCHEOF"), 0, 0, 8])).length, 8);
  assert.throws(() => applyIps(bytes("a"), bytes("PATCH")), /EOF/);
  assert.throws(() => applyIps(bytes("a"), bytes("PATCHEOFextra")), /trailing/);
});
test("real BPS target read, source/patch checksums and bounds", () => {
  const a = bytes("original"), b = bytes("MODIFIED");
  assert.equal(text(applyBps(a, bps(a, b))), "MODIFIED");
  assert.throws(() => applyBps(bytes("wrong"), bps(a, b)), /checksum/);
  const broken = bps(a, b); broken[10] ^= 1; assert.throws(() => applyBps(a, broken), /checksum/);
});
test("BPS source reads and overlapping target copies follow the actual command format", () => {
  const source = bytes("abc"), target = bytes("abcabcabc");
  const raw = [...bytes("BPS1"), ...variable(3), ...variable(9), ...variable(0), ...variable((3 - 1) * 4), ...variable((6 - 1) * 4 + 3), ...variable(0)];
  const checksum = (value: number) => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24];
  raw.push(...checksum(crc32(source)), ...checksum(crc32(target))); raw.push(...checksum(crc32(Uint8Array.from(raw))));
  assert.equal(text(applyBps(source, Uint8Array.from(raw))), "abcabcabc");
});
test("typed JSON configuration and asset/script replacements compose without changing base configuration", async () => {
  const config = bytes('{"speed":1}'), script = bytes("print('original')"), asset = bytes("blue");
  const base = { id: "original-config", version: `sha256:${await modHash("config-fixture")}`, kind: "native", files: { "config.json": config, "game.lua": script, "asset.txt": asset } };
  const template = bytes('{"speed":"{{settings.speed}}"}'), replacement = bytes("print('modded')"), green = bytes("green");
  const payloads = { "template.json": template, "script.lua": replacement, "asset.txt": green };
  const hashes = Object.fromEntries(await Promise.all(Object.entries(base.files).map(async ([name, value]) => [name, await modHash(value)])));
  const manifest = {
    schema: "arena.arcade.mod", schemaVersion: 1, id: "configuration", version: "1.0.0", name: "Original settings fixture",
    license: { spdx: "MIT", text: "Original authorized test fixture", redistributable: true }, source: { kind: "local" },
    base: { id: base.id, version: base.version, files: hashes }, adapter: "files", permissions: ["configuration", "scripts", "assets"], requires: [], conflicts: [], after: [],
    settings: { speed: { type: "number", default: 1, min: 1, max: 5 } },
    operations: [
      { kind: "config-json", target: "config.json", payload: "template.json", baseSha256: hashes["config.json"] },
      { kind: "replace", target: "game.lua", payload: "script.lua", baseSha256: hashes["game.lua"], resultSha256: await modHash(replacement) },
      { kind: "replace", target: "asset.txt", payload: "asset.txt", baseSha256: hashes["asset.txt"], resultSha256: await modHash(green) },
    ], payloads: Object.fromEntries(await Promise.all(Object.entries(payloads).map(async ([name, value]) => [name, await modHash(value)]))),
  };
  const pkg = await parseModPackage(JSON.stringify({ manifest, files: Object.fromEntries(Object.entries(payloads).map(([name, value]) => [name, btoa(text(value))])) }));
  const profile = { id: "a", name: "Configured", enabled: ["configuration@1.0.0"], order: [], settings: { "configuration@1.0.0": { speed: 3 } }, shareSaves: false };
  const result = await composeMods(base, [pkg], profile);
  assert.deepEqual(JSON.parse(text(result.files["config.json"])), { speed: 3 });
  assert.equal(text(result.files["game.lua"]), "print('modded')"); assert.equal(text(result.files["asset.txt"]), "green"); assert.equal(text(config), '{"speed":1}');
  profile.settings["configuration@1.0.0"].speed = 10; await assert.rejects(composeMods(base, [pkg], profile), /Invalid setting/);
});
test("package integrity, native hooks, unsafe paths and undeclared code permissions fail closed", async () => {
  const { base } = await fixture(), json = await packageJson(base), pkg = await parseModPackage(json);
  assert.match(pkg.digest, /^[a-f0-9]{64}$/);
  assert.equal((await parseModPackage(JSON.stringify(JSON.parse(json), null, 2))).digest, pkg.digest);
  await assert.rejects(parseModPackage(json.replace(btoa("<html><body>BLUE GAME</body></html>"), btoa("corrupt"))), /Corrupt/);
  await assert.rejects(packageJson(base, "bad", "x", m => { m.operations[0].target = "../escape"; }).then(parseModPackage), /Unsafe/);
  await assert.rejects(packageJson(base, "bad", "x", m => { m.permissions = []; }).then(parseModPackage), /scripts permission/);
  const hook = JSON.parse(json); hook.manifest.install = "powershell"; await assert.rejects(parseModPackage(JSON.stringify(hook)), /hook/);
});
test("overlays change actual content, verify base/result hashes and leave original bytes untouched", async () => {
  const { base, profile } = await fixture(), pkg = await parseModPackage(await packageJson(base));
  profile.enabled = ["colour@1.0.0"];
  const output = await composeMods(base, [pkg], profile);
  assert.match(text(output.files["game.html"]), /BLUE GAME/);
  assert.match(text(base.files["game.html"]), /ORIGINAL GAME/);
  pkg.manifest.operations[0].resultSha256 = "0".repeat(64);
  await assert.rejects(composeMods(base, [pkg], profile), /result checksum/);
});
test("dependency order is deterministic; versions, conflicts, cycles and overlapping targets are checked", async () => {
  const { base, profile } = await fixture();
  const a = await parseModPackage(await packageJson(base, "a"));
  const b = await parseModPackage(await packageJson(base, "b", "new", m => { m.requires = [{ id: "a", range: "^1.0.0" }]; }));
  profile.enabled = ["b@1.0.0"];
  await assert.rejects(composeMods(base, [a, b], profile), /File conflict/);
  b.manifest.operations[0].afterMod = "a"; b.manifest.operations[0].baseSha256 = await modHash(a.files["replacement.html"]);
  const result = await composeMods(base, [b, a], profile);
  assert.deepEqual(result.order, ["a@1.0.0", "b@1.0.0"]); assert.deepEqual(result.addedDependencies, ["a@1.0.0"]);
  a.manifest.requires = [{ id: "b", range: "1.0.0" }]; await assert.rejects(composeMods(base, [a, b], profile), /cycle/);
  assert.equal(versionMatches("1.2.3", "^1.0.0"), true); assert.equal(versionMatches("2.0.0", "^1.0.0"), false); assert.equal(versionMatches("0.1.1", "^0.0.1"), false);
});
async function memoryStore() {
  const { base } = await fixture(); let state: WorkshopState | null = null, interrupt = false;
  const packages = new Map<string, string>();
  const store: WorkshopStore = {
    base: async () => structuredClone(base), read: async () => structuredClone(state),
    package: async digest => { const json = packages.get(digest); if (!json) throw new Error("missing package"); return json; },
    commit: async (_key, revision, guard, next, additions) => {
      if (interrupt) throw new Error("simulated interruption");
      if ((state?.revision ?? 0) !== revision || base.version !== guard.version) throw new Error("stale write");
      for (const [key, json] of Object.entries(additions)) packages.set(key, json); state = structuredClone(next);
    },
  };
  return { base, store, engine: new ModWorkshopEngine(store), interrupt: (value: boolean) => { interrupt = value; } };
}
test("profiles, reviewed commits, failed writes, single-mod removal, exact rollback and restore across engines", async () => {
  const { engine, base, store, interrupt } = await memoryStore();
  let snapshot = await engine.create("fixture", "Blue", false, 0), a = snapshot.profiles[0].id;
  snapshot = await engine.create("fixture", "Original", false, 1); const b = snapshot.profiles[1].id;
  let preview = await engine.review("fixture", a, { packageJson: await packageJson(base) }, 2);
  interrupt(true); await assert.rejects(engine.commit(preview.id), /interruption/); interrupt(false);
  assert.equal((await engine.inspect("fixture")).revision, 2);
  snapshot = await engine.commit(preview.id);
  assert.equal(text((await engine.play("fixture", a)).result.files["game.html"]).includes("BLUE"), true);
  assert.equal(text((await engine.play("fixture", b)).result.files["game.html"]).includes("ORIGINAL"), true);
  const backup = await engine.export("fixture", a); assert.equal(JSON.parse(backup.json).base.files, undefined);
  preview = await engine.review("fixture", a, { remove: "colour@1.0.0" }, snapshot.revision);
  assert.equal(preview.changes.length, 1); assert.equal(preview.changes[0].after, await modHash(source));
  snapshot = await engine.commit(preview.id);
  assert.match(text((await engine.play("fixture", a)).result.files["game.html"]), /ORIGINAL/);
  snapshot = await engine.rollback("fixture", a, snapshot.revision);
  assert.match(text((await engine.play("fixture", a)).result.files["game.html"]), /BLUE/);
  const reopened = new ModWorkshopEngine(store);
  assert.deepEqual((await reopened.inspect("fixture")).profiles, snapshot.profiles);
  preview = await reopened.review("fixture", b, { restoreJson: backup.json }, snapshot.revision); snapshot = await reopened.commit(preview.id);
  assert.match(text((await reopened.play("fixture", b)).result.files["game.html"]), /BLUE/);
  assert.equal(snapshot.profiles[1].shareSaves, false);
});
test("stale reviews and changed bases never overwrite newer work", async () => {
  const { engine, base } = await memoryStore();
  const snapshot = await engine.create("fixture", "A", false, 0), a = snapshot.profiles[0].id;
  const first = await engine.review("fixture", a, { packageJson: await packageJson(base) }, 1);
  const second = await engine.review("fixture", a, {}, 1);
  await engine.commit(first.id); await assert.rejects(engine.commit(second.id), /another window/);
  base.version = `sha256:${"0".repeat(64)}`; await assert.rejects(engine.inspect("fixture"), /base game changed/);
});
test("disable remains visible and reorderable after reopening, then re-enables without reimport", async () => {
  const { engine, base, store } = await memoryStore();
  let snapshot = await engine.create("fixture", "A", false, 0); const id = snapshot.profiles[0].id;
  let preview = await engine.review("fixture", id, { packageJson: await packageJson(base) }, snapshot.revision);
  snapshot = await engine.commit(preview.id);
  preview = await engine.review("fixture", id, { enabled: [], order: ["colour@1.0.0"] }, snapshot.revision);
  snapshot = await engine.commit(preview.id);
  assert.deepEqual(snapshot.profiles[0].enabled, []);
  assert.deepEqual(snapshot.profiles[0].order, ["colour@1.0.0"]);
  assert.match(text((await engine.play("fixture", id)).result.files["game.html"]), /ORIGINAL/);
  const reopened = new ModWorkshopEngine(store); snapshot = await reopened.inspect("fixture");
  assert.deepEqual(snapshot.profiles[0].order, ["colour@1.0.0"]);
  assert.equal(snapshot.packages.length, 1);
  // Portable backups preserve disabled selections as well.
  const backup = JSON.parse((await reopened.export("fixture", id)).json); assert.equal(backup.packages.length, 1);
  preview = await reopened.review("fixture", id, { enabled: ["colour@1.0.0"], order: snapshot.profiles[0].order }, snapshot.revision);
  snapshot = await reopened.commit(preview.id);
  assert.match(text((await reopened.play("fixture", id)).result.files["game.html"]), /BLUE/);
});
test("portable restore rejects isolated-to-shared and shared-to-isolated save scope mismatches without mutation", async () => {
  const { engine } = await memoryStore();
  let snapshot = await engine.create("fixture", "Isolated", false, 0); const isolated = snapshot.profiles[0].id;
  snapshot = await engine.create("fixture", "Shared", true, snapshot.revision); const shared = snapshot.profiles[1].id;
  const isolatedBackup = await engine.export("fixture", isolated), sharedBackup = await engine.export("fixture", shared);
  await assert.rejects(engine.review("fixture", shared, { restoreJson: isolatedBackup.json }, snapshot.revision), /different save-sharing settings/);
  await assert.rejects(engine.review("fixture", isolated, { restoreJson: sharedBackup.json }, snapshot.revision), /different save-sharing settings/);
  assert.deepEqual(await engine.inspect("fixture"), snapshot);
});
test("restricted payloads are excluded and cannot be silently restored; unsupported adapters stay blocked", async () => {
  const { engine, base } = await memoryStore(), s = await engine.create("fixture", "A", false, 0), a = s.profiles[0].id;
  const review = await engine.review("fixture", a, { packageJson: await packageJson(base, "private", undefined, m => { m.license.redistributable = false; }) }, 1);
  await engine.commit(review.id);
  const backup = await engine.export("fixture", a); assert.deepEqual(backup.excluded, ["private@1.0.0"]); assert.deepEqual(JSON.parse(backup.json).packages, []);
  const other = await memoryStore(), target = await other.engine.create("fixture", "Restored", false, 0);
  await assert.rejects(other.engine.review("fixture", target.profiles[0].id, { restoreJson: backup.json }, 1), /Restricted/);
  const unavailable = await packageJson(base, "ups", "new", m => { m.adapter = "ups"; });
  await assert.rejects(engine.review("fixture", a, { packageJson: unavailable }, 2), /adapter is not installed/);
});
