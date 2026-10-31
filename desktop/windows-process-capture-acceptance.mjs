// Real Windows acceptance, not a fake host. Two independent authorized tone
// players must be audible in the positive control before isolation can pass.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeToneWave, parseFormat, measureTone, createEventReader } from "./windows-capture-acceptance.mjs";

const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const hostPath = path.resolve(process.argv[2] || path.join(here, "stage/native/waveyard-capture-host.exe"));
const reportPath = path.resolve("generated-artifacts/windows-process-capture/result.json");

async function player(file) {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $p=New-Object System.Media.SoundPlayer; $p.SoundLocation=$env:WAVEYARD_TEST_TONE; $p.Load(); $p.PlayLooping(); [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine() | Out-Null; $p.Stop()"],
  { windowsHide: true, env: { ...process.env, WAVEYARD_TEST_TONE: file }, stdio: ["pipe", "pipe", "pipe"] });
  child.closed = new Promise((resolve) => child.once("close", resolve));
  const timer = setTimeout(() => child.kill(), 30_000);
  child.once("close", () => clearTimeout(timer));
  try {
    let text = "";
    let errorText = "";
    child.stderr.on("data", (data) => { errorText += data; });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`Tone player exited before ready: ${errorText}`)));
      child.stdout.on("data", (data) => {
        text += data;
        if (text.includes("ready")) resolve();
      });
    });
    return child;
  } catch (error) {
    child.kill();
    await child.closed;
    throw error;
  }
}

async function capture(args, duringCapture) {
  const host = spawn(hostPath, ["record", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const events = createEventReader(host);
  const close = once(host, "close");
  const chunks = [];
  let bytes = 0;
  host.stdout.on("data", (data) => {
    bytes += data.length;
    if (bytes > 16 * 1024 * 1024) {
      events.fail(new Error("Capture exceeded the bounded test buffer."));
      host.kill();
    } else chunks.push(data);
  });
  host.once("error", events.fail);
  const timeout = setTimeout(() => host.kill(), 15_000);
  try {
    const ready = await events.waitFor("ready");
    const format = parseFormat(ready, args.length ? "process-loopback" : "system-loopback");
    host.stdin.write("start\n");
    await events.waitFor("started");
    await sleep(2500);
    if (duringCapture) {
      await duringCapture();
      await events.waitFor("source-ended");
    } else host.stdin.write("stop\n");
    await events.waitFor("stopped");
    assert.equal((await close)[0], 0, "native host must flush and exit cleanly");
    const pcm = Buffer.concat(chunks);
    return { format, target: measureTone(pcm, format, 440), unrelated: measureTone(pcm, format, 997) };
  } finally {
    clearTimeout(timeout);
    if (host.exitCode === null) host.kill();
    await close.catch(() => {});
  }
}

async function main() {
  assert.equal(process.platform, "win32", "Requires a real Windows audio runner");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "waveyard-process-isolation-"));
  const players = [];
  try {
    for (const frequency of [440, 997]) {
      const file = path.join(scratch, `${frequency}.wav`);
      await writeFile(file, makeToneWave(frequency));
      players.push(await player(file));
    }
    const options = JSON.parse((await execute(hostPath, ["devices"], { timeout: 10_000 })).stdout);
    assert.equal(options.processLoopbackSupported, true, options.processLoopbackReason);
    assert.ok(options.devices.length, "Positive system-loopback control requires an active output endpoint");
    const app = options.applications.find((app) => app.processId === players[0].pid);
    assert.ok(app, "Selected tone player must be discoverable without a whitelist");
    const args = ["--process-id", String(app.processId), "--process-start-time", app.processStartTime];
    // Reject a stale identity; never fall back to recording all apps.
    await assert.rejects(execute(hostPath, ["record", "--process-id", String(app.processId),
      "--process-start-time", "0"], { timeout: 5000 }), /selected application exited or restarted/,
      "A timeout or unrelated failure is not evidence of stale-identity rejection");
    const control = await capture([]);
    assert.ok(control.target.toneAmplitude > 0.01 && control.unrelated.toneAmplitude > 0.01,
      "Both generated tones must be captured in the positive control; silence is not isolation");
    const isolated = await capture(args);
    assert.ok(isolated.target.toneAmplitude > 0.01, "Selected application tone must remain audible");
    assert.ok(isolated.unrelated.toneAmplitude < isolated.target.toneAmplitude / 30,
      "Unrelated application tone must be excluded by at least 29.5 dB");
    const exited = await capture(args, async () => {
      players[0].stdin.end("\n");
      await players[0].closed;
    });
    assert.ok(exited.target.toneAmplitude > 0.01, "Audio before source exit must remain available");
    await assert.rejects(execute(hostPath, ["record", ...args], { timeout: 5000 }),
      /selected application exited or restarted/,
      "An exited source must not silently switch to a new process or whole output");
    return { status: "passed", test: "native process-tree loopback isolation", control, isolated, exited,
      evidence: "Two independent generated tone players; not Apple Music compatibility or source-bit-perfect proof" };
  } finally {
    for (const child of players) {
      if (child.exitCode === null) child.kill();
      await child.closed;
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

let report;
try { report = await main(); }
catch (error) {
  report = { status: "failed", message: error instanceof Error ? error.message : String(error) };
  process.exitCode = 1;
}
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
