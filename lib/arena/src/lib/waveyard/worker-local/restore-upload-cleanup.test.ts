import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupAbandonedAudioRestoreUploadDirectories,
} from "./recovery";
import {
  AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX,
  AUDIO_RESTORE_UPLOAD_RETENTION_MS,
} from "../library/audio-restore";

test("restore upload cleanup removes only old Waveyard restore directories", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "waveyard-restore-cleanup-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const oldTimestamp = new Date(now - AUDIO_RESTORE_UPLOAD_RETENTION_MS - 1_000);
  const expiredUpload = `${AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX}987654321-expired`;
  const recentUpload = `${AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX}987654321-recent`;
  const unrelatedTemp = "other-audio-restore-data";
  const nonDirectoryEntry = `${AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX}987654321-file`;

  for (const name of [expiredUpload, recentUpload, unrelatedTemp]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "payload.zip"), name);
  }
  await writeFile(join(root, nonDirectoryEntry), "must not be touched");
  await utimes(join(root, expiredUpload), oldTimestamp, oldTimestamp);

  const removed = await cleanupAbandonedAudioRestoreUploadDirectories(root, now, () => false);

  assert.deepEqual(removed, [expiredUpload]);
  await assert.rejects(() => readFile(join(root, expiredUpload, "payload.zip")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, recentUpload, "payload.zip"), "utf8"), recentUpload);
  assert.equal(await readFile(join(root, unrelatedTemp, "payload.zip"), "utf8"), unrelatedTemp);
  assert.equal(await readFile(join(root, nonDirectoryEntry), "utf8"), "must not be touched");
});

test("restore upload cleanup preserves an old directory owned by a live API process", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "waveyard-restore-active-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const activeUpload = `${AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX}12345-active`;
  await mkdir(join(root, activeUpload));
  await writeFile(join(root, activeUpload, "payload.zip"), "active restore");
  const oldTimestamp = new Date(now - AUDIO_RESTORE_UPLOAD_RETENTION_MS - 1_000);
  await utimes(join(root, activeUpload), oldTimestamp, oldTimestamp);

  const checkedPids: number[] = [];
  const removed = await cleanupAbandonedAudioRestoreUploadDirectories(root, now, (pid) => {
    checkedPids.push(pid);
    return pid === 12345;
  });

  assert.deepEqual(removed, []);
  assert.deepEqual(checkedPids, [12345]);
  assert.equal(await readFile(join(root, activeUpload, "payload.zip"), "utf8"), "active restore");
});
