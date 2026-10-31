import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupSuccessfulBuild } from "./cleanup-build.mjs";

async function exists(filePath) {
  return access(filePath).then(() => true, () => false);
}

test("successful packaging removes only regenerable staging and keeps the installer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-build-cleanup-"));
  const stageDir = path.join(root, "stage");
  const distDir = path.join(root, "dist");
  const installerDir = path.join(root, "installers");
  try {
    await Promise.all([
      mkdir(stageDir),
      mkdir(distDir),
      mkdir(installerDir),
    ]);
    const installer = path.join(installerDir, "ArenaForge Setup.exe");
    await Promise.all([
      writeFile(path.join(stageDir, "chromium.exe"), "staged"),
      writeFile(path.join(distDir, "main.cjs"), "bundle"),
      writeFile(installer, "installer"),
    ]);
    await cleanupSuccessfulBuild({ stageDir, distDir, installerDir });
    assert.equal(await exists(stageDir), false);
    assert.equal(await exists(distDir), false);
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
  try {
    await Promise.all([
      mkdir(stageDir),
      mkdir(distDir),
      mkdir(installerDir),
    ]);
    await Promise.all([
      writeFile(path.join(stageDir, "diagnostic.txt"), "keep for diagnosis"),
      writeFile(path.join(distDir, "main.cjs"), "keep for diagnosis"),
    ]);
    await assert.rejects(
      cleanupSuccessfulBuild({ stageDir, distDir, installerDir }),
      /No Windows installer was found/,
    );
    assert.equal(await exists(path.join(stageDir, "diagnostic.txt")), true);
    assert.equal(await exists(path.join(distDir, "main.cjs")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
