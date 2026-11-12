export type SeparationMemoryCounters = {
  /** Node reports RSS for the whole process, including every worker thread. */
  rss: number;
  /** The remaining counters describe the current worker thread's isolate. */
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

export type SeparationActiveMemoryPeak = {
  sampleIntervalMs: number;
  sampleCount: number;
  elapsedMs: number;
  peak: SeparationMemoryCounters;
};

export const SEPARATION_ACTIVE_MEMORY_SAMPLE_INTERVAL_MS = 250;

function readMemoryCounters(): SeparationMemoryCounters {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { rss, heapUsed, external, arrayBuffers };
}

/**
 * Keep only per-counter maxima rather than retaining a history of samples.
 * RSS is process-wide in Node workers; heap/external/array-buffer counters are
 * for this worker's isolate. Sampling runs only for one model pass.
 */
export function createSeparationActiveMemorySampler(options: {
  intervalMs?: number;
  read?: () => SeparationMemoryCounters;
  now?: () => number;
} = {}) {
  const intervalMs = options.intervalMs ?? SEPARATION_ACTIVE_MEMORY_SAMPLE_INTERVAL_MS;
  const read = options.read ?? readMemoryCounters;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let sampleCount = 0;
  let peak: SeparationMemoryCounters | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let result: SeparationActiveMemoryPeak | undefined;

  const sample = () => {
    const current = read();
    sampleCount = Math.min(Number.MAX_SAFE_INTEGER, sampleCount + 1);
    if (peak === null) {
      peak = { ...current };
      return;
    }
    peak.rss = Math.max(peak.rss, current.rss);
    peak.heapUsed = Math.max(peak.heapUsed, current.heapUsed);
    peak.external = Math.max(peak.external, current.external);
    peak.arrayBuffers = Math.max(peak.arrayBuffers, current.arrayBuffers);
  };

  sample();
  timer = setInterval(sample, intervalMs);

  return {
    stop(): SeparationActiveMemoryPeak {
      if (result) return result;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      sample();
      result = {
        sampleIntervalMs: intervalMs,
        sampleCount,
        elapsedMs: Math.max(0, now() - startedAt),
        peak: peak!,
      };
      return result;
    },
  };
}
