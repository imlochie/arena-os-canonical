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

test("quality reports require checksummed references and finite objective metrics", () => {
  const valid = run("sequential", 1);
  assert.equal(assertQualityReport(valid).perStem.vocals.siSdrDb, 1);

  const missingReferenceHash = run("sequential", 1);
  delete missingReferenceHash.result.referenceEvaluation.referenceSha256.bass;
  assert.throws(() => assertQualityReport(missingReferenceHash), /SHA-256 hashes/);

  const invalidMetric = run("parallel", 1);
  invalidMetric.result.referenceEvaluation.metrics.perStem.drums.siSdrDb = Number.NaN;
  assert.throws(() => assertQualityReport(invalidMetric), /finite drums.siSdrDb/);
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
