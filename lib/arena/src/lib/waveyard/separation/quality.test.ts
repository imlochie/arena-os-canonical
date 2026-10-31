import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFourStemSeparation, siSdrDb, type FourStemSamples } from "./quality";

test("SI-SDR is scale invariant and distinguishes a clean estimate from the mixture", () => {
  const reference = Float32Array.from([1, -1, 0.5, -0.5, 0.25, -0.25]);
  const scaled = Float32Array.from(reference, (sample) => sample * 0.4);
  assert.ok(siSdrDb(reference, scaled) > 100);
  assert.throws(() => siSdrDb(reference, new Float32Array(2)), /aligned buffers/);
});

test("four-stem evaluation reports reference improvement and recombination error", () => {
  const references: FourStemSamples = {
    vocals: Float32Array.from([0.4, -0.4, 0.2, -0.2]),
    drums: Float32Array.from([0.3, 0.3, -0.3, -0.3]),
    bass: Float32Array.from([0.1, -0.1, 0.1, -0.1]),
    other: Float32Array.from([0.2, 0.2, 0.2, 0.2]),
  };
  const mixture = new Float32Array(4);
  for (const name of ["vocals", "drums", "bass", "other"] as const) {
    for (let index = 0; index < mixture.length; index += 1) mixture[index] += references[name][index];
  }
  const estimates: FourStemSamples = {
    vocals: Float32Array.from(references.vocals),
    drums: Float32Array.from(references.drums),
    bass: Float32Array.from(references.bass),
    other: Float32Array.from(references.other),
  };

  const metrics = evaluateFourStemSeparation(mixture, references, estimates);
  assert.deepEqual(Object.keys(metrics.perStem).sort(), ["bass", "drums", "other", "vocals"]);
  for (const stem of Object.values(metrics.perStem)) assert.ok(stem.siSdrImprovementDb > 0);
  assert.ok(metrics.recombinedMixResidualSdrDb > 100);
  assert.ok(metrics.recombinedMixResidualRmsDbfs < -100);
});

test("four-stem evaluation rejects unaligned buffers and invalid edge trims", () => {
  const emptyStem = new Float32Array(4);
  const stems: FourStemSamples = { vocals: emptyStem, drums: emptyStem, bass: emptyStem, other: emptyStem };
  assert.throws(() => evaluateFourStemSeparation(new Float32Array(2), stems, stems), /sample-aligned/);
  assert.throws(() => evaluateFourStemSeparation(emptyStem, stems, stems, 1), /edge trim/);
});
