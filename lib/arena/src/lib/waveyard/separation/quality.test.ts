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
  assert.equal(metrics.referenceAlignment.status, "verified");
  assert.equal(metrics.referenceAlignment.method, "reference-sum-cross-correlation");
  for (const stem of Object.values(metrics.perStem)) assert.ok(stem.siSdrImprovementDb > 0);
  assert.ok(metrics.recombinedMixResidualSdrDb > 100);
  assert.ok(metrics.recombinedMixResidualRmsDbfs < -100);
  assert.deepEqual(evaluateFourStemSeparation(mixture, references, estimates), metrics);
});

test("four-stem evaluation rejects equal-length references shifted in time", () => {
  const sampleRate = 1_000;
  const frameCount = 2_000;
  const shiftFrames = 150;
  const mixture = new Float32Array(frameCount * 2);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const value =
      Math.sin(frame * 0.071) * 0.5 +
      Math.sin(frame * 0.173) * 0.25 +
      Math.cos(frame * 0.037) * 0.15;
    mixture[frame * 2] = value;
    mixture[frame * 2 + 1] = value * 0.8;
  }
  const shiftedVocals = new Float32Array(mixture.length);
  for (let frame = shiftFrames; frame < frameCount; frame += 1) {
    shiftedVocals[frame * 2] = mixture[(frame - shiftFrames) * 2];
    shiftedVocals[frame * 2 + 1] = mixture[(frame - shiftFrames) * 2 + 1];
  }
  const silence = new Float32Array(mixture.length);
  const shiftedReferences: FourStemSamples = {
    vocals: shiftedVocals,
    drums: silence,
    bass: silence,
    other: silence,
  };

  assert.throws(
    () => evaluateFourStemSeparation(mixture, shiftedReferences, shiftedReferences, 0, sampleRate),
    /time-shifted by .*quality metrics were not calculated/,
  );
});

test("four-stem evaluation rejects unaligned buffers and invalid edge trims", () => {
  const emptyStem = new Float32Array(4);
  const stems: FourStemSamples = { vocals: emptyStem, drums: emptyStem, bass: emptyStem, other: emptyStem };
  assert.throws(() => evaluateFourStemSeparation(new Float32Array(2), stems, stems), /sample-aligned/);
  assert.throws(() => evaluateFourStemSeparation(emptyStem, stems, stems, 1), /edge trim/);
});
