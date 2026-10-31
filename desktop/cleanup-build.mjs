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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktopDir = path.dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = path.dirname(desktopDir);
  await cleanupSuccessfulBuild({
    stageDir: path.join(desktopDir, "stage"),
    distDir: path.join(desktopDir, "dist"),
    installerDir: path.join(workspaceRoot, "generated-artifacts", "windows"),
  });
  console.log("Removed temporary desktop staging and unpacked files; the Windows installer and download caches remain.");
}
