import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const hostPath = path.resolve(
  process.argv[2] ??
    path.join(scriptDirectory, "stage", "native", "waveyard-capture-host.exe"),
);
const timeoutMs = 15_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function makeToneWave() {
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
    const sample = Math.round(24_000 * Math.max(0, edge) * Math.sin((2 * Math.PI * 440 * frame) / sampleRate));
    wav.writeInt16LE(sample, 44 + frame * 2);
  }
  return wav;
}

function parseFormat(event) {
  if (event.mode !== "system-loopback" || typeof event.formatChunkBase64 !== "string") {
    throw new Error("Capture host returned an invalid system-loopback format event.");
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

function measureTone(pcm, format) {
  const bytesPerSample = format.bitsPerSample / 8;
  const frames = Math.floor(pcm.length / format.blockAlign);
  if (frames < format.sampleRate) throw new Error("The capture contains less than one second of audio.");
  let sumSquares = 0;
  let peak = 0;
  let q1 = 0;
  let q2 = 0;
  const omega = (2 * Math.PI * 440) / format.sampleRate;
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

function createEventReader(child) {
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
