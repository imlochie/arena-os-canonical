import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { Rf64Recorder } from "@workspace/arena/lib/waveyard/capture/rf64";
import {
  clearRecoveredAudioCapture,
  createCaptureStorageBudget,
  estimateCaptureSecondsRemaining,
  getAudioCaptureOptions,
  getAudioCaptureImportResult,
  getAudioCaptureSessionDirectory,
  getAudioCaptureStatus,
  getRecoverableAudioCapture,
  listRecoverableAudioCaptures,
  shutdownAudioCaptures,
  startAudioCapture,
  stopAudioCapture,
  setAudioCaptureImportResult,
  runAudioCaptureImport,
} from "./audio-capture-manager";

const originalEnvironment = {
  ARENA_DESKTOP_MODE: process.env.ARENA_DESKTOP_MODE,
  ARENA_DATA_DIR: process.env.ARENA_DATA_DIR,
  ARENA_RESOURCES_DIR: process.env.ARENA_RESOURCES_DIR,
};
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await shutdownAudioCaptures();
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
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

test("capture budget preserves a disk reserve and estimates time from PCM rate", () => {
  const reserveBytes = createCaptureStorageBudget(0).reserveBytes;
  const format = { sampleRate: 48_000, channels: 2, bitsPerSample: 16, blockAlign: 4 };
  assert.equal(createCaptureStorageBudget(reserveBytes).canRecord, false);
  assert.equal(createCaptureStorageBudget(reserveBytes + 1).canRecord, true);
  assert.equal(
    estimateCaptureSecondsRemaining(reserveBytes + 90 * 48_000 * 4, reserveBytes, format),
    90,
  );
  assert.equal(estimateCaptureSecondsRemaining(reserveBytes, reserveBytes, format), 0);
});

test("process capture pins the selected identity and preserves audio when the source exits", {
  skip: originalPlatform?.value === "win32",
}, async () => {
  const root = await makeTemporaryRoot();
  const resources = path.join(root, "resources");
  const hostDirectory = path.join(resources, "native");
  await mkdir(hostDirectory, { recursive: true });
  process.env.ARENA_DATA_DIR = root;
  process.env.ARENA_RESOURCES_DIR = resources;
  process.env.ARENA_DESKTOP_MODE = "1";
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  const formatChunk = Buffer.alloc(16);
  formatChunk.writeUInt16LE(1, 0);
  formatChunk.writeUInt16LE(2, 2);
  formatChunk.writeUInt32LE(48000, 4);
  formatChunk.writeUInt32LE(192000, 8);
  formatChunk.writeUInt16LE(4, 12);
  formatChunk.writeUInt16LE(16, 14);
  const ready = JSON.stringify({
    type: "ready", mode: "process-loopback", processId: 42,
    formatChunkBase64: formatChunk.toString("base64"),
    sampleRate: 48000, channels: 2, bitsPerSample: 16, blockAlign: 4,
  });
  const hostPath = path.join(hostDirectory, "waveyard-capture-host.exe");
  await writeFile(hostPath, `#!/bin/sh
if [ "$1" = "devices" ]; then
printf '%s\\n' '{"devices":[],"processLoopbackSupported":true,"applications":[{"processId":42,"processStartTime":"123","name":"Tone.exe"}]}'
exit 0
fi
[ "$1" = "record" ] && [ "$2" = "--process-id" ] && [ "$3" = "42" ] && [ "$4" = "--process-start-time" ] && [ "$5" = "123" ] && [ "$#" = "5" ] || exit 7
printf '%s\\n' '${ready}' >&2
IFS= read -r command
[ "$command" = "start" ] || exit 4
printf '%s\\n' '{"type":"started"}' >&2
printf '\\001\\001\\001\\001'
sleep 0.1
printf '%s\\n' '{"type":"source-ended","message":"Application exited; save captured audio and refresh to record again."}' >&2
printf '%s\\n' '{"type":"stopped"}' >&2
`);
  await chmod(hostPath, 0o755);
  const options = await getAudioCaptureOptions("process-owner");
  assert.equal(options.available, true, "process capture is not bound to a physical endpoint");
  assert.deepEqual(options.applications, [{ processId: 42, processStartTime: "123", name: "Tone.exe" }]);
  await assert.rejects(startAudioCapture("process-owner", {
    title: "Bad", processId: 42, processStartTime: "123", deviceId: "speakers",
  }), /not both/);
  await assert.rejects(startAudioCapture("process-owner", {
    title: "Bad", processId: 42,
  }), /process identity/);
  const input = { title: "Application tone", processId: 42, processStartTime: "123" };
  const started = await startAudioCapture("process-owner", input);
  assert.equal(started.captureMode, "process-loopback");
  assert.equal(started.processId, 42);
  assert.equal(getAudioCaptureStatus("other-owner", started.sessionId), null);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getAudioCaptureStatus("process-owner", started.sessionId)?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const ended = getAudioCaptureStatus("process-owner", started.sessionId);
  assert.equal(ended?.status, "completed", "native source exit finalizes instead of recording silence forever");
  assert.match(ended?.message ?? "", /Application exited/);
  const saved = await stopAudioCapture("process-owner", started.sessionId);
  assert.ok(saved);
  assert.equal(saved.result.sampleFrames, 1);
  assert.deepEqual(saved.metadata, input);
  const manifest = JSON.parse(await readFile(path.join(saved.sessionDirectory, "session.json"), "utf8"));
  assert.equal(manifest.metadata.processStartTime, "123");
  assert.equal((await getRecoverableAudioCapture("process-owner", started.sessionId))?.title, input.title);
  clearRecoveredAudioCapture("process-owner", started.sessionId);
});

test("requesting process capture rejects a host that silently switches to whole output", {
  skip: originalPlatform?.value === "win32",
}, async () => {
  const root = await makeTemporaryRoot();
  const resources = path.join(root, "resources");
  const hostDirectory = path.join(resources, "native");
  await mkdir(hostDirectory, { recursive: true });
  process.env.ARENA_DATA_DIR = root;
  process.env.ARENA_RESOURCES_DIR = resources;
  process.env.ARENA_DESKTOP_MODE = "1";
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  const hostPath = path.join(hostDirectory, "waveyard-capture-host.exe");
  await writeFile(hostPath, `#!/bin/sh
printf '%s\\n' '{"type":"ready","mode":"system-loopback","formatChunkBase64":"AAAA"}' >&2
IFS= read -r command
printf '%s\\n' '{"type":"stopped"}' >&2
`);
  await chmod(hostPath, 0o755);
  await assert.rejects(startAudioCapture("no-fallback-owner", {
    title: "Must stay isolated", processId: 42, processStartTime: "123",
  }), /invalid audio-format handshake/);
});

test("low free space blocks Windows capture before creating a session", {
  skip: originalPlatform?.value === "win32",
}, async () => {
  const root = await makeTemporaryRoot();
  const resources = path.join(root, "resources");
  const hostDirectory = path.join(resources, "native");
  await mkdir(hostDirectory, { recursive: true });
  await writeFile(path.join(hostDirectory, "waveyard-capture-host.exe"), "test stub");
  process.env.ARENA_DATA_DIR = "/proc";
  process.env.ARENA_RESOURCES_DIR = resources;
  process.env.ARENA_DESKTOP_MODE = "1";
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });

  const options = await getAudioCaptureOptions("low-space-owner");
  assert.equal(options.available, false);
  assert.equal(options.storage?.availableBytes, 0);
  assert.equal(options.storage?.canRecord, false);
  assert.match(options.reason ?? "", /Free at least 1 GiB/);
  await assert.rejects(
    startAudioCapture("low-space-owner", { title: "Must not use the last space" }),
    /Free at least 1 GiB/,
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
  assert.equal(recovery.signal, undefined, "older interrupted files do not invent signal evidence");
  assert.match(recovery.path, /recording\.recovered\.wav$/);
  assert.equal((await stat(recovery.path)).size > 48, true);
  assert.equal((await readFile(recovery.path)).toString("ascii", 0, 4), "RF64");
  const options = await getAudioCaptureOptions(ownerId);
  assert.equal(options.available, false);
  assert.equal(options.recoveries?.length, 1);
});

test("API shutdown stops the host and leaves a recoverable recording", {
  skip: originalPlatform?.value === "win32",
}, async () => {
  const root = await makeTemporaryRoot();
  const resources = path.join(root, "resources");
  const hostDirectory = path.join(resources, "native");
  await mkdir(hostDirectory, { recursive: true });
  process.env.ARENA_DATA_DIR = root;
  process.env.ARENA_RESOURCES_DIR = resources;
  process.env.ARENA_DESKTOP_MODE = "1";
  Object.defineProperty(process, "platform", {
    ...originalPlatform,
    value: "win32",
  });

  const formatChunk = Buffer.alloc(16);
  formatChunk.writeUInt16LE(1, 0);
  formatChunk.writeUInt16LE(2, 2);
  formatChunk.writeUInt32LE(48_000, 4);
  formatChunk.writeUInt32LE(192_000, 8);
  formatChunk.writeUInt16LE(4, 12);
  formatChunk.writeUInt16LE(16, 14);
  const ready = JSON.stringify({
    type: "ready",
    mode: "system-loopback",
    formatChunkBase64: formatChunk.toString("base64"),
    sampleRate: 48_000,
    channels: 2,
    bitsPerSample: 16,
    blockAlign: 4,
  });
  const pcm = Array.from({ length: 48 }, () => "\\001").join("");
  const hostPath = path.join(hostDirectory, "waveyard-capture-host.exe");
  await writeFile(hostPath, `#!/bin/sh
printf '%s\\n' '${ready}' >&2
IFS= read -r command
[ "$command" = "start" ] || exit 4
printf '%s\\n' '{"type":"started"}' >&2
printf '${pcm}'
IFS= read -r command
[ "$command" = "stop" ] || exit 5
printf '%s\\n' '{"type":"stopped"}' >&2
`);
  await chmod(hostPath, 0o755);

  const ownerId = "shutdown-owner";
  const started = await startAudioCapture(ownerId, { title: "Shutdown recovery test" });
  assert.equal(started.status, "recording");
  const shutdown = await shutdownAudioCaptures();
  assert.deepEqual(shutdown, { stopped: 1, preserved: 1, forced: 0, unresponsive: 0 });

  const recoveries = await listRecoverableAudioCaptures(ownerId);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].sessionId, started.sessionId);
  assert.equal(recoveries[0].title, "Shutdown recovery test");
  assert.equal(recoveries[0].signal?.signalSeen, true, "signal evidence is read from the preserved manifest");
  const recovery = await getRecoverableAudioCapture(ownerId, started.sessionId);
  assert.ok(recovery);
  assert.equal((await readFile(recovery.path)).toString("ascii", 0, 4), "RF64");
  clearRecoveredAudioCapture(ownerId, started.sessionId);
  assert.equal((await getRecoverableAudioCapture(ownerId, started.sessionId))?.signal?.signalSeen, true,
    "recovery signal evidence survives release of the in-memory session");

  const second = await startAudioCapture(ownerId, { title: "Concurrent stop test" });
  const [firstStop, repeatedStop] = await Promise.all([
    stopAudioCapture(ownerId, second.sessionId),
    stopAudioCapture(ownerId, second.sessionId),
  ]);
  assert.ok(firstStop);
  assert.equal(repeatedStop, firstStop);
  assert.equal(firstStop.result.sampleFrames, 12);
  assert.equal(firstStop.signal?.signalSeen, true, "the host's PCM bytes reach the signal monitor");
  assert.equal(firstStop.signal?.capturedSeconds, 12 / 48_000);
  const importedResponse = { trackId: "deduplicated-result", created: true };
  const captureDirectory = firstStop.sessionDirectory;
  await assert.rejects(
    runAudioCaptureImport(ownerId, second.sessionId, async () => {
      throw new Error("simulated library database interruption");
    }),
    /database interruption/,
  );
  assert.equal(
    (await listRecoverableAudioCaptures(ownerId)).some((capture) => capture.sessionId === second.sessionId),
    true,
    "a failed import releases its guard so the completed recording can be recovered",
  );

  let importCalls = 0;
  let releaseImport!: () => void;
  let releaseCleanup!: () => void;
  let markImportStarted!: () => void;
  let markImportPersisted!: () => void;
  const importGate = new Promise<void>((resolve) => { releaseImport = resolve; });
  const importStarted = new Promise<void>((resolve) => { markImportStarted = resolve; });
  const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const importPersisted = new Promise<void>((resolve) => { markImportPersisted = resolve; });
  const importOperation = async () => {
    importCalls += 1;
    markImportStarted();
    await importGate;
    setAudioCaptureImportResult(ownerId, second.sessionId, importedResponse);
    markImportPersisted();
    await cleanupGate;
    return importedResponse;
  };
  const firstImport = runAudioCaptureImport(ownerId, second.sessionId, importOperation);
  const duplicateImport = runAudioCaptureImport(ownerId, second.sessionId, async () => {
    throw new Error("A duplicate request must join the in-flight import.");
  });
  assert.equal(firstImport, duplicateImport, "concurrent stop retries join one import");
  await importStarted;
  assert.equal(importCalls, 1);
  assert.equal(
    (await listRecoverableAudioCaptures(ownerId)).some((capture) => capture.sessionId === second.sessionId),
    false,
    "a completed file is not offered for recovery while the stop request imports it",
  );
  releaseImport();
  await importPersisted;
  assert.deepEqual(getAudioCaptureImportResult(ownerId, second.sessionId), importedResponse);
  assert.equal(
    (await listRecoverableAudioCaptures(ownerId)).some((capture) => capture.sessionId === second.sessionId),
    false,
    "a successfully imported file is not exposed for recovery while cleanup is still running",
  );
  releaseCleanup();
  assert.deepEqual(await Promise.all([firstImport, duplicateImport]), [importedResponse, importedResponse]);
  assert.deepEqual(getAudioCaptureImportResult(ownerId, second.sessionId), importedResponse);
  assert.equal(getAudioCaptureSessionDirectory(ownerId, second.sessionId), captureDirectory);
  assert.equal(getAudioCaptureStatus(ownerId, second.sessionId)?.status, "completed");
  assert.equal(await stopAudioCapture(ownerId, second.sessionId), null, "the full child/session state is released after import");
  assert.deepEqual(await shutdownAudioCaptures(), { stopped: 0, preserved: 0, forced: 0, unresponsive: 0 });
  clearRecoveredAudioCapture(ownerId, second.sessionId);
  assert.equal(getAudioCaptureImportResult(ownerId, second.sessionId), null, "recovery cleanup also releases its small retry cache entry");

  const lowSpace = await startAudioCapture(ownerId, { title: "Low-space safety stop test" });
  process.env.ARENA_DATA_DIR = "/proc";
  const deadline = Date.now() + 10_000;
  let lowSpaceStatus = getAudioCaptureStatus(ownerId, lowSpace.sessionId);
  while (lowSpaceStatus?.status !== "completed" && lowSpaceStatus?.status !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    lowSpaceStatus = getAudioCaptureStatus(ownerId, lowSpace.sessionId);
  }
  assert.equal(lowSpaceStatus?.status, "completed", JSON.stringify(lowSpaceStatus));
  assert.match(lowSpaceStatus?.message ?? "", /1 GiB safety reserve/);
  process.env.ARENA_DATA_DIR = root;
  const lowSpaceRecovery = await getRecoverableAudioCapture(ownerId, lowSpace.sessionId);
  assert.ok(lowSpaceRecovery);
  clearRecoveredAudioCapture(ownerId, lowSpace.sessionId);
});
