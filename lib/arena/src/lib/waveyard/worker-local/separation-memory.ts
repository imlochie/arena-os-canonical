export type SeparationMemoryCounters = {
  /** Node reports RSS for the whole process, including every worker thread. */
  rss: number;
  /** The remaining counters describe the current worker thread's isolate. */
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

export type SeparationWorkerMemoryPeak = {
  sampleIntervalMs: number;
  sampleCount: number;
  elapsedMs: number;
  peak: SeparationMemoryCounters;
};

export type SeparationProcessRssPeak = {
  sampleIntervalMs: number;
  sampleCount: number;
  elapsedMs: number;
  peakRss: number;
};

export type SeparationActiveMemoryPeak = {
  workerSampleIntervalMs: number;
  workerSampleCount: number;
  processRssSampleIntervalMs: number;
  processRssSampleCount: number;
  elapsedMs: number;
  peak: SeparationMemoryCounters;
};

export const SEPARATION_ACTIVE_MEMORY_SAMPLE_INTERVAL_MS = 500;
export const SEPARATION_PROCESS_RSS_SAMPLE_INTERVAL_MS = 100;

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
  let result: SeparationWorkerMemoryPeak | undefined;

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
    /** Also sampled after each completed model chunk to cover blocked timers. */
    sampleNow: sample,
    stop(): SeparationWorkerMemoryPeak {
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

/** Parent-thread sampler: it can still run while ONNX blocks the worker loop. */
export function createSeparationProcessRssSampler(options: {
  intervalMs?: number;
  readRss?: () => number;
  now?: () => number;
} = {}) {
  const intervalMs = options.intervalMs ?? SEPARATION_PROCESS_RSS_SAMPLE_INTERVAL_MS;
  const readRss = options.readRss ?? (() => process.memoryUsage.rss());
  const now = options.now ?? Date.now;
  const startedAt = now();
  let sampleCount = 0;
  let peakRss = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let result: SeparationProcessRssPeak | undefined;

  const sample = () => {
    peakRss = Math.max(peakRss, readRss());
    sampleCount = Math.min(Number.MAX_SAFE_INTEGER, sampleCount + 1);
  };

  sample();
  timer = setInterval(sample, intervalMs);

  return {
    stop(): SeparationProcessRssPeak {
      if (result) return result;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      sample();
      result = {
        sampleIntervalMs: intervalMs,
        sampleCount,
        elapsedMs: Math.max(0, now() - startedAt),
        peakRss,
      };
      return result;
    },
  };
}

export function combineSeparationMemoryPeaks(
  worker: SeparationWorkerMemoryPeak,
  processRss: SeparationProcessRssPeak,
): SeparationActiveMemoryPeak {
  return {
    workerSampleIntervalMs: worker.sampleIntervalMs,
    workerSampleCount: worker.sampleCount,
    processRssSampleIntervalMs: processRss.sampleIntervalMs,
    processRssSampleCount: processRss.sampleCount,
    elapsedMs: Math.max(worker.elapsedMs, processRss.elapsedMs),
    peak: {
      ...worker.peak,
      rss: Math.max(worker.peak.rss, processRss.peakRss),
    },
  };
}
