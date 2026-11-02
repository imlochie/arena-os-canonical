import assert from "node:assert/strict";

const modes = ["sequential", "parallel"];
const stems = ["vocals", "drums", "bass", "other"];
const perStemMetrics = [
  "siSdrDb",
  "mixtureBaselineSiSdrDb",
  "siSdrImprovementDb",
];
const recombinationMetrics = [
  "recombinedMixSiSdrDb",
  "recombinedMixResidualSdrDb",
  "recombinedMixResidualRmsDbfs",
];

function summarize(values) {
  assert.ok(values.length > 0, "Quality summaries need at least one measurement.");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  const minimum = sorted[0];
  const maximum = sorted.at(-1);
  return {
    median: Number(median.toFixed(2)),
    minimum: Number(minimum.toFixed(2)),
    maximum: Number(maximum.toFixed(2)),
    range: Number((maximum - minimum).toFixed(2)),
  };
}

export function assertQualityReport(run) {
  const evaluation = run.result.referenceEvaluation;
  const metrics = evaluation?.metrics;
  if (!evaluation && !metrics) return null;
  assert.ok(metrics, `${run.mode} run has incomplete reference-based quality metrics.`);
  assert.ok(
    stems.every((stem) =>
      typeof evaluation.referenceSha256?.[stem] === "string" &&
      /^[a-f0-9]{64}$/i.test(evaluation.referenceSha256[stem]),
    ),
    `${run.mode} run must include SHA-256 hashes for all four reference stems.`,
  );
  for (const stem of stems) {
    for (const name of perStemMetrics) {
      assert.ok(
        Number.isFinite(metrics.perStem?.[stem]?.[name]),
        `${run.mode} run must report finite ${stem}.${name}.`,
      );
    }
  }
  for (const name of recombinationMetrics) {
    assert.ok(Number.isFinite(metrics[name]), `${run.mode} run must report finite ${name}.`);
  }
  return metrics;
}

export function summarizePairedQuality(runs) {
  const trackIds = runs.map((run) => run.trackId);
  if (trackIds.some((trackId) => trackId !== undefined)) {
    assert.ok(
      trackIds.every((trackId) => typeof trackId === "string" && trackId.length > 0),
      "Every multi-track quality run must include a trackId.",
    );
    const groupedRuns = new Map();
    for (const run of runs) {
      const group = groupedRuns.get(run.trackId) ?? [];
      group.push(run);
      groupedRuns.set(run.trackId, group);
    }
    const orderedTracks = [...groupedRuns.entries()].sort(([left], [right]) => left.localeCompare(right));
    const perTrack = Object.fromEntries(
      orderedTracks.map(([trackId, trackRuns]) => [
        trackId,
        summarizePairedQuality(trackRuns.map(({ trackId: _id, ...run }) => run)),
      ]),
    );
    const maxRepetitions = Math.max(
      ...orderedTracks.map(([, trackRuns]) => new Set(trackRuns.map((run) => run.repetition)).size),
    );
    const acrossTrackRuns = orderedTracks.flatMap(([, trackRuns], trackIndex) =>
      trackRuns.map(({ trackId: _id, ...run }) => ({
        ...run,
        repetition: trackIndex * maxRepetitions + run.repetition,
      })),
    );
    return {
      perTrack,
      acrossTracks: summarizePairedQuality(acrossTrackRuns),
    };
  }
  assert.ok(runs.length > 0 && runs.length % modes.length === 0, "Quality runs must form complete pairs.");
  const hasReferenceEvaluation = runs.map((run) => Boolean(run.result.referenceEvaluation));
  assert.ok(
    hasReferenceEvaluation.every(Boolean) || hasReferenceEvaluation.every((included) => !included),
    "Reference-based quality data must be present for every paired run or none.",
  );
  if (hasReferenceEvaluation.every((included) => !included)) return null;
  const byModeAndRepetition = new Map();
  for (const run of runs) {
    assert.ok(modes.includes(run.mode), `Unexpected execution mode: ${run.mode}.`);
    assert.ok(Number.isInteger(run.repetition), "Each quality run needs an integer repetition.");
    assertQualityReport(run);
    const key = `${run.mode}:${run.repetition}`;
    assert.ok(!byModeAndRepetition.has(key), `Duplicate ${key} quality run.`);
    byModeAndRepetition.set(key, run);
  }
  const repetitions = [...new Set(runs.map((run) => run.repetition))].sort((a, b) => a - b);
  assert.equal(
    runs.length,
    repetitions.length * modes.length,
    "Every repetition must have one sequential and one parallel quality result.",
  );
  for (const repetition of repetitions) {
    for (const mode of modes) {
      assert.ok(byModeAndRepetition.has(`${mode}:${repetition}`), `Missing ${mode} repetition ${repetition}.`);
    }
  }

  const metricSummary = (selector) => {
    const values = Object.fromEntries(
      modes.map((mode) => [
        mode,
        repetitions.map((repetition) =>
          selector(assertQualityReport(byModeAndRepetition.get(`${mode}:${repetition}`))),
        ),
      ]),
    );
    const deltas = repetitions.map((repetition) => {
      const sequential = assertQualityReport(byModeAndRepetition.get(`sequential:${repetition}`));
      const parallel = assertQualityReport(byModeAndRepetition.get(`parallel:${repetition}`));
      return selector(parallel) - selector(sequential);
    });
    return {
      sequential: summarize(values.sequential),
      parallel: summarize(values.parallel),
      parallelMinusSequential: summarize(deltas),
    };
  };

  const result = {};
  for (const stem of stems) {
    result[stem] = Object.fromEntries(
      perStemMetrics.map((name) => [
        name,
        metricSummary((metrics) => metrics.perStem[stem][name]),
      ]),
    );
  }
  for (const name of recombinationMetrics) {
    result[name] = metricSummary((metrics) => metrics[name]);
  }
  return result;
}
