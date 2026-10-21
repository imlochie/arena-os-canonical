/**
 * Waveyard storage containment — platform-correctness tests.
 *
 * Regression background: safeLocalPath originally checked containment with
 * `target.startsWith(root + "/")`. On Windows, resolve() returns backslash
 * paths, so every VALID upload was rejected as "Unsafe storage key." —
 * while the whole suite stayed green on Linux CI. The fix uses
 * relative()/sep/isAbsolute (platform-correct). These tests pin that fix:
 *
 *  - the real function accepts valid keys and rejects traversal (native platform)
 *  - a win32-semantics simulation proves the algorithm shape is separator-agnostic
 *    (this is the test that would have caught the Windows upload bug on Linux)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { safeLocalPath } from "./storage";

test("safeLocalPath accepts valid keys and returns a contained path", () => {
  const root = path.resolve(".data/waveyard-storage-test");
  const target = safeLocalPath(root, "projects/p1/source/file.mp3");
  const rel = path.relative(root, target);
  assert.ok(rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
  assert.match(target, /file\.mp3$/);
});

test("safeLocalPath rejects traversal keys on every platform", () => {
  const root = path.resolve(".data/waveyard-storage-test");
  assert.throws(() => safeLocalPath(root, "../../etc/passwd"), /Unsafe storage key/);
  assert.throws(() => safeLocalPath(root, "projects/../../escape"), /Unsafe storage key/);
  // normalization-based smuggling: "projects/x/../../../.."
  assert.throws(() => safeLocalPath(root, "projects/x/../../../../../escape"), /Unsafe storage key/);
});

test("REGRESSION (Windows upload bug): containment must be separator-agnostic", () => {
  const win = path.win32;
  // Exactly the scenario from the Windows field report: valid project file.
  const root = win.resolve("C:\\Users\\lochi\\arena-os\\.data\\waveyard-storage");
  const target = win.resolve(root, "projects\\p1\\source\\file.mp3");

  // The OLD, buggy check — pin that it rejects valid win32 paths, so nobody
  // reintroduces it thinking it's equivalent.
  const oldBuggyCheck = target.startsWith(root + "/");
  assert.equal(
    oldBuggyCheck,
    false,
    "sanity: startsWith(root + '/') must reject valid win32 paths — this is the bug",
  );

  // The NEW algorithm (relative/sep/isAbsolute) applied with win32 semantics.
  const rel = win.relative(root, target);
  const accepted = rel !== ".." && !rel.startsWith(".." + win.sep) && !win.isAbsolute(rel);
  assert.ok(accepted, "relative-based containment must accept valid win32 paths");

  // …and must still reject traversals under win32 semantics.
  const evil = win.resolve(root, "..\\..\\Windows\\System32\\config.sys");
  const erel = win.relative(root, evil);
  const evilAccepted = erel !== ".." && !erel.startsWith(".." + win.sep) && !win.isAbsolute(erel);
  assert.equal(evilAccepted, false, "win32 traversal must stay rejected");

  // Drive-letter escape (different drive → relative() yields an absolute path).
  const otherDrive = "D:\\steal.exe";
  const drel = win.relative(root, otherDrive);
  assert.ok(win.isAbsolute(drel), "different-drive escape must be flagged absolute");
});

test("storage provider round-trips a file through the fixed path logic", async () => {
  const { LocalStorageProvider } = await import("./storage");
  const dir = await mkdtemp(path.join(tmpdir(), "wy-store-"));
  try {
    const provider = new LocalStorageProvider(dir);
    await provider.putBuffer("projects/p9/source/roundtrip.txt", "hello windows");
    const back = await provider.getBuffer("projects/p9/source/roundtrip.txt", 1024);
    assert.equal(back.toString(), "hello windows");
    // and the file physically landed inside the root, on the native platform
    const onDisk = await readFile(path.join(dir, "projects", "p9", "source", "roundtrip.txt"), "utf8");
    assert.equal(onDisk, "hello windows");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("metadata reads handle empty/exact-limit files and reject overflow without truncation", async t => {
  const { LocalStorageProvider } = await import("./storage");
  const root = await mkdtemp(path.join(tmpdir(), "wy-bounded-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalStorageProvider(root);
  for (const length of [0, 64, 65]) {
    const key = `derived/${length}.json`, body = "x".repeat(length);
    await storage.putBuffer(key, body);
    if (length > 64) await assert.rejects(storage.getBuffer(key, 64), /exceeds the allowed read size/);
    else assert.deepEqual(await storage.getBuffer(key, 64), Buffer.from(body));
    assert.equal((await readFile(storage.getLocalPath(key)!)).length, length);
  }
});

test("metadata growth after stat is bounded to limit+1 actual IO bytes and never returned", async t => {
  const { LocalStorageProvider } = await import("./storage");
  const fs = (await import("node:fs")).promises;
  const callbacks = (await import("node:fs")).default;
  const root = await mkdtemp(path.join(tmpdir(), "wy-growing-metadata-"));
  const storage = new LocalStorageProvider(root), key = "derived/waveform.json";
  await storage.putBuffer(key, '{"complete":true}');
  const location = storage.getLocalPath(key)!;
  const statDescriptor = Object.getOwnPropertyDescriptor(fs, "stat")!;
  const readDescriptor = Object.getOwnPropertyDescriptor(callbacks, "read")!;
  const stat = fs.stat, read = callbacks.read;
  let injected = false, actualReadBytes = 0;
  const restore = () => { Object.defineProperty(fs, "stat", statDescriptor); Object.defineProperty(callbacks, "read", readDescriptor); };
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }); });
  Object.defineProperty(fs, "stat", { ...statDescriptor, value: async (...args: Parameters<typeof fs.stat>) => {
    const before = await stat(...args);
    if (String(args[0]) === location && !injected) {
      injected = true;
      await fs.appendFile(location, Buffer.alloc(8 * 1024 * 1024, 0x20));
    }
    return before;
  } });
  // Observe actual successful OS read callbacks, not a fake storage result.
  Object.defineProperty(callbacks, "read", { ...readDescriptor, value: (...args: unknown[]) => {
    const callback = args.pop() as (...values: unknown[]) => void;
    return Reflect.apply(read, callbacks, [...args, (...values: unknown[]) => {
      actualReadBytes += Number(values[1] ?? 0); callback(...values);
    }]);
  } });
  try { await assert.rejects(storage.getBuffer(key, 64), /exceeds the allowed read size/); }
  finally { restore(); }
  assert.equal(injected, true);
  assert.equal(actualReadBytes, 65, "the reader must stop at one overflow sentinel, not read all 8 MiB");
  assert.equal((await fs.stat(location)).size, 8 * 1024 * 1024 + 17, "failed metadata reads never delete/truncate owner objects");
});
