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

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { assertStagedTreeClean } from "./lib/staged-tree-guard.mjs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const out = path.join(root, "desktop-package");
rmSync(out, { recursive: true, force: true });

// Deterministic staging starts from a FRESH standalone tree: a stale
// `.next/standalone` from an interrupted build must never leak into the
// staged package.
rmSync(path.join(root, ".next", "standalone"), { recursive: true, force: true });

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
//
// Turbopack emits server-external packages (pg) under hashed keys in
// `.next/node_modules/` as SYMLINKS (e.g. pg-<hash> → ../../node_modules/pg).
// Node's cpSync has a quirk here: `dereference: true` is ignored for symlinks
// nested inside a copied directory, and the default rewrites relative links
// to ABSOLUTE paths into the repo build tree — either way the "self-contained"
// staged tree would break the moment the repo's .next is rebuilt (exactly
// what the installer would ship). So: copy, then MATERIALIZE every symlink
// under server/ into a real copy of its resolved target.
cpSync(standalone, path.join(out, "server"), { recursive: true });
function materializeSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(full), readlinkSync(full));
      if (!existsSync(resolved)) {
        throw new Error(`Staging found a dangling symlink: ${full} → ${resolved}`);
      }
      rmSync(full, { recursive: true, force: true });
      cpSync(resolved, full, { recursive: true, dereference: true });
    } else if (entry.isDirectory()) {
      materializeSymlinks(full);
    }
  }
}
materializeSymlinks(path.join(out, "server"));

// 1b. NEVER ship environment files. Next standalone copies `.env*` from the
// project root into the output whenever one exists (a real, gitignored
// repo .env can therefore leak into the installer). The packaged runtime
// receives ALL of its configuration from the supervisor's child env —
// remove any env file and fail staging if one ever reappears.
for (const envFile of readdirSync(path.join(out, "server")).filter((name) => /^\.env(\..+)?$/.test(name))) {
  rmSync(path.join(out, "server", envFile), { force: true });
  console.log(`[desktop:prepare-server] excluded ${envFile} from the staged server (runtime env comes from the supervisor)`);
}

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

// Self-containment invariant: the staged tree must run on a machine where the
// repo (and this build directory) does not exist. Any symlink whose target
// resolves outside desktop-package/ would break there. Allowed: symlinks that
// stay inside the staged tree (e.g. embedded-postgres soname links).
function assertSelfContained(dir, stagedRoot) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(full);
      const resolved = path.resolve(path.dirname(full), target);
      if (!resolved.startsWith(stagedRoot + path.sep)) {
        throw new Error(`Staged tree is not self-contained: ${full} → ${target} escapes ${stagedRoot}`);
      }
    }
    if (entry.isDirectory()) assertSelfContained(full, stagedRoot);
  }
}
for (const staged of ["server", "desktop-migrations", "bin", "embedded-postgres"]) {
  assertSelfContained(path.join(out, staged), out);
}

// Recursive self-packaging guard: the staged server must contain NO build
// output (a previous desktop-release/win-unpacked traced into the standalone
// tree once shipped the entire previous build INSIDE the installer — see
// scripts/lib/staged-tree-guard.mjs and next.config.ts excludes).
assertStagedTreeClean(path.join(out, "server"));

// Env-file guard (defense in depth for the removal above): the staged server
// root must never contain .env* — spec §15: no secrets, no repo junk.
const stagedEnvFiles = readdirSync(path.join(out, "server")).filter((name) => /^\.env(\..+)?$/.test(name));
if (stagedEnvFiles.length > 0) {
  throw new Error(`Staged server contains environment files: ${stagedEnvFiles.join(", ")}`);
}

// The staged tree mirrors the installed resources layout; the license also
// goes to desktop/build/licenses for electron-builder's extraResources.
mkdirSync(path.join(out, "licenses"), { recursive: true });
cpSync(
  path.join(root, "desktop", "build", "licenses", "FFMPEG-LICENSE.txt"),
  path.join(out, "licenses", "FFMPEG-LICENSE.txt"),
);

console.log("[desktop:prepare-server] staged:");
console.log("  server/            (Next standalone + traced deps + static + public)");
console.log("  desktop-migrations/");
console.log("  bin/ffmpeg, bin/ffprobe");
console.log(`  embedded-postgres/ (from ${pgPackage})`);
console.log("[desktop:prepare-server] done.");
