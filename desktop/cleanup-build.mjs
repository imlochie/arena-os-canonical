import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeDirWithRetry } from "./fs-cleanup.mjs";

export async function cleanupSuccessfulBuild({
  stageDir,
  distDir,
  installerDir,
  unpackedDir = path.join(installerDir, "win-unpacked"),
  removeDir = removeDirWithRetry,
}) {
  const entries = await readdir(installerDir, { withFileTypes: true });
  const installerExists = entries.some(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"),
  );
  if (!installerExists) {
    throw new Error("No Windows installer was found; preserving generated staging files for diagnosis.");
  }
  await removeDir(stageDir);
  await removeDir(distDir);
  await removeDir(unpackedDir);
}

export async function cleanupInterruptedBuild({
  stageDir,
  distDir,
  unpackedDir,
  removeDir = removeDirWithRetry,
}) {
  await removeDir(stageDir);
  await removeDir(distDir);
  await removeDir(unpackedDir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktopDir = path.dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = path.dirname(desktopDir);
  const stageDir = path.join(desktopDir, "stage");
  const distDir = path.join(desktopDir, "dist");
  const installerDir = path.join(workspaceRoot, "generated-artifacts", "windows");
  const unpackedDir = path.join(installerDir, "win-unpacked");
  const cleanupMode = process.argv[2];
  if (cleanupMode && cleanupMode !== "--failed-build") {
    throw new Error("Use no option for successful-build cleanup or --failed-build for interrupted staging.");
  }
  if (cleanupMode === "--failed-build") {
    await cleanupInterruptedBuild({ stageDir, distDir, unpackedDir });
    console.log("Removed only generated staging and unpacked build files. Installer files, download caches, user data, and original media remain.");
  } else {
    await cleanupSuccessfulBuild({ stageDir, distDir, installerDir, unpackedDir });
    console.log("Removed temporary desktop staging and unpacked files; the Windows installer and download caches remain.");
  }
}
