import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArcadePackages, extractPinnedTar, packageKey, safePackagePath, validatePackageDescriptor, validateReleaseUrl } from "./arcade/packages.mjs";
import { buildPinnedPackage } from "./arcade/tar-build.mjs";
const fixture = (id = "fixture", extra = {}) => buildPinnedPackage({ id, version: "1.0.0", kind: "game", entry: "bin/fixture.exe", files: [{ path: "bin/fixture.exe", data: "Original fixture bytes; storage tests do not execute this." }], license: "MIT; original storage fixture", ...extra });
async function temporary(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-native-packages-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test("native descriptors and Windows paths refuse ambiguous names, traversal, shell strings and unapproved hosts", () => {
  for (const value of ["../escape", "/absolute", "C:/windows", "a\\b", "a//b", "NUL.txt", "bin/file.exe.", "foo:bar", "CON", "."]) assert.throws(() => safePackagePath(value));
  for (const value of ["http://github.com/a", "https://github.com.evil/a", "https://user@github.com/a", "file:///tmp/a", "https://127.0.0.1/a"]) assert.throws(() => validateReleaseUrl(value));
  const { descriptor } = fixture();
  assert.throws(() => validatePackageDescriptor({ ...descriptor, arguments: "run shell" }));
  assert.throws(() => validatePackageDescriptor({ ...descriptor, files: [...descriptor.files, ...descriptor.files], unpackedBytes: descriptor.unpackedBytes * 2 }));
});
test("pinned package activation verifies archive and file bytes; uninstall retains saves and shared runtime references", () => temporary(async root => {
  const runtime = fixture("runtime", { kind: "runtime", entry: undefined });
  const game = fixture("game", { runtimes: [packageKey(runtime.descriptor)] });
  const manager = new ArcadePackages({ root, catalog: [runtime.descriptor, game.descriptor], reserveBytes: 0 });
  await manager.initialize();
  for (const item of [runtime, game]) {
    const source = path.join(root, `${item.descriptor.id}.tar`); await writeFile(source, item.archive);
    await manager.install(packageKey(item.descriptor), source);
    await manager.verify(packageKey(item.descriptor));
  }
  const save = path.join(root, "profiles", "saved-progress"); await writeFile(save, "keep");
  await assert.rejects(manager.remove(packageKey(runtime.descriptor)), /references/);
  await assert.rejects(manager.remove(packageKey(game.descriptor), [packageKey(game.descriptor)]), /Stop/);
  await manager.remove(packageKey(game.descriptor)); await manager.remove(packageKey(runtime.descriptor));
  assert.equal(await readFile(save, "utf8"), "keep");
}));
test("quota preflight, corrupt archives, interrupted promotion and cancellation never activate a partial game", () => temporary(async root => {
  const { archive, descriptor } = fixture(); const key = packageKey(descriptor);
  const source = path.join(root, "fixture.tar"); await writeFile(source, archive);
  const tiny = new ArcadePackages({ root, catalog: [descriptor], reserveBytes: 0, budgetBytes: 1 });
  await tiny.initialize(); await assert.rejects(tiny.install(key, source), /disk budget/);
  const manager = new ArcadePackages({ root, catalog: [descriptor], reserveBytes: 0, beforePromote: () => { throw new Error("Injected interrupted promotion"); } });
  await manager.initialize(); await assert.rejects(manager.install(key, source), /interrupted promotion/);
  await assert.rejects(readFile(path.join(manager.filename(key), "bin/fixture.exe")), /ENOENT/);
  const reopened = new ArcadePackages({ root, catalog: [descriptor], reserveBytes: 0 });
  await reopened.initialize(); await reopened.install(key, source); await reopened.verify(key);
  assert.equal(reopened.snapshot().packages[key].phase, "ready");
  await reopened.remove(key);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reopened.install(key, source, { signal: controller.signal }), /abort/i);
  await rm(path.join(root, "downloads", `${descriptor.sha256}.tar`));
  const corrupt = Buffer.from(archive); corrupt[600] ^= 1; await writeFile(source, corrupt);
  await assert.rejects(reopened.install(key, source), /integrity/);
  await assert.rejects(readFile(path.join(reopened.filename(key), "bin/fixture.exe")), /ENOENT/);
}));
test("streaming extraction rejects symlink/device entries, altered file pins and duplicate tar names", () => temporary(async root => {
  const { archive, descriptor } = fixture();
  const source = path.join(root, "package.tar");
  const output = path.join(root, "output"); await mkdir(output);
  const malicious = Buffer.from(archive); malicious[156] = 50; malicious.fill(32, 148, 156);
  const sum = [...malicious.subarray(0, 512)].reduce((a, b) => a + b, 0);
  malicious.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  await writeFile(source, malicious);
  await assert.rejects(extractPinnedTar(source, output, descriptor), /Unsupported/);
  await writeFile(source, archive);
  await assert.rejects(extractPinnedTar(source, output, { ...descriptor, files: [{ ...descriptor.files[0], sha256: "0".repeat(64) }] }), /Integrity/);
}));
test("a journal interruption recovers temporary files only, retaining installed bytes, cache and profiles", () => temporary(async root => {
  const { archive, descriptor } = fixture(); const key = packageKey(descriptor);
  const source = path.join(root, "source.tar"); await writeFile(source, archive);
  const manager = new ArcadePackages({ root, catalog: [descriptor], reserveBytes: 0 });
  await manager.initialize(); await manager.install(key, source);
  const staging = path.join(root, "staging", "00000000-0000-0000-0000-000000000000"); await mkdir(staging);
  await writeFile(path.join(staging, "partial"), "interrupted");
  await writeFile(path.join(root, "profiles", "save"), "retained");
  const journal = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
  journal.packages[key].phase = "installing"; await writeFile(path.join(root, "state.json"), JSON.stringify(journal));
  const reopened = new ArcadePackages({ root, catalog: [descriptor], reserveBytes: 0 });
  await reopened.initialize(); assert.equal(reopened.snapshot().packages[key].phase, "interrupted");
  await reopened.install(key, undefined); await reopened.verify(key);
  assert.equal(await readFile(path.join(root, "profiles", "save"), "utf8"), "retained");
  await assert.rejects(readFile(path.join(staging, "partial")), /ENOENT/);
}));
test("retired catalog entries retain bytes and can be restored without allocating a second installation", () => temporary(async root => {
  const { archive, descriptor } = fixture(); const key = packageKey(descriptor);
  const source = path.join(root, "archive.tar"); await writeFile(source, archive);
  const initial = new ArcadePackages({ root, catalog: [descriptor], reserveBytes: 0 }); await initial.initialize(); await initial.install(key, source);
  const retired = new ArcadePackages({ root, catalog: [] }); await retired.initialize();
  assert.equal(retired.snapshot().packages[key].phase, "unavailable");
  const restored = new ArcadePackages({ root, catalog: [descriptor], reserveBytes: 0, budgetBytes: 1 }); await restored.initialize();
  assert.equal(restored.snapshot().packages[key].phase, "interrupted");
  await restored.install(key, undefined); await restored.verify(key);
  assert.equal(restored.snapshot().packages[key].phase, "ready");
}));
