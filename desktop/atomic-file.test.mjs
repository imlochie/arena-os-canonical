import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSyncedAtomic } from "./atomic-file.mjs";

async function temporary(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "arena-atomic-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const failure = code => Object.assign(new Error(code), { code });

test("private atomic writes preserve exact bytes and leave no staging files", () => temporary(async root => {
  const target = path.join(root, "catalog.json");
  await writeSyncedAtomic(target, Buffer.from([0, 255, 17]));
  assert.deepEqual(await readFile(target), Buffer.from([0, 255, 17]));
  if (process.platform !== "win32") assert.equal((await stat(target)).mode & 0o777, 0o600);
  await writeSyncedAtomic(target, "next");
  assert.equal(await readFile(target, "utf8"), "next");
  assert.deepEqual(await readdir(root), ["catalog.json"]);
}));

test("Windows sharing locks retry within bounds without deleting old contents", () => temporary(async root => {
  const target = path.join(root, "catalog.json");
  await writeFile(target, "previous");
  const waits = [];
  let calls = 0;
  await writeSyncedAtomic(target, "next", {
    platform: "win32", wait: async delay => { waits.push(delay); },
    renameFile: async (from, to) => {
      assert.equal(await readFile(to, "utf8"), "previous");
      if (++calls <= 2) throw failure("EPERM");
      await rename(from, to);
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 30]);
  assert.equal(await readFile(target, "utf8"), "next");
  assert.deepEqual(await readdir(root), ["catalog.json"]);
}));

test("exhausted locks and non-retryable commit failures preserve previous data", () => temporary(async root => {
  const target = path.join(root, "catalog.json");
  await writeFile(target, "previous");
  for (const code of ["EBUSY", "ENOSPC", "EIO"]) {
    let calls = 0;
    await assert.rejects(writeSyncedAtomic(target, "next", {
      platform: "win32", wait: async () => {},
      renameFile: async () => { calls++; throw failure(code); },
    }), { code });
    assert.equal(calls, code === "EBUSY" ? 4 : 1);
    assert.equal(await readFile(target, "utf8"), "previous");
    assert.deepEqual(await readdir(root), ["catalog.json"]);
  }
}));

test("POSIX permission failures are not treated as Windows sharing locks", () => temporary(async root => {
  const target = path.join(root, "catalog.json");
  let waited = false;
  await assert.rejects(writeSyncedAtomic(target, "next", {
    platform: "linux", wait: async () => { waited = true; },
    renameFile: async () => { throw failure("EACCES"); },
  }), { code: "EACCES" });
  assert.equal(waited, false);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(writeSyncedAtomic("relative.json", "no"), /absolute/);
}));
