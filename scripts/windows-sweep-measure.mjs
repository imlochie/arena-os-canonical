#!/usr/bin/env node
/**
 * Windows-side measurement for the 2026-10-23 speed/bug sweep. Informational.
 *
 * The sweep's speed claims were measured on Linux with the shipped functions.
 * This runs the same two measurements on the Windows runner — the platform the
 * claims are actually about — and reports them three ways: a GitHub annotation
 * (readable through the API when the job-log blob host is unreachable), the
 * child's stdout, and windows-evidence/sweep-measurement.json for the job's
 * artifact.
 *
 * What it measures, with the production code, not a copy:
 *   - checksumFile on a 64 MiB file at the shipped 1 MiB read buffer, and the
 *     same function's work at the old 64 KiB default;
 *   - getModelFileStatus on that file: the first call (which must hash it) and
 *     the steady state that /api/waveyard/separation/models pays every 2 s.
 *
 * It never asserts a threshold and never fails the job: `continue-on-error` on
 * the step and exit 0 here. A slow or noisy runner must not turn a speed
 * measurement into a gate, and a number that only holds on a fast runner is not
 * evidence — the comparison between the two buffer sizes is.
 */
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";

import { checksumFile } from "../src/lib/waveyard/audio.ts";
import { findMdxModel } from "../src/lib/waveyard/separation/mdx.ts";
import { getModelFileStatus } from "../src/lib/waveyard/separation/seed.ts";

const MB = 1024 * 1024;
const SIZE = 64 * MB;
const PASSES = 3;
const POLLS = 20;

/** The pre-sweep implementation, kept here so both buffer sizes are measured
 *  on the same machine in the same conditions. */
async function checksumAt(file, highWaterMark) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) =>
    createReadStream(file, highWaterMark ? { highWaterMark } : undefined)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve),
  );
  return hash.digest("hex");
}

async function timeAverage(fn, passes) {
  const samples = [];
  for (let i = 0; i < passes; i += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function annotate(level, title, message) {
  // A newline inside a workflow command would end the annotation, so the
  // summary is one line by construction.
  console.log(`::${level} title=${title}::${String(message).replaceAll("\n", " ").slice(0, 60000)}`);
}

async function measure() {
  const dir = await mkdtemp(join(tmpdir(), "sweep-measure-"));
  try {
    const file = join(dir, "model.onnx");
    // Distinct bytes, not zeros: a zero-filled file can be short-circuited by a
    // filesystem or a scanner, which would flatter both numbers.
    const block = Buffer.alloc(MB);
    for (let i = 0; i < block.length; i += 1) block[i] = (i * 31 + 7) & 0xff;
    const handle = await open(file, "w");
    try {
      for (let written = 0; written < SIZE; written += block.length) await handle.write(block);
    } finally {
      await handle.close();
    }
    const info = await stat(file);

    // Warm the page cache so the first measurement is not disk I/O.
    await checksumAt(file, 64 * 1024);
    await checksumAt(file, MB);

    const oldBufferMs = await timeAverage(() => checksumAt(file, 64 * 1024), PASSES);
    const shippedMs = await timeAverage(() => checksumFile(file), PASSES);
    const oneMiBLocalMs = await timeAverage(() => checksumAt(file, MB), PASSES);

    const spec = {
      ...findMdxModel("kim_vocal_2"),
      file: "model.onnx",
      sha256: await checksumFile(file),
      sizeBytes: info.size,
    };
    const coldStarted = performance.now();
    const cold = await getModelFileStatus(spec, dir);
    const coldMs = performance.now() - coldStarted;
    const steadyMs = await timeAverage(() => getModelFileStatus(spec, dir), POLLS);

    const cpu = cpus()[0];
    return {
      platform: process.platform,
      arch: process.arch,
      // Throughput on a shared hosted runner is only interpretable next to the
      // machine it was measured on; the buffer-size comparison is the part
      // that does not depend on the host.
      cpu: cpu ? cpu.model.trim() : "unknown",
      cores: cpus().length,
      node: process.version,
      sizeMiB: info.size / MB,
      checksum64KiBBufferMs: Number(oldBufferMs.toFixed(1)),
      checksum1MiBBufferMs: Number(oneMiBLocalMs.toFixed(1)),
      checksumShippedMs: Number(shippedMs.toFixed(1)),
      statusColdMs: Number(coldMs.toFixed(1)),
      statusColdVerified: cold.verified,
      statusSteadyPollMs: Number(steadyMs.toFixed(2)),
      fourModelPollBeforeMs: Number((oldBufferMs * 4).toFixed(0)),
      fourModelPollAfterMs: Number((steadyMs * 4).toFixed(2)),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let summary;
try {
  summary = await measure();
  console.log(`[sweep-measure] ${JSON.stringify(summary)}`);
  annotate("warning", "Windows sweep measurement", JSON.stringify(summary));
} catch (error) {
  summary = { error: error instanceof Error ? error.message : String(error) };
  console.log(`[sweep-measure] failed: ${JSON.stringify(summary)}`);
  annotate("warning", "Windows sweep measurement failed", JSON.stringify(summary));
}

try {
  await mkdir("windows-evidence", { recursive: true });
  await writeFile("windows-evidence/sweep-measurement.json", `${JSON.stringify(summary, null, 2)}\n`);
} catch {
  /* the annotation above is the primary channel */
}
