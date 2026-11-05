export type FourStemSamples = Record<"vocals" | "drums" | "bass" | "other", Float32Array>;

export type StemQualityMetrics = {
  siSdrDb: number;
  mixtureBaselineSiSdrDb: number;
  siSdrImprovementDb: number;
};

export type SeparationQualityMetrics = {
  evaluatedFrames: number;
  edgeTrimFrames: number;
  referenceAlignment: ReferenceAlignment;
  perStem: Record<keyof FourStemSamples, StemQualityMetrics>;
  recombinedMixSiSdrDb: number;
  recombinedMixResidualSdrDb: number;
  recombinedMixResidualRmsDbfs: number;
};

export type ReferenceAlignment = {
  status: "verified" | "sample-count-only";
  method: "reference-sum-cross-correlation";
  zeroLagCorrelation: number;
  bestLagCorrelation: number;
  bestOffsetFrames: number;
  bestOffsetSeconds: number;
  searchRangeSeconds: number;
};

const ALIGNMENT_MIN_CORRELATION = 0.2;
const ALIGNMENT_MIN_CORRELATION_GAIN = 0.05;
const ALIGNMENT_MIN_CORRELATION_RATIO = 1.2;
const ALIGNMENT_SEARCH_RANGE_SECONDS = 5;
const ALIGNMENT_LAG_STEP_SECONDS = 0.02;
const ALIGNMENT_MAX_COMPARISON_FRAMES = 4096;
const ALIGNMENT_SAMPLES_PER_WINDOW = 8;

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

function normalizedCorrelationAtLag(
  mixture: Float32Array,
  referenceSum: Float32Array,
  lagFrames: number,
  sampleStepFrames: number,
  samplesPerWindow: number,
): number {
  const frameCount = mixture.length / 2;
  const startFrame = Math.max(0, -lagFrames);
  const endFrame = Math.min(frameCount, frameCount - lagFrames);
  let dot = 0;
  let mixtureEnergy = 0;
  let referenceEnergy = 0;

  for (let frame = startFrame; frame + samplesPerWindow <= endFrame; frame += sampleStepFrames) {
    for (let sample = 0; sample < samplesPerWindow; sample += 1) {
      const sampleFrame = frame + sample;
      const mixtureMono = (mixture[sampleFrame * 2] + mixture[sampleFrame * 2 + 1]) * 0.5;
      const referenceFrame = sampleFrame + lagFrames;
      const referenceMono =
        (referenceSum[referenceFrame * 2] + referenceSum[referenceFrame * 2 + 1]) * 0.5;
      dot += mixtureMono * referenceMono;
      mixtureEnergy += mixtureMono * mixtureMono;
      referenceEnergy += referenceMono * referenceMono;
    }
  }

  const denominator = Math.sqrt(mixtureEnergy * referenceEnergy);
  return denominator > 1e-20 ? dot / denominator : 0;
}

function inspectReferenceAlignment(
  mixture: Float32Array,
  references: FourStemSamples,
  sampleRate: number,
): ReferenceAlignment {
  const referenceSum = new Float32Array(mixture.length);
  for (const name of ["vocals", "drums", "bass", "other"] as const) {
    const stem = references[name];
    for (let index = 0; index < referenceSum.length; index += 1) {
      referenceSum[index] += stem[index];
    }
  }

  const frameCount = mixture.length / 2;
  const maxLagFrames = Math.min(
    Math.floor(sampleRate * ALIGNMENT_SEARCH_RANGE_SECONDS),
    Math.floor(frameCount / 4),
  );
  const sampleStepFrames = Math.max(1, Math.floor(frameCount / ALIGNMENT_MAX_COMPARISON_FRAMES));
  const samplesPerWindow = Math.min(ALIGNMENT_SAMPLES_PER_WINDOW, sampleStepFrames);
  const lagStepFrames = Math.max(1, Math.round(sampleRate * ALIGNMENT_LAG_STEP_SECONDS));
  const zeroLagCorrelation = normalizedCorrelationAtLag(
    mixture,
    referenceSum,
    0,
    sampleStepFrames,
    samplesPerWindow,
  );
  let bestOffsetFrames = 0;
  let bestLagCorrelation = zeroLagCorrelation;

  for (let lagFrames = -maxLagFrames; lagFrames <= maxLagFrames; lagFrames += lagStepFrames) {
    if (lagFrames === 0) continue;
    const correlation = normalizedCorrelationAtLag(
      mixture,
      referenceSum,
      lagFrames,
      sampleStepFrames,
      samplesPerWindow,
    );
    if (correlation > bestLagCorrelation) {
      bestLagCorrelation = correlation;
      bestOffsetFrames = lagFrames;
    }
  }

  const mismatch =
    bestOffsetFrames !== 0 &&
    bestLagCorrelation >= ALIGNMENT_MIN_CORRELATION &&
    bestLagCorrelation - zeroLagCorrelation >= ALIGNMENT_MIN_CORRELATION_GAIN &&
    bestLagCorrelation >= zeroLagCorrelation * ALIGNMENT_MIN_CORRELATION_RATIO;
  const verified =
    !mismatch &&
    zeroLagCorrelation >= ALIGNMENT_MIN_CORRELATION &&
    zeroLagCorrelation >= bestLagCorrelation - ALIGNMENT_MIN_CORRELATION_GAIN;

  if (mismatch) {
    throw new Error(
      `Reference stems appear time-shifted by ${Number((bestOffsetFrames / sampleRate).toFixed(3))} seconds ` +
        `(best mixture correlation ${bestLagCorrelation.toFixed(3)} vs zero-lag ${zeroLagCorrelation.toFixed(3)}); ` +
        "quality metrics were not calculated.",
    );
  }

  return {
    status: verified ? "verified" : "sample-count-only",
    method: "reference-sum-cross-correlation",
    zeroLagCorrelation: Number(zeroLagCorrelation.toFixed(4)),
    bestLagCorrelation: Number(bestLagCorrelation.toFixed(4)),
    bestOffsetFrames,
    bestOffsetSeconds: Number((bestOffsetFrames / sampleRate).toFixed(4)),
    searchRangeSeconds: Number((maxLagFrames / sampleRate).toFixed(3)),
  };
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
  sampleRate = 44_100,
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
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("Four-stem sample rate must be a positive integer");
  }

  const referenceAlignment = inspectReferenceAlignment(mixture, references, sampleRate);
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
    referenceAlignment,
    perStem,
    recombinedMixSiSdrDb: roundDb(siSdrDb(mixture, recombined)),
    recombinedMixResidualSdrDb: roundDb(10 * Math.log10(Math.max(mixtureEnergy, 1e-20) / Math.max(residualEnergy, 1e-20))),
    recombinedMixResidualRmsDbfs: roundDb(20 * Math.log10(Math.max(residualRms, 1e-12))),
  };
}
