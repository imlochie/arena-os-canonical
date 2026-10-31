import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { Rf64Recorder } from "@workspace/arena/lib/waveyard/capture/rf64";
import {
  getAudioCaptureOptions,
  getRecoverableAudioCapture,
  listRecoverableAudioCaptures,
  startAudioCapture,
} from "./audio-capture-manager";

const originalEnvironment = {
  ARENA_DESKTOP_MODE: process.env.ARENA_DESKTOP_MODE,
  ARENA_DATA_DIR: process.env.ARENA_DATA_DIR,
  ARENA_RESOURCES_DIR: process.env.ARENA_RESOURCES_DIR,
};
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "waveyard-capture-manager-"));
  temporaryRoots.push(root);
  return root;
}

test("non-Windows preview reports capture unavailable and refuses to start", async () => {
  const root = await makeTemporaryRoot();
  process.env.ARENA_DATA_DIR = root;
  process.env.ARENA_DESKTOP_MODE = "1";
  process.env.ARENA_RESOURCES_DIR = root;

  const options = await getAudioCaptureOptions("test-owner");
  assert.equal(options.available, false);
  assert.deepEqual(options.devices, []);
  assert.match(options.reason ?? "", /packaged Windows desktop app/);
  await assert.rejects(
    startAudioCapture("test-owner", { title: "Must not start" }),
    /not available in this runtime/,
  );
});

test("an interrupted RF64 recording is recovered only for its owning user", async () => {
  const root = await makeTemporaryRoot();
  process.env.ARENA_DATA_DIR = root;
  const id = randomUUID();
  const ownerId = "capture-owner";
  const sessionDirectory = path.join(root, "waveyard", "capture", id);
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(path.join(sessionDirectory, "session.json"), `${JSON.stringify({
    sessionId: id,
    ownerId,
    metadata: { title: "Recovered test", artist: "Local artist", album: "Loopback checks" },
    createdAt: "2026-10-31T00:00:00.000Z",
  })}\n`);

  const formatChunk = Buffer.alloc(16);
  formatChunk.writeUInt16LE(1, 0);
  formatChunk.writeUInt16LE(2, 2);
  formatChunk.writeUInt32LE(48_000, 4);
  formatChunk.writeUInt32LE(192_000, 8);
  formatChunk.writeUInt16LE(4, 12);
  formatChunk.writeUInt16LE(16, 14);
  const partialPath = path.join(sessionDirectory, "recording.partial.wav");
  const recorder = await Rf64Recorder.create({
    partialPath,
    finalPath: path.join(sessionDirectory, "recording.wav"),
    format: { formatChunk },
  });
  await recorder.writePcm(Buffer.alloc(48, 0x37));
  await recorder.leaveRecoverable();

  const recoveries = await listRecoverableAudioCaptures(ownerId);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].sessionId, id);
  assert.equal(recoveries[0].title, "Recovered test");
  assert.equal(recoveries[0].artist, "Local artist");
  assert.equal((await listRecoverableAudioCaptures("other-owner")).length, 0);

  const recovery = await getRecoverableAudioCapture(ownerId, id);
  assert.ok(recovery);
  assert.match(recovery.path, /recording\.recovered\.wav$/);
  assert.equal((await stat(recovery.path)).size > 48, true);
  assert.equal((await readFile(recovery.path)).toString("ascii", 0, 4), "RF64");

  const options = await getAudioCaptureOptions(ownerId);
  assert.equal(options.available, false);
  assert.equal(options.recoveries?.length, 1);
});
