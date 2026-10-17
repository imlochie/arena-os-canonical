/**
 * pg-backup tests — the recovery tool the PG incident needed: a verified,
 * timestamped filesystem backup (per-file hashes), a tested restore into a
 * separate directory, and hard refusals for live or unrecognised clusters.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { test } from "node:test";

import { createBackup, hashTree, postmasterAlive, readDataDirVersion, restoreBackup, verifyBackup } from "../scripts/pg-backup.mjs";

async function fakeCluster(): Promise<{ root: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "arena-pg-backup-"));
  const dataDir = join(root, "postgres");
  await mkdir(join(dataDir, "base", "1"), { recursive: true });
  await writeFile(join(dataDir, "PG_VERSION"), "16\n");
  await writeFile(join(dataDir, "base", "1", "16384"), "user data page");
  await writeFile(join(dataDir, "postgresql.conf"), "port = 5432\n");
  await symlink("base", join(dataDir, "pg_tblspc_link_probe"));
  return { root, dataDir };
}

test("refuses a directory that is not a PostgreSQL cluster", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-pg-backup-"));
  try {
    await assert.rejects(() => createBackup(join(root, "nothing"), root), /no readable PG_VERSION/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses while the postmaster is alive; allows a stale pid file", async () => {
  const { root, dataDir } = await fakeCluster();
  try {
    await writeFile(join(dataDir, "postmaster.pid"), "4242\n");
    assert.equal(postmasterAlive(dataDir, () => true), true);
    assert.equal(postmasterAlive(dataDir, () => false), false);
    await assert.rejects(
      () => createBackup(dataDir, join(root, "backups"), { processExists: () => true }),
      /Stop Arena\/PostgreSQL first/,
    );
    const { manifest } = await createBackup(dataDir, join(root, "backups"), { processExists: () => false });
    assert.equal(manifest.pgVersion, "16");
    assert.equal(manifest.verified.perFileMatches, true);
    assert.equal(readDataDirVersion(dataDir), "16");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every file and symlink is hashed; a same-size tamper is caught", async () => {
  const { root, dataDir } = await fakeCluster();
  try {
    const { dest, manifest } = await createBackup(dataDir, join(root, "backups"), { now: () => new Date("2026-10-16T12:00:00Z") });
    assert.equal(path.basename(dest), "postgres-2026-10-16T12-00-00-000Z");

    // Per-file hashes exist and classify kinds correctly.
    const page = manifest.files["base/1/16384"];
    assert.equal(page.kind, "file");
    assert.equal(typeof page.sha256, "string");
    assert.equal(manifest.files["pg_tblspc_link_probe"].kind, "symlink");
    assert.equal(manifest.files["pg_tblspc_link_probe"].target, "base");

    const recheck = await verifyBackup(dest);
    assert.equal(recheck.ok, true);

    // Same byte count, different content — totals cannot see this, hashes do.
    await writeFile(join(dest, "base", "1", "16384"), "user data PAGES");
    const tampered = await verifyBackup(dest);
    assert.equal(tampered.ok, false);
    assert.ok(tampered.mismatches.some((m) => m.includes("base/1/16384")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore re-creates the cluster in a separate directory and verifies the round-trip", async () => {
  const { root, dataDir } = await fakeCluster();
  try {
    const { dest, manifest } = await createBackup(dataDir, join(root, "backups"));
    const target = join(root, "restored");
    const result = await restoreBackup(dest, target);
    assert.equal(result.fileCount, manifest.fileCount);
    assert.equal(result.pgVersion, "16");
    assert.equal(await readFile(join(target, "PG_VERSION"), "utf8"), "16\n");
    assert.equal(await readFile(join(target, "base", "1", "16384"), "utf8"), "user data page");

    // The restored tree hashes identically to the source.
    const sourceHashes = await hashTree(dataDir);
    const targetHashes = await hashTree(target);
    assert.deepEqual(targetHashes.entries, sourceHashes.entries);

    // Refuses to restore over a non-empty directory.
    await assert.rejects(() => restoreBackup(dest, target), /non-empty directory/);
    // Refuses to restore from a tampered backup.
    await writeFile(join(dest, "postgresql.conf"), "port = 5433\n");
    await assert.rejects(() => restoreBackup(dest, join(root, "restored2")), /does not verify/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
