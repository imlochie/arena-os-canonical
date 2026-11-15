export const LIVE_STEM_TIMING_SAMPLE_COUNT = 5;

// Budgets are for the median of five observed browser timings, not one sample.
// A single noisy runner sample therefore cannot fail the job.
export const LIVE_STEM_AUDIBLE_LATENCY_BUDGETS_MS = Object.freeze({
  chromium: Object.freeze({ nativeTempo: 900, tempoMatched: 1_200 }),
  webkit: Object.freeze({ nativeTempo: 750, tempoMatched: 1_200 }),
  firefox: Object.freeze({ nativeTempo: 600, tempoMatched: 900 }),
});

const TIMED_MODES = ["nativeTempo", "tempoMatched"];

export function median(values) {
  if (!Array.isArray(values) || values.length === 0
    || values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new Error("Timing samples must be a non-empty array of finite, non-negative numbers.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function evaluateLiveStemTimingBudget(browserEngine, timings) {
  const budgets = LIVE_STEM_AUDIBLE_LATENCY_BUDGETS_MS[browserEngine];
  if (!budgets) throw new Error(`No live-stem timing budget is defined for "${browserEngine}".`);

  const modes = {};
  const failures = [];
  for (const mode of TIMED_MODES) {
    const samples = timings?.[mode];
    if (!Array.isArray(samples) || samples.length !== LIVE_STEM_TIMING_SAMPLE_COUNT) {
      failures.push(`${mode} needs exactly ${LIVE_STEM_TIMING_SAMPLE_COUNT} samples; received ${samples?.length ?? 0}`);
      continue;
    }
    const observed = samples.map((sample) => sample?.observedSelectionToAudibleMs);
    if (observed.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      failures.push(`${mode} contains a missing or invalid observed selection-to-audible measurement`);
      continue;
    }
    const medianMs = Math.round(median(observed) * 10) / 10;
    const budgetMs = budgets[mode];
    modes[mode] = {
      sampleCount: observed.length,
      observedSelectionToAudibleMedianMs: medianMs,
      budgetMs,
      passed: medianMs <= budgetMs,
    };
    if (medianMs > budgetMs) {
      failures.push(`${mode} median ${medianMs}ms exceeds the ${budgetMs}ms budget`);
    }
  }

  return {
    browserEngine,
    sampleCount: LIVE_STEM_TIMING_SAMPLE_COUNT,
    modes,
    failures,
    passed: failures.length === 0,
  };
}

export function assertLiveStemTimingBudget(browserEngine, timings) {
  const result = evaluateLiveStemTimingBudget(browserEngine, timings);
  if (!result.passed) {
    throw new Error(`${browserEngine} live-stem latency budget failed: ${result.failures.join("; ")}`);
  }
  return result;
}
