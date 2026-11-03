import assert from "node:assert/strict";

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertFiniteTimings(timings, label) {
  assert.ok(
    timings && typeof timings === "object" && !Array.isArray(timings),
    `${label} must be a timing object.`,
  );
  const stages = sortedKeys(timings);
  assert.ok(stages.length > 0, `${label} must contain at least one timing stage.`);
  for (const stage of stages) {
    assert.ok(
      Number.isFinite(timings[stage]) && timings[stage] >= 0,
      `${label}.${stage} must be a finite, non-negative number.`,
    );
  }
  return stages;
}

function assertMatchingKeys(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label} must match across every paired run.`);
}

export function summarize(values) {
  assert.ok(Array.isArray(values) && values.length > 0, "At least one measurement is required.");
  for (const value of values) {
    assert.ok(Number.isFinite(value) && value >= 0, "Measurements must be finite, non-negative numbers.");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  const minimum = sorted[0];
  const maximum = sorted.at(-1);
  return {
    median: Number(median.toFixed(1)),
    minimum,
    maximum,
    range: Number((maximum - minimum).toFixed(1)),
  };
}

export function validatePairedRuns(runs, modes, repetitions) {
  assert.ok(Array.isArray(runs), "Benchmark runs must be an array.");
  assert.ok(Array.isArray(modes) && modes.length >= 2, "At least two execution modes are required.");
  assert.ok(Number.isInteger(repetitions) && repetitions >= 2, "At least two repetitions are required.");
  for (const mode of modes) {
    const count = runs.filter((run) => run.mode === mode).length;
    assert.equal(
      count,
      repetitions,
      `${mode} has ${count} repetitions; expected ${repetitions} before comparison output can be written.`,
    );
  }
  assert.equal(
    runs.length,
    modes.length * repetitions,
    `Expected ${modes.length * repetitions} complete benchmark runs, received ${runs.length}.`,
  );

  const modeSet = new Set(modes);
  const runKeys = new Set();
  let referenceStageKeys;
  let referenceModelIds;
  let referenceModelStageKeys;

  for (const run of runs) {
    assert.ok(modeSet.has(run.mode), `Unexpected benchmark mode ${String(run.mode)}.`);
    assert.ok(
      Number.isInteger(run.repetition) && run.repetition >= 1 && run.repetition <= repetitions,
      `Invalid repetition ${String(run.repetition)} for ${run.mode}.`,
    );
    const runKey = `${run.mode}:${run.repetition}`;
    assert.ok(!runKeys.has(runKey), `Duplicate benchmark run ${runKey}.`);
    runKeys.add(runKey);

    assert.ok(Number.isFinite(run.result?.elapsedMs) && run.result.elapsedMs >= 0, `${runKey} elapsedMs must be finite.`);
    assert.ok(
      Number.isFinite(run.timings?.maxPlaybackTimerGapMs) && run.timings.maxPlaybackTimerGapMs >= 0,
      `${runKey} maxPlaybackTimerGapMs must be finite.`,
    );
    assert.ok(
      Number.isSafeInteger(run.timings?.progressSamplingIntervalMs) && run.timings.progressSamplingIntervalMs > 0,
      `${runKey} progressSamplingIntervalMs must be a positive integer.`,
    );
    const stageKeys = assertFiniteTimings(run.timings?.inferenceStageTotals, `${runKey} inferenceStageTotals`);
    const modelEntries = run.timings?.modelInferenceStages;
    assert.ok(Array.isArray(modelEntries) && modelEntries.length > 0, `${runKey} must include model timing passes.`);
    const modelIds = modelEntries.map((entry) => entry?.model);
    assert.ok(
      modelIds.every((model) => typeof model === "string" && model.length > 0),
      `${runKey} model timing passes must have model identifiers.`,
    );
    assert.equal(new Set(modelIds).size, modelIds.length, `${runKey} must not contain duplicate model passes.`);
    const pinnedModelIds = run.models?.map((model) => model?.id);
    assert.ok(
      Array.isArray(pinnedModelIds) &&
        pinnedModelIds.length > 0 &&
        pinnedModelIds.every((model) => typeof model === "string" && model.length > 0),
      `${runKey} must include the pinned model list.`,
    );
    assertMatchingKeys(
      [...modelIds].sort(),
      [...pinnedModelIds].sort(),
      `${runKey} model timing passes must match the pinned model list`,
    );

    const modelIdsSorted = [...modelIds].sort();
    const modelStageKeys = Object.fromEntries(
      modelEntries.map((entry) => [
        entry.model,
        assertFiniteTimings(entry.timings, `${runKey} model ${entry.model} timings`),
      ]),
    );
    if (!referenceStageKeys) {
      referenceStageKeys = stageKeys;
      referenceModelIds = modelIdsSorted;
      referenceModelStageKeys = modelStageKeys;
    } else {
      assertMatchingKeys(stageKeys, referenceStageKeys, `${runKey} inference stages`);
      assertMatchingKeys(modelIdsSorted, referenceModelIds, `${runKey} model passes`);
      for (const model of referenceModelIds) {
        assertMatchingKeys(
          modelStageKeys[model],
          referenceModelStageKeys[model],
          `${runKey} model ${model} timing stages`,
        );
      }
    }
  }

  for (const mode of modes) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      assert.ok(runKeys.has(`${mode}:${repetition}`), `Missing benchmark run ${mode}:${repetition}.`);
    }
  }
}

export function progressSamplingIntervalsByRun(runs) {
  assert.ok(Array.isArray(runs), "Benchmark runs must be an array.");
  return runs.map((run) => {
    const intervalMs = run.timings?.progressSamplingIntervalMs;
    assert.ok(
      Number.isSafeInteger(intervalMs) && intervalMs > 0,
      `${run.mode}:${run.repetition} progressSamplingIntervalMs must be a positive integer.`,
    );
    assert.ok(typeof run.trackId === "string" && run.trackId.length > 0, "Each run must identify its track.");
    return {
      trackId: run.trackId,
      mode: run.mode,
      repetition: run.repetition,
      intervalMs,
    };
  });
}

export function buildPairedBenchmarkReportContract(runs) {
  return {
    schemaVersion: 4,
    timingEvidence: {
      completePerModelTimings:
        "Each run's timings.modelInferenceStages comes from the authoritative inference callback and is validated against every pinned model.",
      sampledProgressTimings:
        "Each run's timings.sampledProgressModelPasses is approximate polling data; its interval is recorded per run below and in runs[].timings.progressSamplingIntervalMs. A shorter pass may be absent and does not invalidate a run.",
      progressSamplingIntervalsByRun: progressSamplingIntervalsByRun(runs),
    },
  };
}

export function summarizeStageTotals(modeRuns) {
  const stages = sortedKeys(modeRuns[0].timings.inferenceStageTotals);
  return Object.fromEntries(
    stages.map((stage) => [
      stage,
      summarize(modeRuns.map((run) => run.timings.inferenceStageTotals[stage])),
    ]),
  );
}

export function summarizeModelStages(modeRuns) {
  const modelIds = modeRuns[0].timings.modelInferenceStages.map((entry) => entry.model);
  return Object.fromEntries(
    modelIds.map((model) => {
      const stages = sortedKeys(
        modeRuns[0].timings.modelInferenceStages.find((entry) => entry.model === model).timings,
      );
      return [
        model,
        Object.fromEntries(
          stages.map((stage) => [
            stage,
            summarize(
              modeRuns.map((run) =>
                run.timings.modelInferenceStages.find((entry) => entry.model === model).timings[stage],
              ),
            ),
          ]),
        ),
      ];
    }),
  );
}
