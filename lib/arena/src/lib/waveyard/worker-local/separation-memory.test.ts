import assert from "node:assert/strict";
import test from "node:test";

import {
  createSeparationActiveMemorySampler,
  SEPARATION_ACTIVE_MEMORY_SAMPLE_INTERVAL_MS,
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

test("production active memory sampler uses a bounded 250 ms interval", () => {
  assert.equal(SEPARATION_ACTIVE_MEMORY_SAMPLE_INTERVAL_MS, 250);
});
