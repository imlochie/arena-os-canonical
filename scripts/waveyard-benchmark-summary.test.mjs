import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPairedBenchmarkReportContract,
  summarize,
  summarizeModelStages,
  progressSamplingIntervalsByRun,
  summarizeStageTotals,
  validatePairedRuns,
} from "./waveyard-benchmark-summary.mjs";

function run(mode, repetition, value, model = "vocal", intervalMs = 500, trackId = "fixture-track") {
  return {
    trackId,
    mode,
    repetition,
    models: [{ id: model, sha256: "a".repeat(64) }],
    result: { elapsedMs: value * 10 },
    timings: {
      maxPlaybackTimerGapMs: value,
      progressSamplingIntervalMs: intervalMs,
      inferenceStageTotals: { inferenceMs: value, stftMs: value * 2 },
      modelInferenceStages: [
        { model, timings: { inferenceMs: value, stftMs: value * 2, chunkCount: 1 } },
      ],
    },
  };
}

function runWithPinnedModels(mode, repetition, value) {
  const measurement = run(mode, repetition, value);
  const modelIds = ["vocals", "drums", "bass", "other"];
  measurement.models = modelIds.map((id) => ({ id, sha256: "a".repeat(64) }));
  measurement.timings.modelInferenceStages = modelIds.map((model, index) => ({
    model,
    timings: { inferenceMs: value + index, stftMs: value * 2 + index, chunkCount: 1 },
  }));
  return measurement;
}

test("paired timing metadata retains each run's recorded progress polling interval", () => {
  const runs = [
    run("sequential", 1, 1, "vocal", 250, "track-a"),
    run("sequential", 2, 2, "vocal", 500, "track-a"),
    run("parallel", 1, 3, "vocal", 750, "track-b"),
  ];

  assert.deepEqual(progressSamplingIntervalsByRun(runs), [
    { trackId: "track-a", mode: "sequential", repetition: 1, intervalMs: 250 },
    { trackId: "track-a", mode: "sequential", repetition: 2, intervalMs: 500 },
    { trackId: "track-b", mode: "parallel", repetition: 1, intervalMs: 750 },
  ]);
  assert.throws(
    () => progressSamplingIntervalsByRun([run("sequential", 1, 1, "vocal", 0)]),
    /progressSamplingIntervalMs must be a positive integer/,
  );
});

test("paired report contract pins schema version and timing-source labels", () => {
  const contract = buildPairedBenchmarkReportContract([
    run("sequential", 1, 1, "vocal", 250, "track-a"),
    run("parallel", 1, 2, "vocal", 500, "track-b"),
  ]);

  assert.equal(contract.schemaVersion, 4);
  assert.equal(
    contract.timingEvidence.completePerModelTimings,
    "Each run's timings.modelInferenceStages comes from the authoritative inference callback and is validated against every pinned model.",
  );
  assert.equal(
    contract.timingEvidence.sampledProgressTimings,
    "Each run's timings.sampledProgressModelPasses is approximate polling data; its interval is recorded per run below and in runs[].timings.progressSamplingIntervalMs. A shorter pass may be absent and does not invalidate a run.",
  );
  assert.deepEqual(contract.timingEvidence.progressSamplingIntervalsByRun, [
    { trackId: "track-a", mode: "sequential", repetition: 1, intervalMs: 250 },
    { trackId: "track-b", mode: "parallel", repetition: 1, intervalMs: 500 },
  ]);
});

test("paired comparison accepts incomplete sampled passes but requires every pinned model timing", () => {
  const incompleteProgressRuns = [
    runWithPinnedModels("sequential", 1, 1),
    runWithPinnedModels("sequential", 2, 2),
    runWithPinnedModels("parallel", 1, 3),
    runWithPinnedModels("parallel", 2, 4),
  ];
  incompleteProgressRuns[0].timings.sampledProgressModelPasses = [{ model: "vocals", elapsedMs: 5 }];
  incompleteProgressRuns[1].timings.sampledProgressModelPasses = [];
  incompleteProgressRuns[2].timings.sampledProgressModelPasses = [{ model: "bass", elapsedMs: 3 }];
  incompleteProgressRuns[3].timings.sampledProgressModelPasses = [];
  assert.doesNotThrow(() => validatePairedRuns(incompleteProgressRuns, ["sequential", "parallel"], 2));

  const missingAuthoritativePasses = [
    runWithPinnedModels("sequential", 1, 1),
    runWithPinnedModels("sequential", 2, 2),
    runWithPinnedModels("parallel", 1, 3),
    runWithPinnedModels("parallel", 2, 4),
  ];
  missingAuthoritativePasses[0].timings.modelInferenceStages =
    missingAuthoritativePasses[0].timings.modelInferenceStages.filter((entry) => entry.model !== "other");
  assert.throws(
    () => validatePairedRuns(missingAuthoritativePasses, ["sequential", "parallel"], 2),
    /model timing passes must match the pinned model list/,
  );
});

test("summaries calculate median, minimum, maximum, and range from repeated values", () => {
  assert.deepEqual(summarize([3, 1, 5]), {
    median: 3,
    minimum: 1,
    maximum: 5,
    range: 4,
  });
  assert.deepEqual(summarize([4, 1, 3, 2]), {
    median: 2.5,
    minimum: 1,
    maximum: 4,
    range: 3,
  });

  const repeatedRuns = [run("sequential", 1, 1), run("sequential", 2, 3)];
  assert.deepEqual(summarizeStageTotals(repeatedRuns), {
    inferenceMs: { median: 2, minimum: 1, maximum: 3, range: 2 },
    stftMs: { median: 4, minimum: 2, maximum: 6, range: 4 },
  });
  assert.deepEqual(summarizeModelStages(repeatedRuns), {
    vocal: {
      inferenceMs: { median: 2, minimum: 1, maximum: 3, range: 2 },
      stftMs: { median: 4, minimum: 2, maximum: 6, range: 4 },
      chunkCount: { median: 1, minimum: 1, maximum: 1, range: 0 },
    },
  });
});

test("paired validation rejects a missing run before summaries can be written", () => {
  const incomplete = [
    run("sequential", 1, 1),
    run("sequential", 2, 2),
    run("parallel", 1, 3),
  ];
  assert.throws(
    () => validatePairedRuns(incomplete, ["sequential", "parallel"], 2),
    /parallel has 1 repetitions; expected 2/,
  );
});

test("paired validation rejects missing model passes and mismatched model identifiers", () => {
  const missingModelPass = run("parallel", 2, 4);
  missingModelPass.timings.modelInferenceStages = [];
  assert.throws(
    () => validatePairedRuns(
      [run("sequential", 1, 1), run("sequential", 2, 2), run("parallel", 1, 3), missingModelPass],
      ["sequential", "parallel"],
      2,
    ),
    /must include model timing passes/,
  );

  assert.throws(
    () => validatePairedRuns(
      [run("sequential", 1, 1), run("sequential", 2, 2), run("parallel", 1, 3), run("parallel", 2, 4, "drums")],
      ["sequential", "parallel"],
      2,
    ),
    /model passes must match/,
  );
});

test("paired validation rejects a pinned model omitted from every timing run", () => {
  const runs = [
    run("sequential", 1, 1),
    run("sequential", 2, 2),
    run("parallel", 1, 3),
    run("parallel", 2, 4),
  ];
  for (const measurement of runs) {
    measurement.models.push({ id: "drums", sha256: "b".repeat(64) });
  }
  assert.throws(
    () => validatePairedRuns(runs, ["sequential", "parallel"], 2),
    /model timing passes must match the pinned model list/,
  );
});

test("paired validation rejects missing, mismatched, and non-finite timing stages", () => {
  const missingStage = run("parallel", 2, 4);
  delete missingStage.timings.inferenceStageTotals.stftMs;
  assert.throws(
    () => validatePairedRuns(
      [run("sequential", 1, 1), run("sequential", 2, 2), run("parallel", 1, 3), missingStage],
      ["sequential", "parallel"],
      2,
    ),
    /inference stages must match/,
  );

  const missingModelStage = run("parallel", 2, 4);
  delete missingModelStage.timings.modelInferenceStages[0].timings.stftMs;
  assert.throws(
    () => validatePairedRuns(
      [run("sequential", 1, 1), run("sequential", 2, 2), run("parallel", 1, 3), missingModelStage],
      ["sequential", "parallel"],
      2,
    ),
    /timing stages must match/,
  );

  const invalidTiming = run("parallel", 2, 4);
  invalidTiming.timings.inferenceStageTotals.stftMs = Number.NaN;
  assert.throws(
    () => validatePairedRuns(
      [run("sequential", 1, 1), run("sequential", 2, 2), run("parallel", 1, 3), invalidTiming],
      ["sequential", "parallel"],
      2,
    ),
    /must be a finite, non-negative number/,
  );
});

test("paired validation rejects different per-mode repetition counts", () => {
  assert.throws(
    () => validatePairedRuns(
      [run("sequential", 1, 1), run("sequential", 2, 2), run("sequential", 1, 3), run("parallel", 1, 4)],
      ["sequential", "parallel"],
      2,
    ),
    /sequential has 3 repetitions; expected 2/,
  );
});
