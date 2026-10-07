/**
 * Stages everything the packaged app needs into desktop-package/ for
 * electron-builder's extraResources (see electron-builder.yml).
 *
 * Run on the machine that builds the installer. Steps:
 *  1. ARENA_DESKTOP_BUILD=1 next build  → .next/standalone server
 *  2. copy .next/static + public/ inside the staged server tree
 *  3. copy FFmpeg/FFprobe from the @ffmpeg-installer platform packages
 *  4. copy Embedded PostgreSQL binaries from the @embedded-postgres package
 *  5. copy the canonical desktop-migrations + the FFmpeg GPL license notice
 *
 * Nothing from the repo root (caches, fixtures, .env, test data) is staged.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const out = path.join(root, "desktop-package");
rmSync(out, { recursive: true, force: true });

console.log("[desktop:prepare-server] building standalone Next server…");
// Page-data collection imports route modules, which validate DATABASE_URL
// eagerly. The real value is injected by the supervisor at runtime; for the
// build itself any syntactically valid placeholder works.
const buildEnv = { ...process.env, ARENA_DESKTOP_BUILD: "1" };
if (!buildEnv.DATABASE_URL) buildEnv.DATABASE_URL = "postgres://build:build@127.0.0.1:5432/arena";
execFileSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
  cwd: root,
  env: buildEnv,
  stdio: "inherit",
});

const standalone = path.join(root, ".next", "standalone");
if (!existsSync(path.join(standalone, "server.js"))) {
  throw new Error("Standalone build did not produce server.js — is output:'standalone' enabled?");
}

console.log("[desktop:prepare-server] staging into desktop-package/…");
mkdirSync(out, { recursive: true });

// 1. The standalone server tree (server.js + traced node_modules).
cpSync(standalone, path.join(out, "server"), { recursive: true });

// 2. Static assets Next serves from beside server.js (inside the staged tree).
mkdirSync(path.join(out, "server", ".next"), { recursive: true });
cpSync(path.join(root, ".next", "static"), path.join(out, "server", ".next", "static"), { recursive: true });
if (existsSync(path.join(root, "public"))) {
  cpSync(path.join(root, "public"), path.join(out, "server", "public"), { recursive: true });
} else {
  mkdirSync(path.join(out, "server", "public"), { recursive: true });
}

// Canonical SQL migrations live at the app-root level (see electron-builder
// extraResources and desktop/runtime/config.ts migrationsDir).
cpSync(path.join(root, "desktop-migrations"), path.join(out, "desktop-migrations"), { recursive: true });

// 3. FFmpeg / FFprobe from the registry-bundled platform packages.
// Layout: @ffmpeg-installer/<platform>/ffmpeg(.exe) — the platform package
// drops the tool suffix (e.g. @ffmpeg-installer/linux-x64).
const platform = process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-x64" : "linux-x64";
mkdirSync(path.join(out, "bin"), { recursive: true });
for (const [installer, tool] of [
  ["@ffmpeg-installer/ffmpeg", "ffmpeg"],
  ["@ffprobe-installer/ffprobe", "ffprobe"],
]) {
  const ext = process.platform === "win32" ? ".exe" : "";
  const platformPackage = installer === "@ffmpeg-installer/ffmpeg" ? `@ffmpeg-installer/${platform}` : `@ffprobe-installer/${platform}`;
  const candidates = [
    path.join(root, "node_modules", platformPackage, tool + ext),
    path.join(root, "node_modules", installer, tool + ext),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (source === undefined) throw new Error(`Could not find ${tool} binary (looked at ${candidates.join(", ")})`);
  cpSync(source, path.join(out, "bin", tool + ext));
}

// 4. Embedded PostgreSQL binaries.
const pgPackage = `@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"}-x64`;
const pgNative = path.join(root, "node_modules", pgPackage, "native");
if (!existsSync(path.join(pgNative, "bin"))) {
  throw new Error(`${pgPackage} is not installed — run npm install on this platform.`);
}
cpSync(pgNative, path.join(out, "embedded-postgres"), { recursive: true, verbatimSymlinks: true });

// 5. License notices (FFmpeg builds are GPL).
mkdirSync(path.join(root, "desktop", "build", "licenses"), { recursive: true });
writeFileSync(
  path.join(root, "desktop", "build", "licenses", "FFMPEG-LICENSE.txt"),
  [
    "Arena bundles FFmpeg and FFprobe static builds distributed by the",
    "@ffmpeg-installer / @ffprobe-installer npm packages.",
    "",
    "These builds are licensed under the GNU General Public License (GPL).",
    "Source code for FFmpeg is available at https://ffmpeg.org.",
    "",
    "FFmpeg is a trademark of Fabrice Bellard, orig. author of FFmpeg.",
    "This product is not affiliated with the FFmpeg project.",
  ].join("\n"),
  "utf8",
);

console.log("[desktop:prepare-server] staged:");
console.log("  server/            (Next standalone + traced deps + static + public)");
console.log("  desktop-migrations/");
console.log("  bin/ffmpeg, bin/ffprobe");
console.log(`  embedded-postgres/ (from ${pgPackage})`);
console.log("[desktop:prepare-server] done.");
