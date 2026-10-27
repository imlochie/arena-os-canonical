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
 *   - the copy is verified PER FILE (sha256 of every regular file and of
 *     every symlink target), plus counts and byte totals; a manifest
 *     records what was copied, its hashes, and how much it weighs
 *   - restoreBackup() re-creates a cluster in a separate directory and
 *     verifies the round-trip against the manifest
 *
 * Tablespaces: Arena's embedded PostgreSQL never creates them. If
 * pg_tblspc contains entries the manifest records them and verification
 * covers only what was copied — external tablespace locations are NOT
 * followed or copied.
 *
 * Usage:
 *   node scripts/pg-backup.mjs <dataDir> --out <backupRoot>
 *   node scripts/pg-backup.mjs --restore <backupDir> --target <newDataDir>
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
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

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Walk a directory tree and return an entry per file/symlink:
 *   rel -> { kind: "file", bytes, sha256 } | { kind: "symlink", target }
 * Directory entries are implicit (recreated on restore).
 */
export async function hashTree(root) {
  const entries = {};
  let totalBytes = 0;
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        const target = await (await import("node:fs/promises")).readlink(full);
        entries[rel] = { kind: "symlink", target };
      } else if (entry.isDirectory()) {
        await walk(full);
      } else {
        const size = (await stat(full)).size;
        entries[rel] = { kind: "file", bytes: size, sha256: await hashFile(full) };
        totalBytes += size;
      }
    }
  };
  await walk(root);
  return { entries, fileCount: Object.keys(entries).length, totalBytes };
}

async function compareTrees(sourceRoot, destRoot, expected, ignore = new Set()) {
  const mismatches = [];
  const actual = await hashTree(destRoot);
  for (const rel of ignore) delete actual.entries[rel];
  // Recompute totals over the entries that are actually compared.
  let totalBytes = 0;
  for (const entry of Object.values(actual.entries)) totalBytes += entry.bytes ?? 0;
  actual.fileCount = Object.keys(actual.entries).length;
  actual.totalBytes = totalBytes;
  for (const [rel, want] of Object.entries(expected)) {
    const got = actual.entries[rel];
    if (got === undefined) {
      mismatches.push(`${rel}: missing from the copy`);
    } else if (JSON.stringify(got) !== JSON.stringify(want)) {
      mismatches.push(`${rel}: content differs`);
    }
  }
  for (const rel of Object.keys(actual.entries)) {
    if (expected[rel] === undefined && !ignore.has(rel)) mismatches.push(`${rel}: extra in the copy`);
  }
  return { mismatches, actual };
}

/**
 * Copy `dataDir` into `<outRoot>/postgres-<timestamp>/`, verify the copy
 * file-by-file against the source, and write backup-manifest.json.
 * Returns { dest, manifest }. Throws (leaving the source untouched) when
 * any safety rule is violated or the verification fails.
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

  const source = await hashTree(dataDir);
  const check = await compareTrees(dataDir, dest, source.entries);
  const sourceVersionBytes = await readFile(path.join(dataDir, "PG_VERSION"));
  const destVersionBytes = await readFile(path.join(dest, "PG_VERSION"));

  let tablespaces = [];
  try {
    tablespaces = await readdir(path.join(dataDir, "pg_tblspc"));
  } catch {
    tablespaces = [];
  }

  const manifest = {
    tool: "arena pg-backup",
    createdAt: now().toISOString(),
    source: path.resolve(dataDir),
    destination: path.resolve(dest),
    pgVersion: version,
    pgVersionSha256: createHash("sha256").update(sourceVersionBytes).digest("hex"),
    fileCount: source.fileCount,
    totalBytes: source.totalBytes,
    files: source.entries,
    tablespaces: tablespaces.map(String),
    verified: {
      perFileMatches: check.mismatches.length === 0,
      fileCountMatches: check.actual.fileCount === source.fileCount,
      totalBytesMatches: check.actual.totalBytes === source.totalBytes,
      pgVersionMatches: sourceVersionBytes.equals(destVersionBytes),
      mismatches: check.mismatches.slice(0, 20),
    },
    topLevel: (await readdir(dest)).sort(),
  };

  if (!manifest.verified.perFileMatches || !manifest.verified.fileCountMatches || !manifest.verified.totalBytesMatches || !manifest.verified.pgVersionMatches) {
    throw new Error(
      `Backup verification FAILED for ${dest} (${check.mismatches.slice(0, 5).join("; ") || "totals differ"}). ` +
        `The source directory is untouched; the incomplete copy should be discarded.`,
    );
  }

  await writeFile(path.join(dest, "backup-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { dest, manifest };
}

/** Re-verify an existing backup directory against its manifest (per file). */
export async function verifyBackup(dest) {
  const manifestPath = path.join(dest, "backup-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`No backup-manifest.json in ${dest}`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // Manifest hashes exclude the manifest itself.
  const check = await compareTrees(dest, dest, manifest.files, new Set(["backup-manifest.json"]));
  const versionBytes = await readFile(path.join(dest, "PG_VERSION"));
  const versionSha = createHash("sha256").update(versionBytes).digest("hex");
  const ok =
    check.mismatches.length === 0 &&
    check.actual.fileCount === manifest.fileCount &&
    versionSha === manifest.pgVersionSha256;
  return {
    ok,
    manifest,
    mismatches: check.mismatches.slice(0, 20),
    measured: { fileCount: check.actual.fileCount, totalBytes: check.actual.totalBytes },
  };
}

/**
 * Restore a verified backup into a NEW data directory (never over an
 * existing one). Verifies the restored tree against the manifest before
 * reporting success.
 */
export async function restoreBackup(backupDir, targetDir) {
  const manifestPath = path.join(backupDir, "backup-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`No backup-manifest.json in ${backupDir}`);
  if (existsSync(targetDir)) {
    const entries = await readdir(targetDir).catch(() => ["?"]);
    if (entries.length > 0) {
      throw new Error(`Refusing to restore over a non-empty directory: ${targetDir}`);
    }
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const check = await verifyBackup(backupDir);
  if (!check.ok) {
    throw new Error(`Backup ${backupDir} does not verify (${check.mismatches.join("; ")}); refusing to restore from it.`);
  }
  await mkdir(targetDir, { recursive: true });
  await cp(backupDir, targetDir, {
    recursive: true,
    verbatimSymlinks: true,
    force: true,
    filter: (src) => path.basename(src) !== "backup-manifest.json",
  });
  const restored = await compareTrees(targetDir, targetDir, manifest.files);
  if (restored.mismatches.length > 0) {
    throw new Error(`Restore verification FAILED: ${restored.mismatches.slice(0, 5).join("; ")}`);
  }
  return { target: path.resolve(targetDir), fileCount: restored.actual.fileCount, totalBytes: restored.actual.totalBytes, pgVersion: manifest.pgVersion };
}

// --------------------------- CLI -----------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  try {
    if (args.includes("--restore")) {
      const backupDir = flag("--restore");
      const target = flag("--target");
      if (!backupDir || !target) {
        console.error("usage: node scripts/pg-backup.mjs --restore <backupDir> --target <newDataDir>");
        process.exit(2);
      }
      const result = await restoreBackup(backupDir, target);
      console.log(`restored ${result.fileCount} files (${result.totalBytes} bytes, PG ${result.pgVersion}) into ${result.target}`);
      return;
    }
    const dataDir = args.find((a) => !a.startsWith("--") && a !== flag("--out"));
    const outRoot = flag("--out");
    if (!dataDir || !outRoot) {
      console.error("usage: node scripts/pg-backup.mjs <dataDir> --out <backupRoot>");
      console.error("       node scripts/pg-backup.mjs --restore <backupDir> --target <newDataDir>");
      process.exit(2);
    }
    const { dest, manifest } = await createBackup(dataDir, outRoot);
    console.log(`backup written to ${dest}`);
    console.log(`  PostgreSQL data version: ${manifest.pgVersion}`);
    console.log(`  files: ${manifest.fileCount}   bytes: ${manifest.totalBytes}`);
    if (manifest.tablespaces.length > 0) {
      console.log(`  WARNING: pg_tblspc entries present (${manifest.tablespaces.join(", ")}) — external tablespace locations are NOT copied.`);
    }
    console.log(`  verified per file: ${manifest.verified.perFileMatches}`);
  } catch (error) {
    console.error(`pg-backup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  await main();
}
