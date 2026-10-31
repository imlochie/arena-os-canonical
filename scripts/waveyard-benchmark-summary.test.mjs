import assert from "node:assert/strict";
import test from "node:test";
import {
  summarize,
  summarizeModelStages,
  summarizeStageTotals,
  validatePairedRuns,
} from "./waveyard-benchmark-summary.mjs";

function run(mode, repetition, value, model = "vocal") {
  return {
    mode,
    repetition,
    models: [{ id: model, sha256: "a".repeat(64) }],
    result: { elapsedMs: value * 10 },
    timings: {
      maxPlaybackTimerGapMs: value,
      inferenceStageTotals: { inferenceMs: value, stftMs: value * 2 },
      modelInferenceStages: [
        { model, timings: { inferenceMs: value, stftMs: value * 2, chunkCount: 1 } },
      ],
    },
  };
}

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
