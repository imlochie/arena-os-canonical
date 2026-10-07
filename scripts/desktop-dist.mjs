/**
 * desktop:dist preflight + electron-builder invocation.
 *
 * electron-builder downloads its own Electron copy from github.com even when
 * a perfectly good Electron is installed locally (node_modules/electron/dist
 * — hydrated lazily by electron itself on first run, NOT by an install
 * script). This wrapper points electron-builder at the local distribution
 * (electronDist) after validating it, so a network-restricted build machine
 * never needs github.com for the runtime:
 *
 *   1. node_modules/electron/dist exists and contains the platform binary
 *   2. its version satisfies the electron version declared in package.json
 *      (no silent version mismatch — a hard error otherwise)
 *   3. missing dist → an actionable error (how to obtain it), never a
 *      confusing download failure inside electron-builder
 *
 * No integrity or security options are disabled; only the source of the
 * Electron distribution changes.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { repoRootFromMeta } from "./lib/repo-root.mjs";

const root = repoRootFromMeta(import.meta.url);
const require = createRequire(import.meta.url);

const distDir = path.join(root, "node_modules", "electron", "dist");
const exeName = process.platform === "win32" ? "electron.exe" : "electron";
const problems = [];

if (!existsSync(distDir)) {
  problems.push(`the local Electron distribution directory is missing: ${distDir}`);
} else if (!existsSync(path.join(distDir, exeName))) {
  problems.push(`the local Electron distribution has no ${exeName} binary: ${distDir}`);
}

let installedVersion = null;
if (existsSync(distDir)) {
  const versionFile = path.join(distDir, "version");
  if (existsSync(versionFile)) {
    installedVersion = readFileSync(versionFile, "utf8").trim();
  } else {
    try {
      installedVersion = JSON.parse(readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8")).version;
    } catch {
      installedVersion = null;
    }
  }
}

const declaredRange = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).devDependencies?.electron;
if (installedVersion === null && existsSync(distDir)) {
  // Only a version problem when the dist exists but is unreadable — a
  // missing dist is already reported above.
  problems.push("the local Electron version could not be determined from the distribution");
} else if (installedVersion !== null && typeof declaredRange === "string") {
  const semver = require("semver");
  if (!semver.satisfies(installedVersion, declaredRange)) {
    problems.push(
      `version mismatch: local Electron distribution is ${installedVersion}, but package.json declares "${declaredRange}" — refusing to package a silent mismatch`,
    );
  }
}

if (problems.length > 0) {
  console.error("[desktop:dist] cannot use the local Electron distribution:");
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error("");
  console.error("electron-builder is configured (electronDist) to package the LOCAL");
  console.error("Electron from node_modules/electron/dist instead of downloading one.");
  console.error("To obtain it on this machine, run ONE of:");
  console.error("  node node_modules/electron/install.js      # hydrate dist directly");
  console.error("  npx electron --version                     # first run hydrates it");
  console.error("(electron 44 has no npm install script — the binary is fetched lazily.)");
  process.exit(1);
}

console.log(`[desktop:dist] using local Electron ${installedVersion} from ${distDir}`);
const build = spawnSync(
  path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"),
  ["--win", "--config", "electron-builder.yml", `--config.electronDist=${distDir}`],
  { cwd: root, stdio: "inherit" },
);
process.exit(build.status ?? 1);
