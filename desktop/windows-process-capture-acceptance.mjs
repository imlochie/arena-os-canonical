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
const suppliedHostPath = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const hostPath = path.resolve(suppliedHostPath || path.join(here, "stage/native/waveyard-capture-host.exe"));
const reportPath = path.resolve("generated-artifacts/windows-process-capture/result.json");
const lifecycleHelperPath = path.join(here, "windows-audio-lifecycle.ps1");
const lifecycleRequested = process.argv.includes("--lifecycle");
const recoveryDirectory = path.resolve("generated-artifacts/windows-process-capture/recovery");
let runnerEvidence;
let lifecycleEvidence;

async function runnerMetadata() {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$os=Get-CimInstance Win32_OperatingSystem",
    "$kits=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots' -ErrorAction SilentlyContinue",
    "$sdkRoot=$kits.KitsRoot10",
    "$sdkVersions=@()",
    "if($sdkRoot -and (Test-Path (Join-Path $sdkRoot 'Include'))){$sdkVersions=@(Get-ChildItem (Join-Path $sdkRoot 'Include') -Directory | Where-Object {$_.Name -match '^10\\.'} | Select-Object -ExpandProperty Name | Sort-Object)}",
    "$activeSdk=([string]$env:WindowsSDKVersion).TrimEnd([char]92)",
    "[ordered]@{os=$os.Caption;version=$os.Version;build=$os.BuildNumber;windowsSdkRoot=$sdkRoot;windowsSdkVersions=$sdkVersions;windowsSdkVersion=$activeSdk;msvcToolsVersion=$env:VCToolsVersion} | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execute("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script,
  ], { timeout: 15_000, windowsHide: true });
  const metadata = JSON.parse(stdout);
  assert.ok(metadata.os && metadata.build, "Runner OS version and build must be recorded");
  assert.ok(metadata.windowsSdkVersions?.length, "Installed Windows SDK versions must be recorded");
  assert.ok(metadata.windowsSdkVersion && metadata.windowsSdkVersions.includes(metadata.windowsSdkVersion),
    "The active Windows SDK selected by MSVC must be recorded and installed");
  return metadata;
}

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

function bufferPcm(chunks, totalBytes, format) {
  const pcm = Buffer.concat(chunks, totalBytes);
  const alignedLength = pcm.length - (pcm.length % format.blockAlign);
  return pcm.subarray(0, alignedLength);
}

function rf64File(formatChunk, pcm, blockAlign) {
  const padBytes = formatChunk.length % 2;
  const pcmPadBytes = pcm.length % 2;
  const fileBytes = 64 + formatChunk.length + padBytes + pcm.length + pcmPadBytes;
  const header = Buffer.alloc(64 + formatChunk.length + padBytes);
  header.write("RF64", 0, "ascii");
  header.writeUInt32LE(0xffffffff, 4);
  header.write("WAVE", 8, "ascii");
  header.write("ds64", 12, "ascii");
  header.writeUInt32LE(28, 16);
  header.writeBigUInt64LE(BigInt(fileBytes - 8), 20);
  header.writeBigUInt64LE(BigInt(pcm.length), 28);
  header.writeBigUInt64LE(BigInt(Math.floor(pcm.length / blockAlign)), 36);
  header.writeUInt32LE(0, 44);
  header.write("fmt ", 48, "ascii");
  header.writeUInt32LE(formatChunk.length, 52);
  formatChunk.copy(header, 56);
  const dataOffset = 56 + formatChunk.length + padBytes;
  header.write("data", dataOffset, "ascii");
  header.writeUInt32LE(0xffffffff, dataOffset + 4);
  return Buffer.concat([header, pcm, Buffer.alloc(pcmPadBytes)]);
}

async function preserveFailure(session, label, cause) {
  let recoveryFile;
  const pcm = session.format
    ? bufferPcm(session.chunks, session.totalBytes, session.format)
    : Buffer.alloc(0);
  if (session.format && pcm.length >= session.format.blockAlign) {
    await mkdir(recoveryDirectory, { recursive: true });
    recoveryFile = path.join(recoveryDirectory, `${label}-${Date.now()}.wav`);
    await writeFile(recoveryFile, rf64File(session.formatChunk, pcm, session.format.blockAlign));
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  const message = recoveryFile
    ? `${detail} Captured audio was preserved as recoverable RF64: ${recoveryFile}. Check the output device and Windows audio service before retrying.`
    : `${detail} No recoverable audio was captured. Check the output device and Windows audio service before retrying.`;
  const error = new Error(message, { cause });
  error.recoveryFile = recoveryFile;
  throw error;
}

async function startCapture(args, label) {
  const host = spawn(hostPath, ["record", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const events = createEventReader(host);
  const close = once(host, "close");
  const chunks = [];
  const session = {
    host, events, chunks, close, format: undefined, formatChunk: undefined,
    totalBytes: 0, label,
  };
  host.stdout.on("data", (data) => {
    if (session.totalBytes + data.length > 16 * 1024 * 1024) {
      events.fail(new Error("Capture exceeded the bounded test buffer."));
      host.kill();
    } else {
      session.totalBytes += data.length;
      chunks.push(Buffer.from(data));
    }
  });
  host.once("error", events.fail);
  try {
    const ready = await events.waitFor("ready");
    session.format = parseFormat(ready, args.length ? "process-loopback" : "system-loopback");
    session.formatChunk = Buffer.from(ready.formatChunkBase64, "base64");
    session.deviceName = ready.deviceName;
    host.stdin.write("start\n");
    await events.waitFor("started");
    session.started = true;
    session.timeout = setTimeout(() => host.kill(), 120_000);
    return session;
  } catch (error) {
    if (host.exitCode === null) host.kill();
    await close.catch(() => {});
    await preserveFailure(session, label, error);
  }
}

async function stopCapture(session) {
  if (session.host.exitCode === null) session.host.stdin.write("stop\n");
  await session.events.waitFor("stopped");
  const [code, signal] = await session.close;
  assert.equal(code, 0, `Native capture host must flush and exit cleanly (${code ?? signal})`);
}

async function capture(args, duringCapture, label = "capture") {
  const session = await startCapture(args, label);
  try {
    await sleep(2500);
    if (duringCapture) {
      await duringCapture();
      await session.events.waitFor("source-ended");
      await session.events.waitFor("stopped");
      const [code, signal] = await session.close;
      assert.equal(code, 0, `Native capture host must finalize source exit cleanly (${code ?? signal})`);
    } else {
      await stopCapture(session);
    }
    const pcm = bufferPcm(session.chunks, session.totalBytes, session.format);
    const result = {
      format: session.format,
      deviceName: session.deviceName,
      target: measureTone(pcm, session.format, 440),
      unrelated: measureTone(pcm, session.format, 997),
    };
    Object.defineProperty(result, "recoverySession", { value: session });
    return result;
  } catch (error) {
    await preserveFailure(session, label, error);
  } finally {
    clearTimeout(session.timeout);
    if (session.host.exitCode === null) session.host.kill();
    await session.close.catch(() => {});
  }
}

function audioSlice(session, startByte, endByte) {
  const pcm = bufferPcm(session.chunks, session.totalBytes, session.format);
  const align = session.format.blockAlign;
  const start = Math.min(pcm.length, Math.ceil(startByte / align) * align);
  const end = Math.min(pcm.length, Math.floor(endByte / align) * align);
  return pcm.subarray(start, Math.max(start, end));
}

async function assertPositiveControl(control, label, recoverySession = control.recoverySession) {
  try {
    assert.ok(control.target.toneAmplitude > 0.01,
      `${label}: selected 440 Hz tone must remain audible in whole-output positive control`);
    assert.ok(control.unrelated.toneAmplitude > 0.01,
      `${label}: unrelated 997 Hz tone must remain audible in whole-output positive control`);
  } catch (error) {
    if (recoverySession) await preserveFailure(recoverySession, label, error);
    throw error;
  }
}

async function assertIsolation(result, label, recoverySession = result.recoverySession) {
  try {
    assert.ok(result.target.toneAmplitude > 0.01,
      `${label}: selected application tone must remain audible`);
    assert.ok(result.unrelated.toneAmplitude < result.target.toneAmplitude / 30,
      `${label}: unrelated application tone must remain excluded by at least 29.5 dB`);
  } catch (error) {
    if (recoverySession) await preserveFailure(recoverySession, label, error);
    throw error;
  }
}

async function lifecycleHelper(operation, { endpointId, endpointName, instanceId, role } = {}) {
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", lifecycleHelperPath, "-Operation", operation,
  ];
  if (endpointId) args.push("-EndpointId", endpointId);
  if (endpointName) args.push("-EndpointName", endpointName);
  if (instanceId) args.push("-InstanceId", instanceId);
  if (role !== undefined) args.push("-Role", String(role));
  const timeout = operation === "suspend-resume" ? 120_000
    : operation === "disable-endpoint" || operation === "enable-endpoint" ? 45_000
      : 15_000;
  const { stdout } = await execute("powershell.exe", args, {
    timeout,
    windowsHide: true,
    env: process.env,
  });
  return JSON.parse(stdout);
}

async function captureAcrossChange(args, change, label) {
  const session = await startCapture(args, label);
  try {
    await sleep(1600);
    const beforeEnd = session.totalBytes;
    const changeResult = await change();
    await sleep(1600);
    assert.equal(session.host.exitCode, null,
      `${label}: native recording process must not exit and appear healthy across the change`);
    const afterEnd = session.totalBytes;
    const beforePcm = audioSlice(session, 0, beforeEnd);
    const afterPcm = audioSlice(session, beforeEnd, afterEnd);
    const before = {
      target: measureTone(beforePcm, session.format, 440),
      unrelated: measureTone(beforePcm, session.format, 997),
    };
    const after = {
      target: measureTone(afterPcm, session.format, 440),
      unrelated: measureTone(afterPcm, session.format, 997),
    };
    await assertIsolation(before, `${label} before the change`);
    await assertIsolation(after, `${label} after the change`);
    await stopCapture(session);
    return { before, after, change: changeResult };
  } catch (error) {
    await preserveFailure(session, label, error);
  } finally {
    clearTimeout(session.timeout);
    if (session.host.exitCode === null) session.host.kill();
    await session.close.catch(() => {});
  }
}

async function listDevices() {
  const { stdout } = await execute(hostPath, ["devices"], { timeout: 10_000, windowsHide: true });
  return JSON.parse(stdout);
}

async function runLifecycle(args, initialDevices) {
  const roleDefaultsResult = await lifecycleHelper("get-defaults");
  const originalRoleDefaults = roleDefaultsResult.roleDefaults;
  assert.equal(originalRoleDefaults?.length, 3,
    "Lifecycle preflight must record all three original Windows output-role defaults");
  const activeIds = new Set(initialDevices.devices.map((device) => device.id));
  assert.ok(originalRoleDefaults.every((entry) => activeIds.has(entry.endpointId)),
    "All original Windows output-role defaults must be active playback endpoints");
  const consoleDefault = originalRoleDefaults.find((entry) => entry.role === 0);
  const original = initialDevices.devices.find((device) => device.id === consoleDefault?.endpointId);
  const alternate = initialDevices.devices.find((device) => device.id !== original?.id);
  assert.ok(original, "Lifecycle run requires an identifiable original default playback endpoint");
  assert.ok(alternate, "Lifecycle run requires a second active playback endpoint for rerouting");
  const result = { status: "running", originalEndpoint: original.name, alternateEndpoint: alternate.name };
  lifecycleEvidence = result;
  let routeChanged = false;
  let disabledEndpointInstanceId;
  const setEndpointForAllRoles = async (endpointId) => {
    for (const role of [0, 1, 2]) await lifecycleHelper("set-default", { endpointId, role });
  };
  const restoreRoleDefaults = async () => {
    for (const entry of originalRoleDefaults) {
      await lifecycleHelper("set-default", { endpointId: entry.endpointId, role: entry.role });
    }
  };
  try {
    result.reroute = await captureAcrossChange(args, async () => {
      routeChanged = true;
      await setEndpointForAllRoles(alternate.id);
      const observed = await listDevices();
      const current = observed.devices.find((device) => device.isDefault);
      assert.equal(current?.id, alternate.id, "Windows must confirm the alternate output became the default");
      const confirmedDefaults = await lifecycleHelper("get-defaults");
      assert.ok(confirmedDefaults.roleDefaults.every((entry) => entry.endpointId === alternate.id),
        "Windows must reroute console, multimedia, and communications output roles");
      return { operation: "reroute", defaultEndpoint: current.name };
    }, "reroute-during-process-capture");
    result.reroutePositiveControl = await capture([]);
    await assertPositiveControl(result.reroutePositiveControl, "After rerouting");
    result.rerouteIsolation = await capture(args, undefined, "reroute-isolation-control");
    await assertIsolation(result.rerouteIsolation, "After rerouting");

    result.deviceRemoval = await captureAcrossChange(args, async () => {
      const selectedEndpoint = await lifecycleHelper("get-endpoint", { endpointName: original.name });
      disabledEndpointInstanceId = selectedEndpoint.instanceId;
      const removed = await lifecycleHelper("disable-endpoint", {
        instanceId: disabledEndpointInstanceId,
      });
      const observed = await listDevices();
      assert.ok(observed.devices.some((device) => device.id === alternate.id && device.isDefault),
        "The alternate default output must remain active after endpoint removal");
      assert.ok(!observed.devices.some((device) => device.id === original.id),
        "The disabled endpoint must disappear from active playback devices");
      return {
        operation: removed.operation,
        endpointName: selectedEndpoint.endpointName,
        status: removed.status,
      };
    }, "disable-output-endpoint-during-process-capture");
    result.removalPositiveControl = await capture([]);
    await assertPositiveControl(result.removalPositiveControl, "After disabling the original endpoint");
    result.removalIsolation = await capture(args, undefined, "device-removal-isolation-control");
    await assertIsolation(result.removalIsolation, "After disabling the original endpoint");

    result.restoreDevice = await captureAcrossChange(args, async () => {
      const restored = await lifecycleHelper("enable-endpoint", {
        instanceId: disabledEndpointInstanceId,
      });
      disabledEndpointInstanceId = undefined;
      const observed = await listDevices();
      assert.ok(observed.devices.some((device) => device.id === original.id),
        "Windows must restore the disabled endpoint to active playback devices");
      return { operation: restored.operation, endpointName: restored.endpointName, status: restored.status };
    }, "restore-output-endpoint-during-process-capture");
    result.deviceRestorePositiveControl = await capture([]);
    await assertPositiveControl(result.deviceRestorePositiveControl, "After restoring the removed endpoint");
    result.deviceRestoreIsolation = await capture(args, undefined, "device-restore-isolation-control");
    await assertIsolation(result.deviceRestoreIsolation, "After restoring the removed endpoint");

    result.restoreRoute = await captureAcrossChange(args, async () => {
      await restoreRoleDefaults();
      routeChanged = false;
      const observed = await listDevices();
      const current = observed.devices.find((device) => device.isDefault);
      assert.equal(current?.id, original.id, "Windows must confirm the original output was restored");
      const confirmedDefaults = await lifecycleHelper("get-defaults");
      assert.deepEqual(confirmedDefaults.roleDefaults, originalRoleDefaults,
        "Every original Windows output-role default must be restored");
      routeChanged = false;
      return { operation: "restore-original-route", defaultEndpoint: current.name };
    }, "restore-original-output-during-process-capture");
    result.restorePositiveControl = await capture([]);
    await assertPositiveControl(result.restorePositiveControl, "After restoring the original output");
    result.restoreIsolation = await capture(args, undefined, "restore-isolation-control");
    await assertIsolation(result.restoreIsolation, "After restoring the original output");
  } finally {
    if (disabledEndpointInstanceId) {
      await lifecycleHelper("enable-endpoint", { instanceId: disabledEndpointInstanceId });
    }
    if (routeChanged) {
      await restoreRoleDefaults();
    }
  }

  result.suspendResume = await captureAcrossChange(args,
    () => lifecycleHelper("suspend-resume"), "suspend-resume-during-process-capture");
  result.resumePositiveControl = await capture([]);
  await assertPositiveControl(result.resumePositiveControl, "After Windows resumed");
  result.resumeIsolation = await capture(args, undefined, "resume-isolation-control");
  await assertIsolation(result.resumeIsolation, "After Windows resumed");
  result.status = "passed";
  return result;
}

async function main() {
  assert.equal(process.platform, "win32", "Requires a real Windows audio runner");
  if (process.argv.slice(2).some((argument) =>
    argument !== "--lifecycle" && path.resolve(argument) !== hostPath)) {
    throw new Error("Usage: node desktop/windows-process-capture-acceptance.mjs [host.exe] [--lifecycle]");
  }
  if (lifecycleRequested && (
    process.env.WAVEYARD_ENABLE_DESTRUCTIVE_AUDIO_TESTS !== "1" ||
    process.env.WAVEYARD_AUDIO_RUNNER_ISOLATED !== "1"
  )) {
    throw new Error("Lifecycle tests require explicit destructive-test approval and the isolated Windows audio runner.");
  }
  runnerEvidence = await runnerMetadata();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "waveyard-process-isolation-"));
  const players = [];
  try {
    for (const frequency of [440, 997]) {
      const file = path.join(scratch, `${frequency}.wav`);
      await writeFile(file, makeToneWave(frequency));
      players.push(await player(file));
    }
    const options = await listDevices();
    assert.equal(options.processLoopbackSupported, true, options.processLoopbackReason);
    assert.ok(options.devices.length, "Positive system-loopback control requires an active output endpoint");
    const app = options.applications.find((item) => item.processId === players[0].pid);
    assert.ok(app, "Selected tone player must be discoverable without a whitelist");
    const args = ["--process-id", String(app.processId), "--process-start-time", app.processStartTime];
    // Reject a stale identity; never fall back to recording all apps.
    await assert.rejects(execute(hostPath, ["record", "--process-id", String(app.processId),
      "--process-start-time", "0"], { timeout: 5000 }), /selected application exited or restarted/,
      "A timeout or unrelated failure is not evidence of stale-identity rejection");
    const control = await capture([]);
    await assertPositiveControl(control, "Initial positive control");
    const isolated = await capture(args, undefined, "initial-process-isolation");
    await assertIsolation(isolated, "Initial process isolation");
    let lifecycle;
    if (lifecycleRequested) {
      lifecycle = await runLifecycle(args, options);
    }
    const exited = await capture(args, async () => {
      players[0].stdin.end("\n");
      await players[0].closed;
    }, "selected-process-exit");
    await assertIsolation(exited, "Selected process exit");
    await assert.rejects(execute(hostPath, ["record", ...args], { timeout: 5000 }),
      /selected application exited or restarted/,
      "An exited source must not silently switch to a new process or whole output");

    return {
      status: lifecycleRequested ? "passed" : "partial",
      baseStatus: "passed",
      lifecycle: lifecycle ?? {
        status: "not-run",
        reason: "Output rerouting and Windows suspend/resume require the explicit opt-in on an isolated audio runner.",
      },
      test: lifecycleRequested
        ? "native process-tree isolation plus output rerouting and suspend/resume"
        : "native process-tree loopback isolation only",
      runner: runnerEvidence,
      control,
      isolated,
      exited,
      evidence: "Two independent authorized generated tone players; no protected media or source-bit-perfect claim",
    };
  } finally {
    for (const child of players) {
      if (child.exitCode === null) child.kill();
      await child.closed;
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

let report;
try {
  report = await main();
} catch (error) {
  if (lifecycleEvidence) {
    lifecycleEvidence.status = "failed";
    lifecycleEvidence.message = error instanceof Error ? error.message : String(error);
  }
  report = {
    status: "failed",
    runner: runnerEvidence ?? { status: "unavailable" },
    lifecycle: lifecycleEvidence ?? { status: lifecycleRequested ? "failed" : "not-run" },
    message: error instanceof Error ? error.message : String(error),
    ...(error?.recoveryFile ? { recoveryFile: error.recoveryFile } : {}),
  };
  process.exitCode = 1;
}
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
