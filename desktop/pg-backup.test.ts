/**
 * pg-backup tests — the recovery tool the PG incident needed: a verified,
 * timestamped filesystem backup that refuses to copy a live or unrecognised
 * cluster and never touches the source.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { test } from "node:test";

import { createBackup, postmasterAlive, readDataDirVersion, verifyBackup } from "../scripts/pg-backup.mjs";

async function fakeCluster(): Promise<{ root: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "arena-pg-backup-"));
  const dataDir = join(root, "postgres");
  await mkdir(join(dataDir, "base", "1"), { recursive: true });
  await writeFile(join(dataDir, "PG_VERSION"), "16\n");
  await writeFile(join(dataDir, "base", "1", "16384"), "user data page");
  await writeFile(join(dataDir, "postgresql.conf"), "port = 5432\n");
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
    // Stale pid (process gone): backup proceeds and the source is untouched.
    const { manifest } = await createBackup(dataDir, join(root, "backups"), { processExists: () => false });
    assert.equal(manifest.pgVersion, "16");
    assert.equal(manifest.fileCount, 4); // PG_VERSION, postgresql.conf, postmaster.pid, base/1/16384
    assert.equal(manifest.verified.fileCountMatches, true);
    assert.equal(manifest.verified.totalBytesMatches, true);
    assert.equal(manifest.verified.pgVersionMatches, true);
    assert.equal(readDataDirVersion(dataDir), "16");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the copy is verified against the source and re-verifiable later", async () => {
  const { root, dataDir } = await fakeCluster();
  try {
    const { dest, manifest } = await createBackup(dataDir, join(root, "backups"), { now: () => new Date("2026-10-16T12:00:00Z") });
    assert.equal(path.basename(dest), "postgres-2026-10-16T12-00-00-000Z");
    const recheck = await verifyBackup(dest);
    assert.equal(recheck.ok, true);
    assert.equal(recheck.measured.fileCount, manifest.fileCount);

    // The manifest is durable evidence: version + size recorded.
    const onDisk = JSON.parse(await readFile(join(dest, "backup-manifest.json"), "utf8"));
    assert.equal(onDisk.pgVersion, "16");
    assert.equal(typeof onDisk.totalBytes, "number");
    assert.ok(onDisk.totalBytes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tampered/incomplete backup fails re-verification", async () => {
  const { root, dataDir } = await fakeCluster();
  try {
    const { dest } = await createBackup(dataDir, join(root, "backups"));
    await rm(join(dest, "base", "1", "16384"));
    const recheck = await verifyBackup(dest);
    assert.equal(recheck.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
