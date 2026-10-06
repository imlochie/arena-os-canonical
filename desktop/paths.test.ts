/**
 * Data-directory resolution — platform semantics tested with real win32
 * path operations on any host. The Waveyard storage bug (forward-slash
 * containment checks vs backslash reality) is exactly the class of error
 * these tests exist to catch before it reaches a Windows machine.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  PORTABLE_MARKER,
  resolveArenaDataDirs,
} from "./paths";

const WIN_LOCAL = String.raw`C:\Users\lochi\AppData\Local`;

test("win32 default: %LOCALAPPDATA%\\Arena with backslash-only subpaths", () => {
  const dirs = resolveArenaDataDirs(
    {
      platform: "win32",
      env: { LOCALAPPDATA: WIN_LOCAL },
      fileExists: () => false,
    },
    path.win32,
  );
  assert.equal(dirs.source, "platform");
  assert.equal(dirs.portable, false);
  assert.equal(dirs.root, String.raw`C:\Users\lochi\AppData\Local\Arena`);
  assert.equal(
    dirs.waveyard,
    String.raw`C:\Users\lochi\AppData\Local\Arena\waveyard`,
  );
  // The anti-waveyard-bug assertion: no mixed separators anywhere.
  for (const dir of [
    dirs.root,
    dirs.data,
    dirs.projects,
    dirs.waveyard,
    dirs.cache,
    dirs.logs,
    dirs.models,
    dirs.runtime,
    dirs.settings,
  ]) {
    assert.ok(!dir.includes("/"), `win32 path must not contain '/': ${dir}`);
  }
});

test("win32: home fallback when LOCALAPPDATA is missing", () => {
  const dirs = resolveArenaDataDirs(
    {
      platform: "win32",
      env: {},
      homeDir: String.raw`C:\Users\lochi`,
      fileExists: () => false,
    },
    path.win32,
  );
  assert.equal(dirs.root, String.raw`C:\Users\lochi\AppData\Local\Arena`);
});

test("env override wins and must be absolute", () => {
  const dirs = resolveArenaDataDirs(
    {
      platform: "win32",
      env: {
        LOCALAPPDATA: WIN_LOCAL,
        ARENA_DATA_DIR: String.raw`D:\ArenaData`,
      },
      fileExists: () => false,
    },
    path.win32,
  );
  assert.equal(dirs.source, "env");
  assert.equal(dirs.root, String.raw`D:\ArenaData`);

  assert.throws(
    () =>
      resolveArenaDataDirs(
        { platform: "win32", env: { ARENA_DATA_DIR: "relative/no" }, fileExists: () => false },
        path.win32,
      ),
    /absolute/,
  );
});

test("portable marker keeps data beside the executable (opt-in only)", () => {
  const exeDir = String.raw`C:\Arena`;
  const dirs = resolveArenaDataDirs(
    {
      platform: "win32",
      env: { LOCALAPPDATA: WIN_LOCAL },
      exeDir,
      fileExists: (p) => p === path.win32.join(exeDir, PORTABLE_MARKER),
    },
    path.win32,
  );
  assert.equal(dirs.source, "portable");
  assert.equal(dirs.portable, true);
  assert.equal(dirs.root, String.raw`C:\Arena\arena-data`);

  // Without the marker, the same layout resolves to LOCALAPPDATA.
  const normal = resolveArenaDataDirs(
    {
      platform: "win32",
      env: { LOCALAPPDATA: WIN_LOCAL },
      exeDir,
      fileExists: () => false,
    },
    path.win32,
  );
  assert.equal(normal.source, "platform");
  assert.equal(normal.root, String.raw`C:\Users\lochi\AppData\Local\Arena`);
});

test("posix default: XDG data home convention", () => {
  const dirs = resolveArenaDataDirs(
    { platform: "linux", env: {}, homeDir: "/home/lochi", fileExists: () => false },
    path.posix,
  );
  assert.equal(dirs.source, "platform");
  assert.equal(dirs.root, "/home/lochi/.local/share/arena");
  assert.ok(!dirs.root.includes("\\"));

  const xdg = resolveArenaDataDirs(
    {
      platform: "linux",
      env: { XDG_DATA_HOME: "/custom/xdg" },
      homeDir: "/home/lochi",
      fileExists: () => false,
    },
    path.posix,
  );
  assert.equal(xdg.root, "/custom/xdg/arena");
});

test("no resolvable location throws honestly instead of guessing", () => {
  assert.throws(
    () =>
      resolveArenaDataDirs(
        { platform: "win32", env: {}, fileExists: () => false },
        path.win32,
      ),
    /data directory/i,
  );
});
