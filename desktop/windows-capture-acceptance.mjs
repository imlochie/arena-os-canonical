import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const suppliedHostPath = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const hostPath = path.resolve(
  suppliedHostPath ?? path.join(scriptDirectory, "stage", "native", "waveyard-capture-host.exe"),
);
const timeoutMs = 15_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const recoveryDirectory = path.resolve("generated-artifacts/windows-capture-device-loss/recovery");
const reportPath = path.resolve("generated-artifacts/windows-capture-device-loss/result.json");

export function makeToneWave(frequency = 440) {
  const sampleRate = 48_000;
  const seconds = 3;
  const frameCount = sampleRate * seconds;
  const dataBytes = frameCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const edge = Math.min(1, frame / 1200, (frameCount - frame - 1) / 1200);
    const sample = Math.round(24_000 * Math.max(0, edge) * Math.sin((2 * Math.PI * frequency * frame) / sampleRate));
    wav.writeInt16LE(sample, 44 + frame * 2);
  }
  return wav;
}

export function parseFormat(event, expectedMode = "system-loopback") {
  if (event.mode !== expectedMode || typeof event.formatChunkBase64 !== "string") {
    throw new Error(`Capture host returned an invalid ${expectedMode} format event.`);
  }
  const chunk = Buffer.from(event.formatChunkBase64, "base64");
  if (chunk.length < 16) throw new Error("Capture host returned a truncated WAVEFORMATEX chunk.");
  let tag = chunk.readUInt16LE(0);
  const channels = chunk.readUInt16LE(2);
  const sampleRate = chunk.readUInt32LE(4);
  const blockAlign = chunk.readUInt16LE(12);
  const bitsPerSample = chunk.readUInt16LE(14);
  if (tag === 0xfffe) {
    if (chunk.length < 40 || chunk.readUInt16LE(16) < 22) {
      throw new Error("Capture host returned an incomplete extensible audio format.");
    }
    tag = chunk.readUInt16LE(24);
  }
  if (
    ![1, 3].includes(tag) ||
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 32 ||
    sampleRate < 8_000 ||
    sampleRate > 384_000 ||
    blockAlign < channels ||
    bitsPerSample % 8 !== 0
  ) {
    throw new Error(`The capture host returned an unsupported PCM format (tag ${tag}, ${bitsPerSample}-bit).`);
  }
  if (tag === 3 && ![32, 64].includes(bitsPerSample)) {
    throw new Error(`Unsupported floating-point PCM depth: ${bitsPerSample}-bit.`);
  }
  if (tag === 1 && ![8, 16, 24, 32].includes(bitsPerSample)) {
    throw new Error(`Unsupported integer PCM depth: ${bitsPerSample}-bit.`);
  }
  return { tag, channels, sampleRate, blockAlign, bitsPerSample };
}

function readNormalizedSample(buffer, offset, format) {
  if (format.tag === 3) {
    return format.bitsPerSample === 32 ? buffer.readFloatLE(offset) : buffer.readDoubleLE(offset);
  }
  if (format.bitsPerSample === 8) return (buffer.readUInt8(offset) - 128) / 128;
  if (format.bitsPerSample === 16) return buffer.readInt16LE(offset) / 32_768;
  if (format.bitsPerSample === 24) {
    let sample = buffer.readUIntLE(offset, 3);
    if (sample & 0x800000) sample |= 0xff000000;
    return sample / 8_388_608;
  }
  return buffer.readInt32LE(offset) / 2_147_483_648;
}

export function measureTone(pcm, format, frequency = 440) {
  const bytesPerSample = format.bitsPerSample / 8;
  const frames = Math.floor(pcm.length / format.blockAlign);
  if (frames < format.sampleRate) throw new Error("The capture contains less than one second of audio.");
  let sumSquares = 0;
  let peak = 0;
  let q1 = 0;
  let q2 = 0;
  const omega = (2 * Math.PI * frequency) / format.sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let samples = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * format.blockAlign;
    const value = readNormalizedSample(pcm, offset, format);
    if (!Number.isFinite(value)) continue;
    peak = Math.max(peak, Math.abs(value));
    sumSquares += value * value;
    const q0 = value + coefficient * q1 - q2;
    q2 = q1;
    q1 = q0;
    samples += 1;
  }
  const rms = samples ? Math.sqrt(sumSquares / samples) : 0;
  const power = Math.max(0, q1 * q1 + q2 * q2 - q1 * q2 * coefficient);
  const toneAmplitude = samples ? (2 * Math.sqrt(power)) / samples : 0;
  return { frames, rms, peak, toneAmplitude };
}

export function makeRf64Wave(formatChunk, pcm, blockAlign) {
  const formatPadding = formatChunk.length % 2;
  const pcmPadding = pcm.length % 2;
  const header = Buffer.alloc(64 + formatChunk.length + formatPadding);
  const fileBytes = header.length + pcm.length + pcmPadding;
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
  const dataOffset = 56 + formatChunk.length + formatPadding;
  header.write("data", dataOffset, "ascii");
  header.writeUInt32LE(0xffffffff, dataOffset + 4);
  return Buffer.concat([header, pcm, Buffer.alloc(pcmPadding)]);
}

export function createEventReader(child) {
  const queued = [];
  const waiters = new Map();
  let buffer = "";
  let terminalError = null;
  let discontinuityCount = 0;
  const fail = (error) => {
    terminalError = error;
    for (const pending of waiters.values()) {
      for (const waiter of pending) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }
    waiters.clear();
  };
  const publish = (event) => {
    if (event.type === "discontinuity") discontinuityCount += 1;
    if (event.type === "error") {
      fail(new Error(event.message || "Windows capture host reported an error."));
      return;
    }
    const pending = waiters.get(event.type);
    if (pending?.length) {
      const waiter = pending.shift();
      if (!pending.length) waiters.delete(event.type);
      clearTimeout(waiter.timeout);
      waiter.resolve(event);
    } else {
      queued.push(event);
    }
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        publish(JSON.parse(line));
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Invalid capture-host event."));
      }
    }
  });
  return {
    waitFor(type, timeout = timeoutMs) {
      const index = queued.findIndex((event) => event.type === type);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => {
        const pending = waiters.get(type) ?? [];
        const waiter = {
          resolve,
          reject,
          timeout: setTimeout(() => {
            const current = waiters.get(type) ?? [];
            waiters.set(type, current.filter((item) => item !== waiter));
            reject(new Error(`Timed out waiting for the Windows capture host "${type}" event.`));
          }, timeout),
        };
        pending.push(waiter);
        waiters.set(type, pending);
      });
    },
    discontinuities: () => discontinuityCount,
    fail,
  };
}

async function listPlaybackDevices() {
  return new Promise((resolve, reject) => {
    const child = spawn(hostPath, ["devices"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Could not list Windows playback endpoints (${code}): ${errors.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runDeviceLossAcceptance() {
  if (process.platform !== "win32") {
    throw new Error("The interactive device-loss acceptance check must run on Windows.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this check in an interactive Windows terminal so you can disable and restore the selected endpoint.");
  }

  let report = {
    status: "failed",
    test: "selected Windows playback endpoint loss during generated-tone recording",
    recovery: { file: null, usable: false, reason: "The recording did not produce a usable recovery file." },
  };
  let host;
  let tonePlayer;
  let tonePlayerClose;
  let closePromise;
  let scratch;
  let events;
  let pcmChunks = [];
  let totalBytes = 0;
  let format;
  let formatChunk;
  let tonePath;
  let reader;
  let selected;
  let nativeFailure;
  let deviceLossConfirmed = false;
  let deviceLossAttempted = false;

  try {
    const devices = await listPlaybackDevices();
    selected = devices.devices?.find((device) => device.isDefault);
    if (!selected) throw new Error("Select an active default Windows playback endpoint before running this check.");

    scratch = await mkdtemp(path.join(os.tmpdir(), `waveyard-device-loss-${randomUUID()}-`));
    tonePath = path.join(scratch, "known-440hz-tone.wav");
    await writeFile(tonePath, makeToneWave(), { flag: "wx" });
    host = spawn(hostPath, ["record", "--device-id", selected.id], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    events = createEventReader(host);
    host.stdout.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 16 * 1024 * 1024) {
        events.fail(new Error("Capture exceeded the 16 MiB device-loss test safety limit."));
        host.kill();
        return;
      }
      pcmChunks.push(Buffer.from(chunk));
    });
    host.once("error", events.fail);
    closePromise = new Promise((resolve) => host.once("close", (code, signal) => resolve({ code, signal })));
    const ready = await events.waitFor("ready");
    format = parseFormat(ready);
    formatChunk = Buffer.from(ready.formatChunkBase64, "base64");
    if (ready.deviceId !== selected.id) {
      throw new Error("The capture host did not keep the explicitly selected endpoint. No fallback is accepted.");
    }
    host.stdin.write("start\n");
    await events.waitFor("started");

    tonePlayer = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; $p=New-Object System.Media.SoundPlayer; $p.SoundLocation=$env:WAVEYARD_TEST_TONE; $p.Load(); $p.PlayLooping(); [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine() | Out-Null; $p.Stop()",
      ],
      {
        windowsHide: true,
        env: { ...process.env, WAVEYARD_TEST_TONE: tonePath },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    tonePlayerClose = new Promise((resolve) => tonePlayer.once("close", resolve));
    let playerOutput = "";
    let playerErrors = "";
    tonePlayer.stdout.setEncoding("utf8");
    tonePlayer.stderr.setEncoding("utf8");
    tonePlayer.stdout.on("data", (text) => { playerOutput += text; });
    tonePlayer.stderr.on("data", (text) => { playerErrors += text; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Generated-tone player did not become ready.")), 10_000);
      tonePlayer.once("error", reject);
      tonePlayer.once("close", (code) => reject(new Error(`Generated-tone player exited early (${code}): ${playerErrors.trim()}`)));
      const checkReady = () => {
        if (playerOutput.includes("ready")) {
          clearTimeout(timeout);
          resolve();
        }
      };
      tonePlayer.stdout.on("data", checkReady);
    });

    await sleep(2200);
    const initialPcm = Buffer.concat(pcmChunks, totalBytes);
    const initialTone = measureTone(initialPcm, format);
    if (initialTone.toneAmplitude < 0.01) {
      throw new Error("The positive control did not capture the generated 440 Hz tone on the selected endpoint.");
    }

    reader = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\nRecording the selected endpoint: ${selected.name}`);
    console.log("In ArenaForge, start a whole-output recording on this same endpoint while the test tone is playing.");
    console.log("When the app recording is active, return here and press Enter. The next prompt will ask you to disconnect or disable it.");
    await reader.question("Press Enter after ArenaForge is recording: ");
    deviceLossAttempted = true;
    console.log("Disable that playback endpoint in Windows Sound settings, or unplug it, then return here and press Enter.");
    console.log("Do not change the default output route to try to keep this capture alive; the selected endpoint must remain fixed.");
    const terminalEvent = events.waitFor("stopped").then(
      () => ({ type: "stopped" }),
      (error) => ({ type: "error", error }),
    );
    const userAbort = new AbortController();
    const userConfirmed = reader.question("After disabling or unplugging the endpoint, press Enter: ", { signal: userAbort.signal })
      .then(() => ({ type: "user-confirmed" }), () => ({ type: "cancelled" }));
    const firstOutcome = await Promise.race([terminalEvent, userConfirmed]);
    if (firstOutcome.type === "error") {
      nativeFailure = firstOutcome.error.message;
      userAbort.abort();
      const observedDevices = await listPlaybackDevices();
      if (observedDevices.devices?.some((device) => device.id === selected.id)) {
        throw new Error("The native recorder failed before the selected endpoint was disabled or unplugged.");
      }
      deviceLossConfirmed = true;
    } else if (firstOutcome.type === "stopped") {
      throw new Error("The capture host stopped without reporting an endpoint failure.");
    } else if (firstOutcome.type === "user-confirmed") {
      const afterRemoval = await listPlaybackDevices();
      if (afterRemoval.devices?.some((device) => device.id === selected.id)) {
        throw new Error("The selected endpoint is still active. Disable or unplug that exact endpoint before continuing.");
      }
      deviceLossConfirmed = true;
    } else {
      throw new Error("The endpoint-loss action was not confirmed.");
    }
    const outcome = await Promise.race([
      terminalEvent,
      sleep(15_000).then(() => ({ type: "timeout" })),
    ]);
    if (outcome.type === "error") nativeFailure = outcome.error.message;
    else if (outcome.type === "stopped") {
      throw new Error("The capture host finalized cleanly after endpoint loss instead of reporting a capture failure.");
    } else {
      throw new Error("The capture host did not report endpoint loss within 15 seconds. This is not a pass; check whether it kept running silently.");
    }

    tonePlayer.stdin.end("\n");
    const hostExit = await closePromise;
    const pcm = Buffer.concat(pcmChunks, totalBytes);
    const alignedPcm = pcm.subarray(0, pcm.length - (pcm.length % format.blockAlign));
    const capturedSignal = alignedPcm.length >= format.sampleRate * format.blockAlign
      ? measureTone(alignedPcm, format)
      : null;
    if (alignedPcm.length > 0) {
      await mkdir(recoveryDirectory, { recursive: true });
      const recoveryFile = path.join(recoveryDirectory, `endpoint-loss-${Date.now()}.wav`);
      await writeFile(recoveryFile, makeRf64Wave(formatChunk, alignedPcm, format.blockAlign), { flag: "wx" });
      const recoveryStats = await stat(recoveryFile);
      report.recovery = {
        file: recoveryFile,
        bytes: recoveryStats.size,
        usable: !!capturedSignal && capturedSignal.toneAmplitude >= 0.01,
        reason: capturedSignal && capturedSignal.toneAmplitude >= 0.01
          ? undefined
          : "A valid RF64 file was saved, but the captured PCM did not contain a measurable generated tone.",
        toneAmplitude: capturedSignal ? Number(capturedSignal.toneAmplitude.toFixed(6)) : null,
        manualNextStep: "Restore the endpoint, then import this WAV into the library and play the imported track.",
      };
    } else {
      report.recovery.reason = "The endpoint failed before any aligned PCM frames were captured; no usable audio file could be preserved.";
    }
    report = {
      ...report,
      status: "failed",
      endpoint: { id: selected.id, name: selected.name },
      positiveControl: {
        capturedTone: true,
        toneAmplitude: Number(initialTone.toneAmplitude.toFixed(6)),
      },
      nativeFailure,
      deviceLossConfirmed,
      failureNotice: "Windows stopped the recording before it could be finalized. Any audio captured before the failure was preserved for recovery. Open Preserved recordings to recover it.",
      noAutomaticSourceSwitch: true,
      hostExit,
      restoration: "Re-enable or reconnect the endpoint before resuming ordinary playback.",
    };
    if (!nativeFailure) throw new Error("The native capture host did not report endpoint loss.");
    console.log("\nRestore or reconnect the endpoint. In ArenaForge, verify the failure notice and Preserved recordings.");
    console.log("Import that preserved recording and play the imported track before confirming success.");
    const appRecoveryCheck = await reader.question("Did the app preserve, import, and play the recording? Type yes or describe what failed: ");
    report.appRecovery = {
      confirmed: appRecoveryCheck.trim().toLowerCase() === "yes",
      testerNote: appRecoveryCheck.trim(),
      verification: "User-confirmed in the ArenaForge workbench after restoring the endpoint.",
    };
    report.status = deviceLossConfirmed && nativeFailure && hostExit.code !== 0 &&
      report.recovery.usable && report.appRecovery.confirmed ? "passed" : "failed";
    if (!report.appRecovery.confirmed) {
      report.recovery.reason = appRecoveryCheck.trim() || "The app did not confirm successful import and playback.";
    }
  } catch (error) {
    report = {
      ...report,
      status: "failed",
      endpoint: selected ? { id: selected.id, name: selected.name } : undefined,
      nativeFailure,
      message: error instanceof Error ? error.message : String(error),
    };
    if (host && format && formatChunk && totalBytes > 0 && !report.recovery.file) {
      try {
        const pcm = Buffer.concat(pcmChunks, totalBytes);
        const alignedPcm = pcm.subarray(0, pcm.length - (pcm.length % format.blockAlign));
        if (alignedPcm.length > 0) {
          await mkdir(recoveryDirectory, { recursive: true });
          const recoveryFile = path.join(recoveryDirectory, `endpoint-loss-${Date.now()}.wav`);
          await writeFile(recoveryFile, makeRf64Wave(formatChunk, alignedPcm, format.blockAlign), { flag: "wx" });
          report.recovery = {
            file: recoveryFile,
            bytes: alignedPcm.length,
            usable: false,
            reason: "Audio was saved after the test failed, but this run did not establish a measurable generated-tone recovery.",
          };
        }
      } catch (preserveError) {
        report.recovery.reason = `Audio preservation also failed: ${preserveError instanceof Error ? preserveError.message : String(preserveError)}`;
      }
    }
    if (deviceLossAttempted && reader) {
      await reader.question("This run did not pass. Restore or reconnect the endpoint, then press Enter: ").catch(() => {});
    }
  } finally {
    reader?.close();
    if (tonePlayer?.exitCode === null) {
      tonePlayer.stdin.end("\n");
      tonePlayer.kill();
    }
    if (tonePlayerClose) await tonePlayerClose;
    if (host?.exitCode === null) host.kill();
    if (closePromise) await closePromise;
    if (scratch) await rm(scratch, { recursive: true, force: true });
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
  }
  return report.status === "passed" ? 0 : 1;
}

async function runPowerShellTone(tonePath) {
  const player = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; $player = New-Object System.Media.SoundPlayer; $player.SoundLocation=$env:WAVEYARD_TEST_TONE; $player.PlaySync()",
    ],
    {
      windowsHide: true,
      env: { ...process.env, WAVEYARD_TEST_TONE: tonePath },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  player.stderr.setEncoding("utf8");
  player.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => player.kill(), 10_000);
  const [code, signal] = await new Promise((resolve, reject) => {
    player.once("error", reject);
    player.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  }).finally(() => clearTimeout(timeout));
  if (code !== 0) throw new Error(`PowerShell tone playback failed (${code ?? signal}): ${stderr.trim()}`);
}

async function main() {
  if (process.argv.includes("--device-loss")) {
    return runDeviceLossAcceptance();
  }
  if (process.platform !== "win32") {
    throw new Error("This acceptance check must run on Windows with an active playback endpoint.");
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), `waveyard-loopback-${randomUUID()}-`));
  const tonePath = path.join(scratch, "known-440hz-tone.wav");
  await writeFile(tonePath, makeToneWave(), { flag: "wx" });

  const host = spawn(hostPath, ["record"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = createEventReader(host);
  const pcmChunks = [];
  let totalBytes = 0;
  host.stdout.on("data", (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > 16 * 1024 * 1024) {
      events.fail(new Error("Capture output exceeded the 16 MiB acceptance-test safety limit."));
      host.kill();
      return;
    }
    pcmChunks.push(Buffer.from(chunk));
  });
  host.once("error", events.fail);
  const closePromise = new Promise((resolve, reject) => {
    host.once("error", reject);
    host.once("close", (code, signal) => resolve({ code, signal }));
  });

  try {
    const ready = await events.waitFor("ready");
    const format = parseFormat(ready);
    host.stdin.write("start\n");
    await events.waitFor("started");
    await runPowerShellTone(tonePath);
    await sleep(350);
    host.stdin.write("stop\n");
    await events.waitFor("stopped");
    const close = await closePromise;
    if (close.code !== 0) throw new Error(`Capture host exited with ${close.code ?? close.signal}.`);

    const pcm = Buffer.concat(pcmChunks, totalBytes);
    const measurement = measureTone(pcm, format);
    if (measurement.rms < 0.001 || measurement.peak < 0.01 || measurement.toneAmplitude < 0.003) {
      throw new Error("The loopback recording did not contain the expected audible 440 Hz test tone.");
    }
    console.log(JSON.stringify({
      passed: true,
      test: "Windows WASAPI system-loopback captured an audible 440 Hz tone",
      mode: ready.mode,
      deviceName: ready.deviceName,
      sampleRate: format.sampleRate,
      channels: format.channels,
      bitsPerSample: format.bitsPerSample,
      discontinuities: events.discontinuities(),
      measurement: {
        frames: measurement.frames,
        rms: Number(measurement.rms.toFixed(6)),
        peak: Number(measurement.peak.toFixed(6)),
        toneAmplitude: Number(measurement.toneAmplitude.toFixed(6)),
      },
    }, null, 2));
  } finally {
    if (host.exitCode === null) host.kill();
    await closePromise.catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((status) => {
    if (typeof status === "number") process.exitCode = status;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
