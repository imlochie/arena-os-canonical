/**
 * Opt-in benchmark, NOT functional/Windows acceptance.
 * pnpm --filter @workspace/scripts exec node --expose-gc --import tsx \
 *   /absolute/workspace/scripts/waveyard-capture-performance.ts --out /absolute/report.json
 * Temporary RF64s are streamed, verified and removed. Only the JSON report is retained.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { setTimeout as sleep } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { PcmSignalMonitor } from "../lib/arena/src/lib/waveyard/capture/pcm-signal";
import { createRf64Header, Rf64Recorder } from "../lib/arena/src/lib/waveyard/capture/rf64";

const seconds = Number(process.env.CAPTURE_BENCH_AUDIO_SECONDS ?? 30);
const repetitions = Number(process.env.CAPTURE_BENCH_REPETITIONS ?? 2);
assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 600);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5);
const output = process.argv.indexOf("--out");
assert.ok(output >= 0 && process.argv[output + 1], "Pass --out with a report file under generated-artifacts/");
const outputPath = path.resolve(process.argv[output + 1]);
const scratch = await mkdtemp(path.join(os.tmpdir(), "waveyard-capture-bench-"));
const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "Use node --expose-gc so retained memory is measured after collection");

function format(rate: number, channels: number, bits: number, float: boolean) {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt16LE(float ? 3 : 1, 0);
  bytes.writeUInt16LE(channels, 2);
  bytes.writeUInt32LE(rate, 4);
  bytes.writeUInt32LE(rate * channels * bits / 8, 8);
  bytes.writeUInt16LE(channels * bits / 8, 12);
  bytes.writeUInt16LE(bits, 14);
  return bytes;
}

const configs = [48000, 96000, 192000].flatMap((rate, index) =>
  [1, 2, 8].flatMap((channels) => [false, true].map((float) => ({
    rate, channels, float, bits: float ? (channels === 8 ? 64 : 32) : [16, 24, 32][index],
  }))));

type Config = typeof configs[number];
function source(config: Config) {
  const blockAlign = config.channels * config.bits / 8;
  const pool = Buffer.alloc(Math.floor(65536 / blockAlign) * blockAlign);
  const width = config.bits / 8;
  for (let offset = 0; offset < pool.length; offset += width) {
    const value = (offset / width) % 17 === 0 ? 1 : 0.25;
    if (config.float) {
      if (width === 4) pool.writeFloatLE(value, offset);
      else pool.writeDoubleLE(value, offset);
    } else pool.writeIntLE(Math.floor(value * (2 ** (config.bits - 1) - 1)), offset, width);
  }
  return pool;
}

function percentile(values: number[], percent: number) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percent))] ?? 0;
}
function memory() {
  gc!();
  const { heapUsed, external, arrayBuffers, rss } = process.memoryUsage();
  return { heapUsed, external, arrayBuffers, rss };
}

async function run(config: Config, mode: "source" | "monitor" | "record" | "record+monitor",
  repetition: number, audioSeconds = seconds, probeControls = true) {
  const formatChunk = format(config.rate, config.channels, config.bits, config.float);
  const align = formatChunk.readUInt16LE(12);
  const pool = source(config);
  const originalHash = createHash("sha256").update(pool).digest("hex");
  const total = audioSeconds * config.rate * align;
  const monitor = mode === "monitor" || mode === "record+monitor" ? new PcmSignalMonitor(formatChunk) : undefined;
  const file = path.join(scratch, "capture.wav");
  const recorder = mode === "record" || mode === "record+monitor" ? await Rf64Recorder.create({
    partialPath: path.join(scratch, "capture.partial.wav"), finalPath: file, format: { formatChunk },
  }) : undefined;
  const samples: { audioSeconds: number; memory: ReturnType<typeof memory> }[] = [];
  const latencies: number[] = [];
  // Local control endpoint shares this event loop with PCM observation/writes.
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(monitor?.snapshot() ?? { recording: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/status`;
  await (await fetch(url)).json();
  let stopped = false;
  const controls = (async () => {
    while (!stopped && probeControls) {
      const start = performance.now();
      const response = await fetch(url);
      await response.json();
      assert.equal(response.status, 200);
      latencies.push(performance.now() - start);
      // Avoid turning probes into the dominant CPU workload. 100 Hz is still
      // much more aggressive than the real UI's 1 Hz status poll.
      await sleep(10);
    }
  })();
  // Warm JS, fetch and Buffer machinery outside the measured period.
  monitor?.write(pool);
  const before = memory();
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const cpu = process.cpuUsage();
  const began = performance.now();
  let seed = 0x12345678;
  let count = 0;
  let maxWriteMs = 0;
  let maxCarry = 0;
  let nextSample = 10 * config.rate * align;
  try {
    for (let done = 0; done < total;) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const offset = done % pool.length;
      const size = Math.min(1 + seed % 65536, pool.length - offset, total - done);
      const chunk = pool.subarray(offset, offset + size);
      if (recorder) await recorder.writePcm(chunk);
      const beganWrite = performance.now();
      monitor?.write(chunk);
      maxWriteMs = Math.max(maxWriteMs, performance.now() - beganWrite);
      // Introspection only in this benchmark; the production monitor owns no
      // history other than this copied partial frame.
      const carry = monitor ? (monitor as unknown as { tail: Buffer }).tail.length : 0;
      assert.ok(carry < align);
      maxCarry = Math.max(maxCarry, carry);
      done += size;
      count++;
      // Match the manager's async file write and one pipe chunk at a time.
      // Monitor-only tests explicitly yield so HTTP/timers share the loop.
      if (!recorder) await yieldTurn();
      if (done >= nextSample) {
        samples.push({ audioSeconds: done / (config.rate * align), memory: memory() });
        nextSample += 10 * config.rate * align;
      }
    }
    if (recorder) await recorder.finalize();
    const elapsedMs = performance.now() - began;
    const usedCpu = process.cpuUsage(cpu);
    histogram.disable();
    stopped = true;
    await controls;
    const after = memory();
    assert.equal(createHash("sha256").update(pool).digest("hex"), originalHash, "source bytes were modified");
    if (recorder) {
      const expected = createHash("sha256");
      for (let done = 0; done < total; done += pool.length)
        expected.update(pool.subarray(0, Math.min(pool.length, total - done)));
      const actual = createHash("sha256");
      for await (const chunk of createReadStream(file, { start: createRf64Header({ formatChunk }).dataOffset }))
        actual.update(chunk);
      assert.equal(actual.digest("hex"), expected.digest("hex"), "RF64 PCM differs from original stream");
    }
    return {
      config, mode, repetition, audioSeconds, bytes: total, chunks: count,
      elapsedMs, cpuMs: (usedCpu.user + usedCpu.system) / 1000,
      cpuPercentOfOneCoreAtRealtime: (usedCpu.user + usedCpu.system) / (audioSeconds * 10000),
      maxWriteMs, maxCarryBytes: maxCarry, blockAlign: align,
      eventLoop: { maxMs: histogram.max / 1e6, p99Ms: histogram.percentile(99) / 1e6 },
      controls: { enabled: probeControls, requests: latencies.length,
        p95Ms: percentile(latencies, 0.95), maxMs: latencies.length ? Math.max(...latencies) : null },
      memory: { before, after, samples },
      note: "CPU includes generator, 100Hz maximum HTTP probes, explicit GC and RF64 writes when enabled; use paired record+monitor minus record to estimate overhead, not raw CPU as isolated monitor cost. Not a Windows result.",
    };
  } finally {
    stopped = true;
    histogram.disable();
    await controls;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await recorder?.leaveRecoverable().catch(() => {});
    await rm(file, { force: true });
    await rm(path.join(scratch, "capture.partial.wav"), { force: true });
  }
}

try {
  const results = [];
  for (let repetition = 0; repetition < (process.argv.includes("--soak-only") || process.argv.includes("--retention-only") ? 0 : repetitions); repetition++) {
    for (const config of configs) {
      // Alternate paired order to avoid attributing warmup/order to monitoring.
      const modes = repetition % 2 ? ["record+monitor", "record", "monitor"] as const
        : ["record", "record+monitor", "monitor"] as const;
      for (const mode of modes) {
        const result = await run(config, mode, repetition);
        results.push(result);
        console.log(`${config.rate}/${config.channels}/${config.float ? "f" : "i"}${config.bits} ${mode}: CPU ${result.cpuMs.toFixed(0)}ms; write max ${result.maxWriteMs.toFixed(2)}ms; HTTP max ${(result.controls.maxMs ?? 0).toFixed(1)}ms`);
      }
    }
  }
  if (process.argv.includes("--soak-only")) {
    results.push(await run({ rate: 192000, channels: 8, float: true, bits: 64 }, "monitor", 0, 300));
    console.log("Completed five minutes equivalent of streamed 192kHz/8ch float64 without retaining recording data.");
  }
  if (process.argv.includes("--retention-only")) {
    const config = { rate: 192000, channels: 8, float: true, bits: 64 };
    results.push(await run(config, "source", 0, 300, false));
    results.push(await run(config, "monitor", 0, 300, false));
    console.log("Completed paired source-only and signal-monitor retention checks without repeated HTTP allocation.");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify({
    kind: "benchmark-not-acceptance", timestamp: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version,
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, os: os.release() },
    scope: "Streaming synthetic PCM, unpaced accelerated input, bounded 64KiB source pool; real RF64 I/O and local HTTP probes. No native audio, Windows validation or quality claim.",
    secondsPerCase: seconds, repetitions, results,
  }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
