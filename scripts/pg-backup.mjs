/**
 * pg-backup — safe, verified filesystem backup of an Arena PostgreSQL data
 * directory. Standalone (node scripts/pg-backup.mjs), no dependencies, so
 * it runs even when the application cannot start.
 *
 * Safety rules (docs/POSTGRES-RECOVERY.md):
 *   - refuses to back up a directory with no readable PG_VERSION
 *   - refuses while the postmaster is alive (a live cluster copy is torn
 *     and useless for recovery) — stop Arena/PostgreSQL first
 *   - NEVER modifies, moves or deletes the source directory
 *   - the copy is verified (entry count + byte total + PG_VERSION bytes)
 *     and a manifest records what was copied and how much it weighs
 *
 * Usage:
 *   node scripts/pg-backup.mjs <dataDir> [--out <backupRoot>]
 *
 * Backup layout: <backupRoot>/postgres-<timestamp>/ with backup-manifest.json
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export function readDataDirVersion(dataDir) {
  try {
    const raw = readFileSync(path.join(dataDir, "PG_VERSION"), "utf8").trim();
    return /^\d+$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function defaultProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** postmaster.pid is a live lock only while its PID exists. */
export function postmasterAlive(dataDir, processExists = defaultProcessExists) {
  try {
    const pid = Number.parseInt(readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n")[0] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 && processExists(pid);
  } catch {
    return false;
  }
}

async function measure(dir) {
  let files = 0;
  let bytes = 0;
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        files += 1;
        bytes += (await stat(full)).size;
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

/**
 * Copy `dataDir` into `<outRoot>/postgres-<timestamp>/`, verify the copy,
 * and write backup-manifest.json. Returns { dest, manifest }.
 * Throws (leaving the source untouched) when any safety rule is violated
 * or the verification fails.
 */
export async function createBackup(dataDir, outRoot, options = {}) {
  const processExists = options.processExists ?? defaultProcessExists;
  const now = options.now ?? (() => new Date());

  const version = readDataDirVersion(dataDir);
  if (version === null) {
    throw new Error(
      `Refusing to back up: ${dataDir} has no readable PG_VERSION — this does not look like a PostgreSQL data directory.`,
    );
  }
  if (postmasterAlive(dataDir, processExists)) {
    throw new Error(
      `Refusing to back up while PostgreSQL is running (postmaster.pid is live). Stop Arena/PostgreSQL first, then retry.`,
    );
  }

  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(outRoot, `postgres-${timestamp}`);
  await mkdir(dest, { recursive: true });

  // A straight recursive copy: symlinks stay symlinks, nothing is rewritten.
  await cp(dataDir, dest, { recursive: true, verbatimSymlinks: true, force: true });

  const sourceStats = await measure(dataDir);
  const destStats = await measure(dest);
  const sourceVersionBytes = await readFile(path.join(dataDir, "PG_VERSION"));
  const destVersionBytes = await readFile(path.join(dest, "PG_VERSION"));
  const versionSha = createHash("sha256").update(sourceVersionBytes).digest("hex");

  const manifest = {
    tool: "arena pg-backup",
    createdAt: now().toISOString(),
    source: path.resolve(dataDir),
    destination: path.resolve(dest),
    pgVersion: version,
    pgVersionSha256: versionSha,
    fileCount: sourceStats.files,
    totalBytes: sourceStats.bytes,
    verified: {
      fileCountMatches: sourceStats.files === destStats.files,
      totalBytesMatches: sourceStats.bytes === destStats.bytes,
      pgVersionMatches: sourceVersionBytes.equals(destVersionBytes),
    },
    topLevel: (await readdir(dest)).sort(),
  };

  if (!manifest.verified.fileCountMatches || !manifest.verified.totalBytesMatches || !manifest.verified.pgVersionMatches) {
    throw new Error(
      `Backup verification FAILED for ${dest} (files ${destStats.files}/${sourceStats.files}, bytes ${destStats.bytes}/${sourceStats.bytes}). ` +
        `The source directory is untouched; the incomplete copy should be discarded.`,
    );
  }

  await writeFile(path.join(dest, "backup-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { dest, manifest };
}

/** Re-verify an existing backup directory against its manifest. */
export async function verifyBackup(dest, processExists = defaultProcessExists) {
  const manifestPath = path.join(dest, "backup-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`No backup-manifest.json in ${dest}`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const stats = await measure(dest);
  // The manifest itself and only the manifest is excluded from the count.
  const filesWithoutManifest = stats.files - 1;
  const versionBytes = await readFile(path.join(dest, "PG_VERSION"));
  const versionSha = createHash("sha256").update(versionBytes).digest("hex");
  const ok =
    filesWithoutManifest === manifest.fileCount &&
    versionSha === manifest.pgVersionSha256 &&
    typeof manifest.pgVersion === "string";
  return { ok, manifest, measured: { fileCount: filesWithoutManifest, totalBytes: stats.bytes } };
}

// --------------------------- CLI -----------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const outIndex = args.indexOf("--out");
  const dataDir = positional[0];
  const outRoot = outIndex >= 0 ? args[outIndex + 1] : null;
  if (!dataDir || !outRoot) {
    console.error("usage: node scripts/pg-backup.mjs <dataDir> --out <backupRoot>");
    process.exit(2);
  }
  try {
    const { dest, manifest } = await createBackup(dataDir, outRoot);
    console.log(`backup written to ${dest}`);
    console.log(`  PostgreSQL data version: ${manifest.pgVersion}`);
    console.log(`  files: ${manifest.fileCount}   bytes: ${manifest.totalBytes}`);
    console.log(`  verified: ${JSON.stringify(manifest.verified)}`);
  } catch (error) {
    console.error(`pg-backup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  await main();
}
