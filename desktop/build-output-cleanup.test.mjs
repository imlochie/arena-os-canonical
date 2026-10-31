import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupInterruptedBuild, cleanupSuccessfulBuild } from "./cleanup-build.mjs";

async function exists(filePath) {
  return access(filePath).then(() => true, () => false);
}

test("successful packaging removes only regenerable staging and keeps the installer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-build-cleanup-"));
  const stageDir = path.join(root, "stage");
  const distDir = path.join(root, "dist");
  const installerDir = path.join(root, "installers");
  const unpackedDir = path.join(installerDir, "win-unpacked");
  try {
    await Promise.all([
      mkdir(stageDir),
      mkdir(distDir),
      mkdir(installerDir),
      mkdir(unpackedDir, { recursive: true }),
    ]);
    const installer = path.join(installerDir, "ArenaForge Setup.exe");
    await Promise.all([
      writeFile(path.join(stageDir, "chromium.exe"), "staged"),
      writeFile(path.join(distDir, "main.cjs"), "bundle"),
      writeFile(installer, "installer"),
      writeFile(path.join(unpackedDir, "ArenaForge.exe"), "unpacked app"),
    ]);
    await cleanupSuccessfulBuild({ stageDir, distDir, installerDir });
    assert.equal(await exists(stageDir), false);
    assert.equal(await exists(distDir), false);
    assert.equal(await exists(unpackedDir), false);
    assert.equal(await exists(installer), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed packaging preserves staging files when no installer exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-build-preserve-"));
  const stageDir = path.join(root, "stage");
  const distDir = path.join(root, "dist");
  const installerDir = path.join(root, "installers");
  const unpackedDir = path.join(installerDir, "win-unpacked");
  try {
    await Promise.all([
      mkdir(stageDir),
      mkdir(distDir),
      mkdir(installerDir),
      mkdir(unpackedDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(stageDir, "diagnostic.txt"), "keep for diagnosis"),
      writeFile(path.join(distDir, "main.cjs"), "keep for diagnosis"),
      writeFile(path.join(unpackedDir, "ArenaForge.exe"), "previous build"),
    ]);
    await assert.rejects(
      cleanupSuccessfulBuild({ stageDir, distDir, installerDir }),
      /No Windows installer was found/,
    );
    assert.equal(await exists(path.join(stageDir, "diagnostic.txt")), true);
    assert.equal(await exists(path.join(distDir, "main.cjs")), true);
    assert.equal(await exists(path.join(unpackedDir, "ArenaForge.exe")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit interrupted-build cleanup removes only generated staging folders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-build-interrupted-"));
  const stageDir = path.join(root, "desktop", "stage");
  const distDir = path.join(root, "desktop", "dist");
  const installerDir = path.join(root, "generated-artifacts", "windows");
  const unpackedDir = path.join(installerDir, "win-unpacked");
  const mediaDir = path.join(root, "user-data", "media");
  const cacheDir = path.join(root, "generated-artifacts", "windows-tool-cache");
  try {
    await Promise.all([
      mkdir(stageDir, { recursive: true }),
      mkdir(distDir, { recursive: true }),
      mkdir(unpackedDir, { recursive: true }),
      mkdir(mediaDir, { recursive: true }),
      mkdir(cacheDir, { recursive: true }),
    ]);
    const media = path.join(mediaDir, "original.wav");
    const installer = path.join(installerDir, "ArenaForge Setup.exe");
    const cache = path.join(cacheDir, "ffmpeg.zip");
    await Promise.all([
      writeFile(path.join(stageDir, "partial.bin"), "partial"),
      writeFile(path.join(distDir, "main.cjs"), "partial"),
      writeFile(path.join(unpackedDir, "partial.exe"), "partial"),
      writeFile(media, "original"),
      writeFile(installer, "existing installer"),
      writeFile(cache, "reusable download"),
    ]);
    await cleanupInterruptedBuild({ stageDir, distDir, unpackedDir });
    assert.equal(await exists(stageDir), false);
    assert.equal(await exists(distDir), false);
    assert.equal(await exists(unpackedDir), false);
    assert.equal(await exists(media), true);
    assert.equal(await exists(installer), true);
    assert.equal(await exists(cache), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
