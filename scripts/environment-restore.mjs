#!/usr/bin/env node
/**
 * Environment restore — one command after a container/workspace rebuild.
 *
 * Rebuilds wipe node_modules, the local PostgreSQL install/data (they live in
 * snapshot-excluded paths) and .env. This script brings all three back:
 *
 *   1. node_modules  → `npm ci --ignore-scripts` when tsc is missing
 *                      (native-binary postinstalls fetch from hosts that are
 *                      blocked in the dev sandbox; owner-side `npm ci` runs
 *                      them normally — see docs/model-hub.md + README notes)
 *   2. PostgreSQL     → npm-hosted @embedded-postgres/linux-x64 binaries in
 *                      ~/.cache/env-tools, initdb + pg_ctl on 5432
 *   3. schema         → scripts/ensure-env.mjs (recreates .env) +
 *                      scripts/db-setup.mjs (drizzle push, creates the DB)
 *
 * Usage:  node scripts/environment-restore.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

const root = process.cwd();
const HOME = process.env.HOME ?? "/home/user";
const pgData = join(HOME, ".cache/waveyard-pgdata");
const envTools = join(HOME, ".cache/env-tools");
const pgBin = join(envTools, "node_modules/@embedded-postgres/linux-x64/native/bin");

function log(step, msg) {
  console.log(`[env-restore] ${step}: ${msg}`);
}

function pgUp() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 5432, timeout: 800 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

async function main() {
  // --- 1. node_modules -------------------------------------------------
  if (!existsSync(join(root, "node_modules/.bin/tsc"))) {
    log("deps", "node_modules missing — npm ci --ignore-scripts (sandbox-safe)");
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { stdio: "inherit", cwd: root });
    // --ignore-scripts skips benign postinstalls these packages need:
    //  - @embedded-postgres/*: hydrate libpq.so.5-style versioned symlinks
    //    (run with the package dir as cwd — the script resolves relatively)
    //  - @ff{mpeg,probe}-installer/*: chmod u+x the real binaries
    // (onnxruntime-node's nuget postinstall stays skipped: nuget is blocked
    //  in the sandbox; the linux-x64 binding ships inside the tarball.)
    for (const pkg of ["@embedded-postgres/linux-x64", "@embedded-postgres/linux-arm64", "@embedded-postgres/darwin-x64", "@embedded-postgres/darwin-arm64"]) {
      const dir = join(root, "node_modules", pkg);
      if (!existsSync(join(dir, "scripts/hydrate-symlinks.js"))) continue;
      try {
        execFileSync("node", ["scripts/hydrate-symlinks.js"], { stdio: "ignore", cwd: dir });
        log("deps", `${pkg}: symlinks hydrated`);
      } catch {
        log("deps", `${pkg}: symlink hydration failed (may still work)`);
      }
    }
    for (const bin of ["@ffprobe-installer/linux-x64/ffprobe", "@ffmpeg-installer/linux-x64/ffmpeg"]) {
      const target = join(root, "node_modules", bin);
      if (existsSync(target)) {
        try {
          execFileSync("chmod", ["u+x", target], { stdio: "ignore" });
          log("deps", `${bin}: +x`);
        } catch {
          /* best effort */
        }
      }
    }
  } else {
    log("deps", "node_modules present");
  }

  // --- 2. PostgreSQL ---------------------------------------------------
  if (await pgUp()) {
    log("pg", "already listening on 5432");
  } else {
    if (!existsSync(join(pgBin, "pg_ctl"))) {
      log("pg", "installing npm-hosted PostgreSQL binaries (~/.cache/env-tools)");
      mkdirSync(envTools, { recursive: true });
      execFileSync("npm", ["init", "-y"], { stdio: "ignore", cwd: envTools });
      execFileSync("npm", ["install", "@embedded-postgres/linux-x64", "--no-audit", "--no-fund"], { stdio: "inherit", cwd: envTools });
    }
    if (!existsSync(join(pgData, "PG_VERSION"))) {
      log("pg", `initdb → ${pgData}`);
      mkdirSync(pgData, { recursive: true });
      execFileSync(join(pgBin, "initdb"), ["-D", pgData, "-U", "postgres", "--auth=trust"], { stdio: "inherit" });
    }
    log("pg", "starting on 127.0.0.1:5432");
    execFileSync(join(pgBin, "pg_ctl"), ["-D", pgData, "-o", "-p 5432 -h 127.0.0.1 -k /tmp", "-l", "/tmp/pg.log", "start"], { stdio: "inherit" });
    for (let i = 0; i < 20 && !(await pgUp()); i++) await new Promise((r) => setTimeout(r, 250));
    log("pg", (await pgUp()) ? "UP" : "FAILED to come up (see /tmp/pg.log)");
  }

  // --- 3. .env + schema --------------------------------------------------
  spawnSync("node", [join(root, "scripts/ensure-env.mjs")], { stdio: "inherit", cwd: root });
  const setup = spawnSync("node", [join(root, "scripts/db-setup.mjs")], { stdio: "inherit", cwd: root });
  log("schema", setup.status === 0 ? "applied" : `db-setup exited ${setup.status}`);
  log("done", "environment restored (run `npm test` to verify)");
}

main().catch((error) => {
  console.error("[env-restore] failed:", error.message);
  process.exit(1);
});
