/** Bounded audition runner: real bundled inference worker, without a test database.
 * This is DSP evidence, not proof of library import, persistence, or retry routes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { findMdxModel } from "../lib/arena/src/lib/waveyard/separation/mdx";
import { encodeWav16 } from "../lib/arena/src/lib/waveyard/mixer/synth";
import { SEPARATION_MEMORY_OPTIONS } from "../lib/arena/src/lib/waveyard/separation/session";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [input, output, durationText = "8"] = process.argv.slice(2).filter(arg => arg !== "--");
if (!input || !output) throw new Error("Usage: tsx waveyard-proof-stems.ts <input> <output-directory> [seconds]");
const seconds = Number(durationText);
assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= 15, "auditions must be 0–15 seconds");
const inputPath = resolve(input);
const outputPath = resolve(output);
await mkdir(outputPath, { recursive: true });
const decoded = spawnSync("ffmpeg", [
  "-v", "error", "-i", inputPath, "-t", String(seconds),
  "-ar", "44100", "-ac", "2", "-f", "f32le", "pipe:1",
], { maxBuffer: 16 * 1024 * 1024 });
assert.equal(decoded.status, 0, decoded.stderr?.toString() || decoded.error?.message);
assert.ok(decoded.stdout.length > 8 && decoded.stdout.length % 8 === 0);
const frames = decoded.stdout.length / 8;
const left = new Float32Array(frames);
const right = new Float32Array(frames);
for (let frame = 0; frame < frames; frame++) {
  left[frame] = decoded.stdout.readFloatLE(frame * 8);
  right[frame] = decoded.stdout.readFloatLE(frame * 8 + 4);
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const reports: Record<string, unknown>[] = [];
for (const id of ["kim_vocal_2", "kuielab_b_drums", "kuielab_b_bass", "kuielab_b_other"]) {
  const spec = findMdxModel(id);
  assert.ok(spec);
  console.log(`MODEL_START ${id}`);
  const started = Date.now();
  const l = left.slice();
  const r = right.slice();
  let result: {
    separated: { primary: Float32Array[]; sampleCount: number };
    resolvedDevice: string; timings: unknown;
  } | undefined;
  await new Promise<void>((resolveWorker, rejectWorker) => {
    const worker = new Worker(join(root, "artifacts/api-server/dist/waveyard-separation-worker.mjs"), {
      // Do not inherit tsx loader flags into the already-bundled production worker.
      execArgv: [],
      workerData: { spec, requestedDevice: "cpu", left: l.buffer, right: r.buffer },
      transferList: [l.buffer, r.buffer],
    });
    let failure: Error | undefined;
    const timeout = setTimeout(() => {
      failure = new Error(`${id} exceeded the 180-second audition deadline`);
      void worker.terminate();
    }, 180_000);
    worker.on("message", message => {
      if (message.type === "result") result = message;
      if (message.type === "progress") console.log(`MODEL_PROGRESS ${id} ${message.done}/${message.total}`);
      if (message.type === "error") failure = new Error(message.message);
    });
    worker.on("error", error => { failure = error; });
    worker.on("exit", code => {
      clearTimeout(timeout);
      if (failure) rejectWorker(failure);
      else if (code !== 0 || !result) rejectWorker(new Error(`${id} exited ${code} without audio`));
      else resolveWorker();
    });
  });
  assert.ok(result);
  assert.equal(result.separated.primary.length, 2);
  assert.equal(result.separated.primary[0].length, frames);
  assert.equal(result.separated.primary[1].length, frames);
  const interleaved = new Float32Array(frames * 2);
  let energy = 0, peak = 0, clipped = 0;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      const value = result.separated.primary[channel][frame];
      assert.ok(Number.isFinite(value), `${id} produced non-finite audio`);
      interleaved[frame * 2 + channel] = value;
      energy += value * value;
      peak = Math.max(peak, Math.abs(value));
      if (Math.abs(value) >= 0.999) clipped++;
    }
  }
  const wav = encodeWav16(interleaved, 44100);
  const filename = `${spec.primaryStem}-estimate.wav`;
  await writeFile(join(outputPath, filename), wav);
  const report = {
    id, modelSha256: spec.sha256, stemType: spec.primaryStem,
    filename, sha256: sha256(wav), frames, sampleRate: 44100,
    elapsedMs: Date.now() - started, resolvedDevice: result.resolvedDevice,
    cpuMemoryArena: SEPARATION_MEMORY_OPTIONS.enableCpuMemArena,
    memoryPattern: SEPARATION_MEMORY_OPTIONS.enableMemPattern,
    rmsDbfs: 20 * Math.log10(Math.max(1e-8, Math.sqrt(energy / (frames * 2)))),
    peakDbfs: 20 * Math.log10(Math.max(1e-8, peak)), clippedSamples: clipped,
    timings: result.timings,
  };
  reports.push(report);
  // Preserve completed passes even if a subsequent model fails.
  await writeFile(join(outputPath, "inference-report.json"), JSON.stringify({
    evidence: "Bundled production DSP worker only; no library/session API or database fixture.",
    inputSha256: sha256(await readFile(inputPath)), seconds: frames / 44100,
    platform: process.platform, models: reports,
  }, null, 2));
  console.log(`MODEL_COMPLETE ${JSON.stringify(report)}`);
}
