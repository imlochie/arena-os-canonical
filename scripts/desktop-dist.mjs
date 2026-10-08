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
import { verifyDesktopShellFreshness } from "./lib/desktop-shell-freshness.mjs";

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

// Build-contract guard (f5a0a2e fix): electron-builder packages
// desktop/dist/** verbatim, so a stale compiled shell ships as-is. `npm run
// desktop:dist` compiles first; this guard additionally protects DIRECT
// invocations of this script — fail loudly, never package stale shell code.
const shellFreshness = verifyDesktopShellFreshness(root);
if (!shellFreshness.ok) {
  console.error(`[desktop:dist] ${shellFreshness.reason}`);
  console.error("Refusing to package a stale compiled desktop shell.");
  process.exit(1);
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

// Invoke electron-builder through its JS entry with Node directly. The .bin
// shim is a .cmd file on Windows, and Node (CVE-2024-27980 hardening)
// refuses to spawn .cmd without a shell — a silent EINVAL that produced
// exactly the "nothing after the preflight line" failure on the first real
// Windows build attempt. The JS entry sidesteps shims entirely.
let builderEntry = null;
try {
  const bin = JSON.parse(readFileSync(path.join(root, "node_modules", "electron-builder", "package.json"), "utf8"))?.bin?.["electron-builder"];
  if (typeof bin === "string") builderEntry = path.join(root, "node_modules", "electron-builder", bin);
} catch {
  // handled below with an actionable error
}
if (builderEntry === null || !existsSync(builderEntry)) {
  console.error(`[desktop:dist] electron-builder JS entry not found (looked for node_modules/electron-builder/cli.js) — is electron-builder installed?`);
  process.exit(1);
}
const build = spawnSync(
  process.execPath,
  [builderEntry, "--win", "--config", "electron-builder.yml", `--config.electronDist=${distDir}`],
  { cwd: root, stdio: "inherit" },
);
if (build.error !== undefined) {
  console.error(`[desktop:dist] electron-builder could not be started: ${String(build.error)}`);
  process.exit(1);
}
if (build.status !== 0) {
  console.error("");
  console.error("[desktop:dist] electron-builder failed. If the output above shows a toolset download");
  console.error('failure (nsis-*.7z / winCodeSign-*.7z / "socket hang up"), the build machine network');
  console.error("cannot fetch them — seed the tools once from local files and re-run:");
  console.error("  node scripts/desktop-seed-builder-tools.mjs --status");
  console.error("  node scripts/desktop-seed-builder-tools.mjs <nsis-3.0.4.1.7z> [nsis-resources-3.4.1.7z]");
  console.error("Archive URLs for a browser download are printed by --status / --help.");
  console.error("(Docs: docs/windows-acceptance.md — Offline tool seeding.)");
  process.exit(build.status ?? 1);
}
process.exit(0);
