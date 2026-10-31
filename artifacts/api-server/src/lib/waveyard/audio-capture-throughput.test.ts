/**
 * Functional acceptance of the actual manager pipe/RF64/control wiring using a
 * synthetic subprocess. Not a WASAPI test, performance benchmark, or Windows claim.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { createRf64Header } from "@workspace/arena/lib/waveyard/capture/rf64";
import {
  clearRecoveredAudioCapture, getAudioCaptureStatus, shutdownAudioCaptures,
  startAudioCapture, stopAudioCapture,
} from "./audio-capture-manager";

test("status and stop requests complete while high-resolution PCM streams through the manager", {
  skip: process.platform === "win32", timeout: 20_000,
}, async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const previous = { ARENA_DATA_DIR: process.env.ARENA_DATA_DIR,
    ARENA_RESOURCES_DIR: process.env.ARENA_RESOURCES_DIR, ARENA_DESKTOP_MODE: process.env.ARENA_DESKTOP_MODE };
  const root = await mkdtemp(path.join(os.tmpdir(), "capture-controls-"));
  const directory = path.join(root, "resources", "native");
  await mkdir(directory, { recursive: true });
  const waveFormat = Buffer.alloc(16);
  waveFormat.writeUInt16LE(3, 0);
  waveFormat.writeUInt16LE(8, 2);
  waveFormat.writeUInt32LE(192000, 4);
  waveFormat.writeUInt32LE(192000 * 64, 8);
  waveFormat.writeUInt16LE(64, 12);
  waveFormat.writeUInt16LE(64, 14);
  const pool = Buffer.alloc(65536);
  for (let offset = 0; offset < pool.length; offset += 8) pool.writeDoubleLE(offset % 24 ? 0.25 : 1.2, offset);
  const poolFile = path.join(root, "pcm");
  const countFile = path.join(root, "count");
  await writeFile(poolFile, pool);
  const host = path.join(directory, "waveyard-capture-host.exe");
  await writeFile(host, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const pool = fs.readFileSync(${JSON.stringify(poolFile)});
const input = readline.createInterface({input:process.stdin});
let running = false, stopped = false, bytes = 0, seed = 123;
const event = value => process.stderr.write(JSON.stringify(value) + "\\n");
event({type:"ready",mode:"system-loopback",formatChunkBase64:${JSON.stringify(waveFormat.toString("base64"))},sampleRate:192000,channels:8,bitsPerSample:64,blockAlign:64});
const push = async chunk => new Promise((resolve,reject) => process.stdout.write(chunk, error => error ? reject(error) : resolve()));
async function produce() {
  event({type:"started"});
  // Upper bound protects the test disk even if control handling regresses.
  while (!stopped && bytes < 32 * 1024 * 1024) {
    seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
    const offset = bytes % pool.length;
    const length = Math.min(1+seed%65536,pool.length-offset);
    await push(pool.subarray(offset,offset+length)); bytes += length;
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  while (!stopped) await new Promise(resolve=>setTimeout(resolve,1));
  const padding = (64-bytes%64)%64;
  if(padding) { const offset=bytes%pool.length; await push(pool.subarray(offset,offset+padding)); bytes+=padding; }
  fs.writeFileSync(${JSON.stringify(countFile)}, String(bytes));
  event({type:"stopped"}); input.close(); process.stdin.destroy();
}
input.on("line", line => {
  if(line==="start" && !running) { running=true; produce().catch(error=>{event({type:"error",message:error.message});process.exit(4);}); }
  if(line==="stop") stopped=true;
});
`);
  await chmod(host, 0o755);
  let id: string | undefined;
  let saved: Awaited<ReturnType<typeof stopAudioCapture>>;
  const server = createServer((request, response) => {
    if (request.url === "/stop" && id) {
      void stopAudioCapture("throughput-owner", id).then((value) => {
        saved = value;
        response.end(JSON.stringify({ frames: value?.result.sampleFrames }));
      }, (error) => { response.statusCode = 500; response.end(String(error)); });
    } else response.end(JSON.stringify(id ? getAudioCaptureStatus("throughput-owner", id) : null));
  });
  try {
    process.env.ARENA_DATA_DIR = root;
    process.env.ARENA_RESOURCES_DIR = path.join(root, "resources");
    process.env.ARENA_DESKTOP_MODE = "1";
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    id = (await startAudioCapture("throughput-owner", { title: "192 kHz eight-channel float control test" })).sessionId;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const latencies: number[] = [];
    let received = 0;
    for (let request = 0; request < 30; request++) {
      const start = performance.now();
      const response = await fetch(`${base}/status`);
      const status = await response.json() as { status: string; signal?: { capturedSeconds: number } };
      latencies.push(performance.now() - start);
      assert.equal(response.status, 200);
      assert.equal(status.status, "recording");
      received = status.signal?.capturedSeconds ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(received > 0, "controls were exercised during actual PCM intake");
    assert.ok(Math.max(...latencies) < 1000, "a status request stalled for over one second");
    const stopStarted = performance.now();
    const stopped = await fetch(`${base}/stop`, { method: "POST" });
    await stopped.json();
    assert.equal(stopped.status, 200);
    assert.ok(performance.now() - stopStarted < 3000, "stop was starved by incoming PCM");
    assert.ok(saved!);
    const count = Number(await readFile(countFile, "utf8"));
    assert.equal(saved!.result.dataBytes, count, "stop drains every accepted PCM byte");
    assert.ok(count >= 65536);
    assert.equal(saved!.result.discardedTailBytes, 0);
    assert.equal(saved!.signal?.capturedSeconds, count / (192000 * 64));
    assert.ok(saved!.signal!.clippedSamples > 0);
    const expected = createHash("sha256");
    for (let bytes = 0; bytes < count; bytes += pool.length) expected.update(pool.subarray(0, Math.min(pool.length, count - bytes)));
    const actual = createHash("sha256");
    for await (const chunk of createReadStream(saved!.path, {
      start: createRf64Header({ formatChunk: waveFormat }).dataOffset,
    })) actual.update(chunk);
    assert.equal(actual.digest("hex"), expected.digest("hex"), "recorded PCM is byte-identical through the real manager");
    assert.equal(getAudioCaptureStatus("other-owner", id), null);
  } finally {
    await shutdownAudioCaptures();
    if (id) clearRecoveredAudioCapture("throughput-owner", id);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    Object.defineProperty(process, "platform", platform);
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
