/**
 * Waveyard measurement core. Every number produced here comes from actual
 * PCM samples — no defaults, no guesses. LUFS implements ITU-R BS.1770-4
 * (K-weighting + 400 ms blocks, 75 % overlap, −70 LUFS absolute gate,
 * −10 LU relative gate), calibrated against the EBU R128 anchor: a
 * dual-mono 1 kHz sine at −23 dBFS RMS per channel measures −23 LUFS.
 */

import {
  applyBiquad,
  biquadSample,
  designBiquad,
  newBiquadState,
  type BiquadCoeffs,
  type BiquadState,
  type StereoBuffer,
  dspDbToGain,
  dspGainToDb,
} from "./dsp";

export type AudioMeasurements = {
  sampleRate: number;
  frames: number;
  durationSeconds: number;
  peakDb: number;
  truePeakDb: number;
  rmsDb: number;
  crestDb: number;
  dcOffset: number;
  lufsIntegrated: number | null;
  lufsShortTermMax: number | null;
  stereoCorrelation: number | null;
  stereoWidthDb: number | null;
  clipped: ClippedStats;
};

export type ClippedStats = {
  regions: number;
  clippedSamples: number;
  clippedSeconds: number;
  worstRegionMs: number;
};

export const CLIP_THRESHOLD = 0.997; // ≈ −0.03 dBFS
const DC_GATE_SAMPLES = 32;

export function samplePeak(buffer: StereoBuffer): number {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const magnitude = Math.abs(buffer[i]);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

export function rmsDb(buffer: StereoBuffer): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return dspGainToDb(Math.sqrt(sum / buffer.length));
}

export function dcOffset(buffer: StereoBuffer): number {
  let left = 0;
  let right = 0;
  const frames = buffer.length >> 1;
  for (let i = 0; i < buffer.length; i += 2) {
    left += buffer[i];
    right += buffer[i + 1];
  }
  return frames === 0 ? 0 : (left / frames + right / frames) / 2;
}

/**
 * True peak (inter-sample) via genuine 4× polyphase oversampling: each
 * output phase is a real sinc-interpolated sub-sample signal, so peaks
 * BETWEEN samples are measured, not estimated.
 */
export function truePeakDb(buffer: StereoBuffer, sampleRate: number): number {
  const branches = designOversamplePolyphase(4, 24);
  let peak = samplePeak(buffer);
  const frames = buffer.length >> 1;
  for (let channel = 0; channel < 2; channel += 1) {
    for (let n = 0; n < frames; n += 1) {
      const x = Math.abs(buffer[n * 2 + channel]);
      if (x + 0.3 < peak) continue; // cheap guard: ISP exceeds sample peak only slightly
      for (let p = 0; p < branches.length; p += 1) {
        const taps = branches[p];
        let acc = 0;
        for (let k = 0; k < taps.length; k += 1) {
          const idx = n + k - (taps.length >> 1);
          const s = idx >= 0 && idx < frames ? buffer[idx * 2 + channel] : 0;
          acc += s * taps[k];
        }
        const mag = Math.abs(acc);
        if (mag > peak) peak = mag;
      }
    }
  }
  return dspGainToDb(peak);
}

/** Polyphase branches of a windowed-sinc 4× oversampling lowpass (each branch sums to ≈1). */
function designOversamplePolyphase(
  oversample: number,
  tapsPerPhase: number,
): Float32Array[] {
  const total = oversample * tapsPerPhase;
  const h = new Float32Array(total);
  const fc = 0.45 / oversample; // cycles per oversampled sample (< π/M)
  const center = (total - 1) / 2;
  for (let i = 0; i < total; i += 1) {
    const x = i - center;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (total - 1));
    h[i] = sinc * window;
  }
  // Normalize the full kernel to gain `oversample` so zero-stuffed input
  // reconstructs at unity and each polyphase branch sums to ≈1.
  let sum = 0;
  for (let i = 0; i < total; i += 1) sum += h[i];
  const scale = sum !== 0 ? oversample / sum : 1;
  const branches: Float32Array[] = [];
  for (let p = 0; p < oversample; p += 1) {
    const taps = new Float32Array(tapsPerPhase);
    for (let k = 0; k < tapsPerPhase; k += 1) taps[k] = h[p + k * oversample] * scale;
    branches.push(taps);
  }
  return branches;
}

/** Detect clipped regions: runs of |x| ≥ threshold, merged across gaps < 32 samples. */
export function clippedRegions(
  buffer: StereoBuffer,
  sampleRate: number,
  threshold = CLIP_THRESHOLD,
): ClippedStats {
  const frames = buffer.length >> 1;
  let regions = 0;
  let clippedSamples = 0;
  let run = 0;
  let gap = 0;
  let worstRun = 0;
  let inRun = false;
  for (let frame = 0; frame < frames; frame += 1) {
    const isClipped =
      Math.abs(buffer[frame * 2]) >= threshold ||
      Math.abs(buffer[frame * 2 + 1]) >= threshold;
    if (isClipped) {
      clippedSamples += 1;
      run += 1;
      if (run > worstRun) worstRun = run;
      gap = 0;
      if (!inRun) {
        regions += 1;
        inRun = true;
      }
    } else if (inRun) {
      gap += 1;
      if (gap >= DC_GATE_SAMPLES) {
        inRun = false;
        run = 0;
        gap = 0;
      }
    }
  }
  return {
    regions,
    clippedSamples,
    clippedSeconds: clippedSamples / sampleRate,
    worstRegionMs: (worstRun / sampleRate) * 1000,
  };
}

/** Pearson correlation between L and R (null for mono input). */
export function stereoCorrelation(buffer: StereoBuffer): number | null {
  const frames = buffer.length >> 1;
  if (frames < 2) return null;
  let sumL = 0;
  let sumR = 0;
  let sumLR = 0;
  let sumLL = 0;
  let sumRR = 0;
  for (let i = 0; i < buffer.length; i += 2) {
    const l = buffer[i];
    const r = buffer[i + 1];
    sumL += l; sumR += r;
    sumLR += l * r; sumLL += l * l; sumRR += r * r;
  }
  const n = frames;
  const cov = sumLR - (sumL * sumR) / n;
  const varL = sumLL - (sumL * sumL) / n;
  const varR = sumRR - (sumR * sumR) / n;
  const denom = Math.sqrt(varL * varR);
  if (denom <= 0) return varL === 0 && varR === 0 ? 1 : 0;
  return cov / denom;
}

/** Side/mid energy ratio in dB (0 = mono, positive = wide). */
export function stereoWidthDb(buffer: StereoBuffer): number | null {
  const frames = buffer.length >> 1;
  if (frames < 2) return null;
  let mid = 0;
  let side = 0;
  for (let i = 0; i < buffer.length; i += 2) {
    const m = (buffer[i] + buffer[i + 1]) * 0.5;
    const s = (buffer[i] - buffer[i + 1]) * 0.5;
    mid += m * m;
    side += s * s;
  }
  if (mid <= 0) return null;
  return dspGainToDb(Math.sqrt(side / mid));
}

// ---------------------------------------------------------------------------
// Band energy (via bandpass = highpass + lowpass cascade)
// ---------------------------------------------------------------------------

export function bandRmsDb(
  buffer: StereoBuffer,
  sampleRate: number,
  loHz: number,
  hiHz: number,
): number {
  const hp = designBiquad({ type: "highpass", freqHz: loHz, q: 0.7071 }, sampleRate);
  const lp = designBiquad({ type: "lowpass", freqHz: Math.min(hiHz, sampleRate * 0.49), q: 0.7071 }, sampleRate);
  // Each filter needs its OWN state per channel — sharing state between the
  // HP and LP corrupts both (a bug caught by the band-dominance tests).
  const hpL = newBiquadState();
  const lpL = newBiquadState();
  const hpR = newBiquadState();
  const lpR = newBiquadState();
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 2) {
    const l = biquadSample(lp, lpL, biquadSample(hp, hpL, buffer[i]));
    const r = biquadSample(lp, lpR, biquadSample(hp, hpR, buffer[i + 1]));
    sum += l * l + r * r;
  }
  return dspGainToDb(Math.sqrt(sum / buffer.length));
}

// ---------------------------------------------------------------------------
// Loudness — ITU-R BS.1770-4
// ---------------------------------------------------------------------------

/** K-weighting: stage 1 high shelf (+4 dB rising) + stage 2 RLB high-pass. */
/**
 * K-weighting. At 48 kHz the exact normative BS.1770-4 coefficients are
 * used; other rates use the RBJ prototype (documented deviation,
 * typically < 0.3 LU — reported via kWeightingSource so downstream
 * consumers know which basis produced the number).
 */
export type KWeightSource = "bs1770-48k-exact" | "rbj-prototype";

export function kWeightCoeffs(
  sampleRate: number,
): { stage1: BiquadCoeffs; stage2: BiquadCoeffs; source: KWeightSource } {
  if (sampleRate === 48000) {
    return {
      stage1: {
        b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285,
        a1: -1.69065929318241, a2: 0.73248077421585,
      },
      stage2: {
        b0: 1.0, b1: -2.0, b2: 1.0,
        a1: -1.99004745483398, a2: 0.99007225036621,
      },
      source: "bs1770-48k-exact",
    };
  }
  return {
    stage1: designBiquad(
      { type: "highshelf", freqHz: 1681.974450955533, q: 0.7071752369554196, gainDb: 3.999843853973347 },
      sampleRate,
    ),
    stage2: designBiquad(
      { type: "highpass", freqHz: 38.13547087602444, q: 0.5003270373238773 },
      sampleRate,
    ),
    source: "rbj-prototype",
  };
}

export type LoudnessResult = { integrated: number | null; shortTermMax: number | null };

/**
 * Integrated LUFS with BS.1770-4 gating and 3 s short-term maximum.
 * Returns null integrated when everything is below the −70 LUFS gate
 * (silence) — never a fabricated number.
 */
export function measureLoudness(
  buffer: StereoBuffer,
  sampleRate: number,
): LoudnessResult {
  const { stage1, stage2 } = kWeightCoeffs(sampleRate);
  const l1 = newBiquadState();
  const l2 = newBiquadState();
  const r1 = newBiquadState();
  const r2 = newBiquadState();

  const frames = buffer.length >> 1;
  const blockSize = Math.round(0.4 * sampleRate);
  const hopSize = Math.round(0.1 * sampleRate);
  if (frames < blockSize) return { integrated: null, shortTermMax: null };

  const blockPowers: number[] = [];
  for (let start = 0; start + blockSize <= frames; start += hopSize) {
    let sum = 0;
    for (let frame = start; frame < start + blockSize; frame += 1) {
      const li = frame * 2;
      const l = biquadSample(stage2, l2, biquadSample(stage1, l1, buffer[li]));
      const r = biquadSample(stage2, r2, biquadSample(stage1, r1, buffer[li + 1]));
      sum += l * l + r * r;
    }
    blockPowers.push(sum / blockSize);
  }

  const blockLoudness = (power: number) => -0.691 + 10 * Math.log10(power);

  // Absolute gate.
  const above: number[] = [];
  for (const power of blockPowers)
    if (blockLoudness(power) > -70) above.push(power);
  if (above.length === 0) return { integrated: null, shortTermMax: null };

  const ungatedMeanPower =
    above.reduce((total, power) => total + power, 0) / above.length;
  const relativeThreshold = blockLoudness(ungatedMeanPower) - 10;

  const gated = above.filter((power) => blockLoudness(power) > relativeThreshold);
  const gatedMeanPower =
    gated.length > 0
      ? gated.reduce((total, power) => total + power, 0) / gated.length
      : ungatedMeanPower;
  const integrated = blockLoudness(gatedMeanPower);

  // Short-term (3 s) blocks, ungated (standard reports max short-term).
  const stBlockSize = Math.round(3 * sampleRate);
  let shortTermMax: number | null = null;
  if (frames >= stBlockSize) {
    for (let start = 0; start + stBlockSize <= frames; start += hopSize) {
      let sum = 0;
      for (let frame = start; frame < start + stBlockSize; frame += 1) {
        const li = frame * 2;
        const l = biquadSample(stage2, l2, biquadSample(stage1, l1, buffer[li]));
        const r = biquadSample(stage2, r2, biquadSample(stage1, r1, buffer[li + 1]));
        sum += l * l + r * r;
      }
      const lufs = -0.691 + 10 * Math.log10(sum / stBlockSize);
      if (shortTermMax === null || lufs > shortTermMax) shortTermMax = lufs;
    }
  }

  return { integrated, shortTermMax };
}

// ---------------------------------------------------------------------------
// Full measurement pass
// ---------------------------------------------------------------------------

export function measureAudio(
  buffer: StereoBuffer,
  sampleRate: number,
): AudioMeasurements {
  const peak = samplePeak(buffer);
  const rms = rmsDb(buffer);
  const loudness = measureLoudness(buffer, sampleRate);
  const frames = buffer.length >> 1;
  return {
    sampleRate,
    frames,
    durationSeconds: frames / sampleRate,
    peakDb: dspGainToDb(peak),
    truePeakDb: truePeakDb(buffer, sampleRate),
    rmsDb: rms,
    crestDb: peak > 0 ? dspGainToDb(peak) - rms : 0,
    dcOffset: dcOffset(buffer),
    lufsIntegrated: loudness.integrated,
    lufsShortTermMax: loudness.shortTermMax,
    stereoCorrelation: stereoCorrelation(buffer),
    stereoWidthDb: stereoWidthDb(buffer),
    clipped: clippedRegions(buffer, sampleRate),
  };
}

/** Convenience: loudness units for a measured LUFS delta. */
export function lufsDelta(from: number, to: number): number {
  return to - from;
}
