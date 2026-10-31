export type FourStemSamples = Record<"vocals" | "drums" | "bass" | "other", Float32Array>;

export type StemQualityMetrics = {
  siSdrDb: number;
  mixtureBaselineSiSdrDb: number;
  siSdrImprovementDb: number;
};

export type SeparationQualityMetrics = {
  evaluatedFrames: number;
  edgeTrimFrames: number;
  perStem: Record<keyof FourStemSamples, StemQualityMetrics>;
  recombinedMixSiSdrDb: number;
  recombinedMixResidualSdrDb: number;
  recombinedMixResidualRmsDbfs: number;
};

function sumSquares(samples: Float32Array, start: number, end: number): number {
  let total = 0;
  for (let index = start; index < end; index += 1) {
    total += samples[index] * samples[index];
  }
  return total;
}

/**
 * Scale-invariant signal-to-distortion ratio over aligned interleaved stereo
 * PCM. Flattening channels gives one global gain fit for the stereo image.
 */
export function siSdrDb(
  reference: Float32Array,
  estimate: Float32Array,
  startSample = 0,
  endSample = reference.length,
): number {
  if (reference.length !== estimate.length) {
    throw new Error(`SI-SDR needs aligned buffers (reference ${reference.length}, estimate ${estimate.length})`);
  }
  if (startSample < 0 || endSample > reference.length || startSample >= endSample) {
    throw new Error("SI-SDR sample range must be non-empty and inside the aligned buffers");
  }

  let referenceEnergy = 0;
  let dot = 0;
  for (let index = startSample; index < endSample; index += 1) {
    const target = reference[index];
    referenceEnergy += target * target;
    dot += estimate[index] * target;
  }
  if (referenceEnergy <= 1e-20) {
    throw new Error("SI-SDR reference contains only silence in the evaluated range");
  }

  const gain = dot / referenceEnergy;
  let targetEnergy = 0;
  let errorEnergy = 0;
  for (let index = startSample; index < endSample; index += 1) {
    const target = gain * reference[index];
    const error = estimate[index] - target;
    targetEnergy += target * target;
    errorEnergy += error * error;
  }
  return 10 * Math.log10(Math.max(targetEnergy, 1e-20) / Math.max(errorEnergy, 1e-20));
}

function roundDb(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * Compare the production estimates to aligned reference stems and evaluate
 * whether their unmodified sum reconstructs the supplied mixture.
 *
 * Buffers are interleaved stereo float PCM. `edgeTrimFrames` excludes known
 * model padding/overlap edge behavior from the reference separation scores;
 * the full buffers are still used for the recombination check.
 */
export function evaluateFourStemSeparation(
  mixture: Float32Array,
  references: FourStemSamples,
  estimates: FourStemSamples,
  edgeTrimFrames = 0,
): SeparationQualityMetrics {
  const names = ["vocals", "drums", "bass", "other"] as const;
  const allBuffers = [mixture, ...names.flatMap((name) => [references[name], estimates[name]])];
  const length = mixture.length;
  if (length === 0 || length % 2 !== 0) {
    throw new Error("Four-stem evaluation expects non-empty interleaved stereo PCM");
  }
  if (allBuffers.some((buffer) => buffer.length !== length)) {
    throw new Error("Four-stem evaluation requires the mixture, references, and estimates to be sample-aligned");
  }
  if (!Number.isInteger(edgeTrimFrames) || edgeTrimFrames < 0 || edgeTrimFrames * 2 * 2 >= length) {
    throw new Error("Four-stem edge trim must leave at least one stereo frame");
  }

  const startSample = edgeTrimFrames * 2;
  const endSample = length - startSample;
  const perStem = {} as Record<keyof FourStemSamples, StemQualityMetrics>;
  const recombined = new Float32Array(length);

  for (const name of names) {
    const reference = references[name];
    const estimate = estimates[name];
    const siSdr = siSdrDb(reference, estimate, startSample, endSample);
    const mixtureSiSdr = siSdrDb(reference, mixture, startSample, endSample);
    perStem[name] = {
      siSdrDb: roundDb(siSdr),
      mixtureBaselineSiSdrDb: roundDb(mixtureSiSdr),
      siSdrImprovementDb: roundDb(siSdr - mixtureSiSdr),
    };
    for (let index = 0; index < length; index += 1) recombined[index] += estimate[index];
  }

  const residual = new Float32Array(length);
  for (let index = 0; index < length; index += 1) residual[index] = mixture[index] - recombined[index];
  const mixtureEnergy = sumSquares(mixture, 0, length);
  const residualEnergy = sumSquares(residual, 0, length);
  const residualRms = Math.sqrt(residualEnergy / length);

  return {
    evaluatedFrames: (endSample - startSample) / 2,
    edgeTrimFrames,
    perStem,
    recombinedMixSiSdrDb: roundDb(siSdrDb(mixture, recombined)),
    recombinedMixResidualSdrDb: roundDb(10 * Math.log10(Math.max(mixtureEnergy, 1e-20) / Math.max(residualEnergy, 1e-20))),
    recombinedMixResidualRmsDbfs: roundDb(20 * Math.log10(Math.max(residualRms, 1e-12))),
  };
}
