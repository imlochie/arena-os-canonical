import assert from "node:assert/strict";
import test from "node:test";

import { assertQualityReport, summarizePairedQuality } from "./waveyard-quality-comparison.mjs";

const stems = ["vocals", "drums", "bass", "other"];
const referenceSha256 = Object.fromEntries(stems.map((stem) => [stem, "a".repeat(64)]));

function run(mode, repetition, offset = 0) {
  const base = repetition + offset;
  const perStem = Object.fromEntries(
    stems.map((stem, index) => [
      stem,
      {
        siSdrDb: base + index,
        mixtureBaselineSiSdrDb: base + index - 1,
        siSdrImprovementDb: 1,
      },
    ]),
  );
  return {
    mode,
    repetition,
    result: {
      referenceEvaluation: {
        referenceSha256: { ...referenceSha256 },
        metrics: {
          referenceAlignment: {
            status: "verified",
            method: "reference-sum-cross-correlation",
            zeroLagCorrelation: 0.98,
            bestLagCorrelation: 0.98,
            bestOffsetFrames: 0,
            bestOffsetSeconds: 0,
            searchRangeSeconds: 5,
          },
          perStem,
          recombinedMixSiSdrDb: base,
          recombinedMixResidualSdrDb: base - 2,
          recombinedMixResidualRmsDbfs: -base,
        },
      },
    },
  };
}

test("paired quality summaries compare every stem and recombined metrics", () => {
  const runs = [
    run("sequential", 1),
    run("parallel", 1, 0.04),
    run("parallel", 2, 0.12),
    run("sequential", 2),
  ];
  const summary = summarizePairedQuality(runs);

  assert.deepEqual(summary.vocals.siSdrDb, {
    sequential: { median: 1.5, minimum: 1, maximum: 2, range: 1 },
    parallel: { median: 1.58, minimum: 1.04, maximum: 2.12, range: 1.08 },
    parallelMinusSequential: { median: 0.08, minimum: 0.04, maximum: 0.12, range: 0.08 },
  });
  assert.equal(summary.other.siSdrImprovementDb.parallelMinusSequential.median, 0);
  assert.equal(summary.recombinedMixResidualSdrDb.parallelMinusSequential.median, 0.08);
  assert.equal(summary.recombinedMixResidualRmsDbfs.parallelMinusSequential.median, -0.08);
});

test("multi-track quality summary preserves each track and exposes the pooled outlier range", () => {
  const runs = [
    { ...run("sequential", 1), trackId: "bks" },
    { ...run("parallel", 1, 0.1), trackId: "bks" },
    { ...run("sequential", 1, -20), trackId: "angels" },
    { ...run("parallel", 1, -19.5), trackId: "angels" },
  ];
  const summary = summarizePairedQuality(runs);

  assert.deepEqual(Object.keys(summary.perTrack), ["angels", "bks"]);
  assert.equal(
    summary.perTrack.angels.bass.siSdrDb.parallelMinusSequential.median,
    0.5,
    "the difficult track retains its own paired stem result",
  );
  assert.equal(
    summary.perTrack.bks.bass.siSdrDb.parallelMinusSequential.median,
    0.1,
    "the other track is reported independently",
  );
  assert.equal(
    summary.acrossTracks.bass.siSdrDb.parallelMinusSequential.minimum,
    0.1,
    "the pooled result still includes the lowest paired difference",
  );
  assert.equal(summary.acrossTracks.recombinedMixResidualSdrDb.parallelMinusSequential.maximum, 0.5);
});

test("quality reports require checksummed references and finite objective metrics", () => {
  const valid = run("sequential", 1);
  assert.equal(assertQualityReport(valid).perStem.vocals.siSdrDb, 1);

  const missingReferenceHash = run("sequential", 1);
  delete missingReferenceHash.result.referenceEvaluation.referenceSha256.bass;
  assert.throws(() => assertQualityReport(missingReferenceHash), /SHA-256 hashes/);

  const invalidMetric = run("parallel", 1);
  invalidMetric.result.referenceEvaluation.metrics.perStem.drums.siSdrDb = Number.NaN;
  assert.throws(() => assertQualityReport(invalidMetric), /finite drums.siSdrDb/);

  const missingAlignment = run("sequential", 1);
  delete missingAlignment.result.referenceEvaluation.metrics.referenceAlignment;
  assert.throws(() => assertQualityReport(missingAlignment), /alignment evidence/);

  const sampleCountOnly = run("sequential", 1);
  sampleCountOnly.result.referenceEvaluation.metrics.referenceAlignment = {
    status: "sample-count-only",
    method: "reference-sum-cross-correlation",
    zeroLagCorrelation: 0.01,
    bestLagCorrelation: 0.03,
    bestOffsetSeconds: 0.04,
  };
  assert.equal(assertQualityReport(sampleCountOnly).referenceAlignment.status, "sample-count-only");
});

test("paired CPU listening comparisons can omit reference-based metrics", () => {
  const runs = ["sequential", "parallel"].map((mode) => ({
    mode,
    repetition: 1,
    result: {},
  }));
  assert.equal(summarizePairedQuality(runs), null);
  assert.equal(assertQualityReport(runs[0]), null);
  assert.throws(
    () => summarizePairedQuality([runs[0], run("parallel", 1)]),
    /present for every paired run or none/,
  );
});

test("paired quality summaries reject incomplete or duplicate run pairs", () => {
  assert.throws(
    () => summarizePairedQuality([run("sequential", 1), run("parallel", 1), run("sequential", 2)]),
    /complete pairs|one sequential and one parallel/,
  );
  assert.throws(
    () => summarizePairedQuality([run("sequential", 1), run("parallel", 1), run("parallel", 1)]),
    /complete pairs|Duplicate/,
  );
});
