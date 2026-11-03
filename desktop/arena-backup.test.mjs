import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createArenaBackup, postmasterState, restoreArenaBackup, verifyArenaBackup } from "./arena-backup.mjs";

const passphrase = "correct horse battery staple";

async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), "arena-data-backup-"));
  const root = path.join(parent, "source");
  await mkdir(path.join(root, "data/postgres/base/1"), { recursive: true });
  await mkdir(path.join(root, "runtime"), { recursive: true });
  await writeFile(path.join(root, "data/postgres/PG_VERSION"), "16\n");
  await writeFile(path.join(root, "data/postgres/base/1/record"), "preserved arena record");
  await writeFile(path.join(root, "runtime/db-password.json"), JSON.stringify({ password: "matching-database-password-123" }));
  return { parent, root };
}

test("process state fails closed for malformed or uncheckable PostgreSQL pid", async () => {
  const { parent, root } = await fixture();
  const dataDir = path.join(root, "data/postgres");
  try {
    await writeFile(path.join(dataDir, "postmaster.pid"), "not-a-pid\n");
    assert.throws(() => postmasterState(dataDir), /uncertain/);
    await writeFile(path.join(dataDir, "postmaster.pid"), "4242\n");
    assert.throws(() => postmasterState(dataDir, () => { throw new Error("probe failed"); }), /Could not determine/);
    assert.equal(postmasterState(dataDir, () => false), "stopped");
    assert.equal(postmasterState(dataDir, () => true), "running");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("backup requires confirmed shutdown, encrypts the credential, verifies every file, and restores to a new root", async () => {
  const { parent, root } = await fixture();
  try {
    await mkdir(path.join(root, "waveyard/storage"), { recursive: true });
    await writeFile(path.join(root, "waveyard/storage/private-original.wav"), "must stay out of database-only backups");
    await assert.rejects(
      createArenaBackup({ root, parentDir: parent, passphrase }),
      /not confirmed a clean database shutdown/,
    );
    const { backupDir, manifest } = await createArenaBackup({
      root,
      parentDir: parent,
      passphrase,
      databaseStopped: true,
      now: () => new Date("2026-10-31T12:00:00.000Z"),
    });
    assert.equal(manifest.pgVersion, "16");
    assert.equal(manifest.includesWaveyardFiles, false);
    assert.match(manifest.scope, /Waveyard files.*browser profiles.*excluded/);
    assert.equal(Object.keys(manifest.files).some((relative) => relative.startsWith("waveyard/")), false);
    assert.equal(await readFile(path.join(backupDir, "credential.enc"), "utf8").then(text => text.includes("matching-database-password")), false);
    assert.deepEqual((await verifyArenaBackup(backupDir)).mismatches, []);

    const restoredRoot = path.join(parent, "restored");
    await assert.rejects(
      restoreArenaBackup({ backupDir, targetRoot: restoredRoot, passphrase: "a different passphrase" }),
      /incorrect|damaged/,
    );
    const restored = await restoreArenaBackup({ backupDir, targetRoot: restoredRoot, passphrase });
    assert.equal(restored.pgVersion, "16");
    assert.equal(await readFile(path.join(restoredRoot, "data/postgres/base/1/record"), "utf8"), "preserved arena record");
    assert.deepEqual(
      JSON.parse(await readFile(path.join(restoredRoot, "runtime/db-password.json"), "utf8")),
      { password: "matching-database-password-123" },
    );
    await assert.rejects(
      readFile(path.join(restoredRoot, "waveyard/storage/private-original.wav")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      restoreArenaBackup({ backupDir, targetRoot: restoredRoot, passphrase }),
      /new, empty/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("optional Waveyard storage and captures are verified and restored without model caches", async () => {
  const { parent, root } = await fixture();
  const audio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x20, 0x30, 0x40]);
  const capture = Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xff]);
  try {
    await mkdir(path.join(root, "waveyard/storage/library"), { recursive: true });
    await mkdir(path.join(root, "waveyard/capture/session"), { recursive: true });
    await mkdir(path.join(root, "waveyard/models"), { recursive: true });
    await writeFile(path.join(root, "waveyard/storage/library/track.wav"), audio);
    await writeFile(path.join(root, "waveyard/capture/session/take.pcm"), capture);
    await writeFile(path.join(root, "waveyard/models/large-model.bin"), "not part of a user-media backup");

    const { backupDir, manifest } = await createArenaBackup({
      root,
      parentDir: parent,
      passphrase,
      databaseStopped: true,
      includeWaveyardFiles: true,
      now: () => new Date("2026-11-01T12:00:00.000Z"),
    });
    assert.equal(manifest.includesWaveyardFiles, true);
    assert.match(manifest.scope, /storage\/capture files.*not encrypted/);
    assert.deepEqual((await verifyArenaBackup(backupDir)).mismatches, []);

    const restoredRoot = path.join(parent, "waveyard-restored");
    const restored = await restoreArenaBackup({ backupDir, targetRoot: restoredRoot, passphrase });
    assert.equal(restored.waveyardFileCount, 2);
    assert.equal(restored.waveyardBytes, audio.byteLength + capture.byteLength);
    assert.deepEqual(await readFile(path.join(restoredRoot, "waveyard/storage/library/track.wav")), audio);
    assert.deepEqual(await readFile(path.join(restoredRoot, "waveyard/capture/session/take.pcm")), capture);
    await assert.rejects(readFile(path.join(restoredRoot, "waveyard/models/large-model.bin")), { code: "ENOENT" });

    await writeFile(path.join(backupDir, "waveyard/storage/library/track.wav"), "tampered");
    assert.equal((await verifyArenaBackup(backupDir)).ok, false);
    await assert.rejects(
      restoreArenaBackup({ backupDir, targetRoot: path.join(parent, "tampered-restore"), passphrase }),
      /Backup verification failed/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("backup rejects a running cluster and detects changed or extra files", async () => {
  const { parent, root } = await fixture();
  try {
    const dataDir = path.join(root, "data/postgres");
    await writeFile(path.join(dataDir, "postmaster.pid"), "4242\n");
    await assert.rejects(
      createArenaBackup({ root, parentDir: parent, passphrase, databaseStopped: true, processExists: () => true }),
      /still running/,
    );
    await writeFile(path.join(dataDir, "postmaster.pid"), "uncertain\n");
    await assert.rejects(
      createArenaBackup({ root, parentDir: parent, passphrase, databaseStopped: true }),
      /uncertain/,
    );
    await rm(path.join(dataDir, "postmaster.pid"));
    const { backupDir } = await createArenaBackup({
      root,
      parentDir: parent,
      passphrase,
      databaseStopped: true,
    });
    await writeFile(path.join(backupDir, "database/base/1/record"), "tampered record");
    assert.equal((await verifyArenaBackup(backupDir)).ok, false);
    await writeFile(path.join(backupDir, "unexpected.txt"), "extra");
    await assert.rejects(
      restoreArenaBackup({ backupDir, targetRoot: path.join(parent, "restore"), passphrase }),
      /Backup verification failed/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
