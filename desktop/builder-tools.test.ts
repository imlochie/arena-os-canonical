/**
 * builder-tools tests — the offline NSIS-seeding contract:
 * cache-root resolution matches app-builder-lib, checksums are enforced
 * before anything is placed, unknown archives are rejected, and the
 * checksum table is provably in sync with the INSTALLED app-builder-lib
 * (so a lib upgrade can't silently invalidate seeded archives).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  KNOWN_TOOLS,
  ToolSeedError,
  assertTableMatchesInstalledLib,
  builderCacheRoot,
  seedArchive,
  sha256File,
  toolStatus,
} from "../scripts/lib/builder-tools.mjs";

const repoRoot = path.resolve(path.dirname(process.argv[1] ?? "."), "..");

test("builderCacheRoot mirrors app-builder-lib on win32 / POSIX / override", () => {
  const win = builderCacheRoot({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" } });
  assert.equal(win, path.win32.join("C:\\Users\\u\\AppData\\Local", "electron-builder", "Cache"));

  assert.equal(
    builderCacheRoot({ platform: "win32", env: { ELECTRON_BUILDER_CACHE: "D:\\eb-cache", LOCALAPPDATA: "C:\\x" } }),
    "D:\\eb-cache",
    "ELECTRON_BUILDER_CACHE (absolute) wins",
  );

  assert.equal(
    builderCacheRoot({ platform: "linux", env: { XDG_CACHE_HOME: "/tmp/xdg" } }),
    path.join("/tmp/xdg", "electron-builder"),
  );
  assert.equal(
    builderCacheRoot({ platform: "linux", env: { HOME: "/home/dev" } }),
    path.join("/home/dev", ".cache", "electron-builder"),
  );
});

test("seedArchive places a checksum-verified archive at the exact archive-cache path", async () => {
  const cacheRoot = mkdtempSync(path.join(tmpdir(), "arena-seed-"));
  try {
    const file = path.join(cacheRoot, "nsis-test.7z");
    writeFileSync(file, Buffer.from("fake nsis payload"));
    const table = { "nsis-test.7z": { releaseName: "nsis-test", sha256: await sha256File(file), purpose: "test" } };
    const result = await seedArchive(file, { cacheRoot: path.join(cacheRoot, "cache"), table });
    assert.equal(result.releaseName, "nsis-test");
    const expected = path.join(cacheRoot, "cache", "nsis-test", "nsis-test.7z");
    assert.equal(result.archiveCachePath, expected);
    assert.ok(existsSync(expected), "archive placed at <cacheRoot>/<releaseName>/<filename>");
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("seedArchive rejects a truncated/altered archive (checksum mismatch)", async () => {
  const cacheRoot = mkdtempSync(path.join(tmpdir(), "arena-seed-"));
  try {
    const file = path.join(cacheRoot, "nsis-test.7z");
    writeFileSync(file, Buffer.from("partial download"));
    const table = { "nsis-test.7z": { releaseName: "nsis-test", sha256: "0".repeat(64), purpose: "test" } };
    await assert.rejects(
      () => seedArchive(file, { cacheRoot, table }),
      (error: unknown) => error instanceof ToolSeedError && /checksum mismatch/.test(error.message),
    );
    assert.equal(existsSync(path.join(cacheRoot, "nsis-test")), false, "nothing placed on mismatch");
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("seedArchive rejects unknown archive names", async () => {
  const cacheRoot = mkdtempSync(path.join(tmpdir(), "arena-seed-"));
  try {
    const file = path.join(cacheRoot, "mystery-tool.7z");
    writeFileSync(file, Buffer.from("x"));
    await assert.rejects(
      () => seedArchive(file, { cacheRoot }),
      (error: unknown) => error instanceof ToolSeedError && /unknown tool archive/.test(error.message),
    );
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("toolStatus distinguishes missing / seeded / extracted", async () => {
  const cacheRoot = mkdtempSync(path.join(tmpdir(), "arena-seed-"));
  try {
    const file = path.join(cacheRoot, "tool-a.7z");
    writeFileSync(file, Buffer.from("a"));
    const table = { "tool-a.7z": { releaseName: "tool-a", sha256: await sha256File(file), purpose: "test" } };
    assert.equal(toolStatus(cacheRoot, table)[0].archiveSeeded, false);

    await seedArchive(file, { cacheRoot, table });
    let status = toolStatus(cacheRoot, table)[0];
    assert.equal(status.archiveSeeded, true);
    assert.equal(status.extracted, false, "archive present but not yet unpacked");

    // electron-builder's unpacked dir appears next to the archive
    mkdirSync(path.join(cacheRoot, "tool-a", "tool-a-abc12"), { recursive: true });
    status = toolStatus(cacheRoot, table)[0];
    assert.equal(status.extracted, true);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("the shipped checksum table matches the INSTALLED app-builder-lib source", async () => {
  await assertTableMatchesInstalledLib(repoRoot); // passes → in sync
  const tampered = { ...KNOWN_TOOLS };
  (tampered["nsis-3.0.4.1.7z"] as { sha256: string }).sha256 = "f".repeat(64);
  await assert.rejects(
    () => assertTableMatchesInstalledLib(repoRoot, tampered),
    (error: unknown) => error instanceof ToolSeedError && /out of sync/.test(error.message),
    "a drifted table must fail loudly, not seed archives the builder would delete",
  );
});
