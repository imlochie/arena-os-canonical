import assert from "node:assert/strict";
import test from "node:test";

import {
  createSeparationActiveMemorySampler,
  createSeparationProcessRssSampler,
  combineSeparationMemoryPeaks,
  SEPARATION_ACTIVE_MEMORY_SAMPLE_INTERVAL_MS,
  SEPARATION_PROCESS_RSS_SAMPLE_INTERVAL_MS,
  type SeparationMemoryCounters,
} from "./separation-memory";

test("active separation memory sampler retains bounded per-counter peaks", async () => {
  const readings: SeparationMemoryCounters[] = [
    { rss: 100, heapUsed: 20, external: 30, arrayBuffers: 10 },
    { rss: 140, heapUsed: 18, external: 42, arrayBuffers: 12 },
    { rss: 130, heapUsed: 27, external: 35, arrayBuffers: 18 },
  ];
  let index = 0;
  const sampler = createSeparationActiveMemorySampler({
    intervalMs: 5,
    read: () => readings[Math.min(index++, readings.length - 1)]!,
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const report = sampler.stop();
  assert.deepEqual(report.peak, {
    rss: 140,
    heapUsed: 27,
    external: 42,
    arrayBuffers: 18,
  });
  assert.ok(report.sampleCount >= 3);
  assert.equal(report.sampleIntervalMs, 5);
  assert.ok(report.elapsedMs >= 15);
  assert.deepEqual(Object.keys(report).sort(), ["elapsedMs", "peak", "sampleCount", "sampleIntervalMs"]);
  assert.deepEqual(Object.keys(report.peak).sort(), ["arrayBuffers", "external", "heapUsed", "rss"]);
  assert.deepEqual(sampler.stop(), report, "stopping twice returns the same bounded summary");
});

test("production active memory samplers use bounded intervals", () => {
  assert.equal(SEPARATION_ACTIVE_MEMORY_SAMPLE_INTERVAL_MS, 500);
  assert.equal(SEPARATION_PROCESS_RSS_SAMPLE_INTERVAL_MS, 100);
});

test("process RSS sampler captures the active worker independently of its event loop", async () => {
  const values = [100, 160, 140];
  let index = 0;
  const sampler = createSeparationProcessRssSampler({
    intervalMs: 5,
    readRss: () => values[Math.min(index++, values.length - 1)]!,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const report = sampler.stop();
  assert.equal(report.peakRss, 160);
  assert.ok(report.sampleCount >= 3);
  assert.equal(report.sampleIntervalMs, 5);
});

test("combined active report uses independent process RSS and worker-isolate counters", () => {
  const report = combineSeparationMemoryPeaks(
    {
      sampleIntervalMs: 500,
      sampleCount: 4,
      elapsedMs: 1_000,
      peak: { rss: 120, heapUsed: 22, external: 30, arrayBuffers: 8 },
    },
    { sampleIntervalMs: 100, sampleCount: 12, elapsedMs: 1_100, peakRss: 180 },
  );
  assert.deepEqual(report, {
    workerSampleIntervalMs: 500,
    workerSampleCount: 4,
    processRssSampleIntervalMs: 100,
    processRssSampleCount: 12,
    elapsedMs: 1_100,
    peak: { rss: 180, heapUsed: 22, external: 30, arrayBuffers: 8 },
  });
});
