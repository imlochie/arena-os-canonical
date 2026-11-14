/**
 * The mashup mix bus — what happens to the summed bed + vocal after the
 * arrangement decisions are made.
 *
 * Why this exists: `renderMashup` used to sum the vocal stem and the
 * (pre-scaled) instrumental bed at unity and then hard-clamp the result at
 * full scale. Two consequences were audible:
 *
 *   1. Balance was accidental. A separated vocal stem and a separated bed
 *      summed from four stems do not carry the same loudness, so the vocal
 *      could sit well above or below the bed with no reference.
 *   2. Every overload became a hard clip. The repo already had a
 *      stereo-linked, 4× true-peak `OutputPeakLimiter`, but only the live
 *      output worklet used it; the mashup renderer never did.
 *
 * This module fixes exactly those two things, conservatively:
 *
 *   - The vocal stem is gain-matched toward the bed's *measured* integrated
 *     loudness, bounded to a small window and only when both measurements
 *     exist. No invented targets, no per-song EQ curve.
 *   - The mix is rendered into a headroom-scaled buffer and passed through
 *     the existing true-peak limiter, so nothing is hard-clipped.
 *
 * Deliberately NOT done here:
 *   - no fixed EQ or "mastering" curve;
 *   - no broadband compression;
 *   - no loudness normalisation of the finished mix to a streaming target
 *     (that is a master-stage decision, not a mix-integrity fix).
 *
 * All numbers returned are measurements taken from the actual PCM, so a
 * report can say what was applied without claiming an audible improvement.
 */

import { measureLoudness, samplePeak, truePeakDb } from "../mixer/meters";
import type { StereoBuffer } from "../mixer/dsp";
import { OutputPeakLimiter } from "../output-peak-limiter";

/**
 * Widest vocal-versus-bed loudness correction this bus will apply.
 *
 * Separated stems routinely differ by several LU. Beyond ±9 LU the "fix" is
 * really a re-balance of the arrangement, not a mix correction, so the bus
 * clamps and reports an exact `correctionClamped` flag instead of silently
 * doing it.
 */
export const MASHUP_MAX_BALANCE_CORRECTION_DB = 9;

/** Limiter ceiling for the rendered mix (≈ −0.18 dBFS at 4× true peak). */
export const MASHUP_LIMITER_CEILING = 0.98;

export type MashupMixBalance = {
  /** Integrated loudness of the vocal stem as supplied, if measurable. */
  vocalLufs: number | null;
  /** Integrated loudness of the bed as supplied, if measurable. */
  bedLufs: number | null;
  /** dB applied to the vocal stem (0 when no measurement was available). */
  vocalGainDb: number;
  /** Bed gain is fixed at 1.0; recorded so a report is explicit. */
  bedGainDb: number;
  /** True when the measured correction was clamped to the ±9 LU window. */
  correctionClamped: boolean;
  /** Human-readable reason the correction is 0 or clamped. */
  note: string;
};

export type MashupMixMeasurements = {
  samplePeakDb: number;
  truePeakDb: number;
  lufsIntegrated: number | null;
  /** True when nothing in the summed mix exceeded full scale. */
  clipFree: boolean;
  /** Largest sample magnitude in the raw sum, before headroom scaling. */
  rawPeak: number;
};

export type MashupMixResult = {
  pcm: StereoBuffer;
  balance: MashupMixBalance;
  preLimit: MashupMixMeasurements;
  postLimit: MashupMixMeasurements;
  /** Static attenuation applied before limiting (0 when the mix already fitted). */
  staticGainDb: number;
  limiter: { ceiling: number; delayFrames: number; applied: boolean };
};

function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(gain, 1e-12));
}

/**
 * Decide the vocal gain from measured loudness.
 *
 * The bed is the master timeline and the master level; the vocal is fitted
 * to it. When either side cannot be measured (silence, too short for a
 * BS.1770 gating block) the correction is 0 and the reason is recorded,
 * never guessed.
 */
export function planMashupBalance(input: {
  vocals: StereoBuffer;
  bed: StereoBuffer;
  sampleRate: number;
  maxCorrectionDb?: number;
}): MashupMixBalance {
  const maxCorrection = input.maxCorrectionDb ?? MASHUP_MAX_BALANCE_CORRECTION_DB;
  const vocalLufs = measureLoudness(input.vocals, input.sampleRate).integrated;
  const bedLufs = measureLoudness(input.bed, input.sampleRate).integrated;
  if (vocalLufs === null || bedLufs === null) {
    return {
      vocalLufs,
      bedLufs,
      vocalGainDb: 0,
      bedGainDb: 0,
      correctionClamped: false,
      note: "Vocal and/or bed loudness is not measurable (silence or shorter than one gating block); the vocal stays at unity instead of guessing a balance.",
    };
  }
  const wanted = bedLufs - vocalLufs;
  const applied = Math.max(-maxCorrection, Math.min(maxCorrection, wanted));
  const clamped = Math.abs(wanted - applied) > 1e-6;
  return {
    vocalLufs,
    bedLufs,
    vocalGainDb: Number(applied.toFixed(3)),
    bedGainDb: 0,
    correctionClamped: clamped,
    note: clamped
      ? `Measured vocal/bed loudness differs by ${wanted.toFixed(2)} LU; corrected ${applied.toFixed(2)} dB and clamped to ±${maxCorrection} dB so a very unbalanced pair is reported rather than silently re-leveled.`
      : `Vocal is fitted to the bed's measured loudness (${vocalLufs.toFixed(2)} → ${bedLufs.toFixed(2)} LUFS, ${applied.toFixed(2)} dB).`,
  };
}

/**
 * Finish a summed mix.
 *
 * Gain policy is deliberately conservative and level-preserving:
 *
 *   1. Measure the sum's true peak. If it already fits under the limiter
 *      ceiling, apply **unity gain** — a mix that was fine must not get
 *      quieter just because a limiter exists (the previous renderer behaved
 *      the same way below full scale).
 *   2. Only when the sum genuinely overshoots the ceiling is a single static
 *      attenuation applied, and then the limiter catches whatever
 *      inter-sample peaks remain.
 *
 * The result is the same audible level as before for mixes that already
 * fitted, with clipping replaced by attenuation plus true-peak limiting.
 */
export function finishMashupMix(input: {
  summed: StereoBuffer;
  sampleRate: number;
  ceiling?: number;
}): MashupMixResult {
  const { sampleRate } = input;
  const ceiling = input.ceiling ?? MASHUP_LIMITER_CEILING;
  const frames = Math.floor(input.summed.length / 2);
  const rawPeak = samplePeak(input.summed);
  const rawTruePeakDb = truePeakDb(input.summed, sampleRate);
  const ceilingDb = gainToDb(ceiling);

  // Static attenuation only when needed; never a boost.
  const overshootDb = rawTruePeakDb - ceilingDb;
  const staticGainDb = overshootDb > 0 ? -overshootDb : 0;
  const staticGain = dbToGain(staticGainDb);

  const preLimitPcm = new Float32Array(frames * 2);
  for (let i = 0; i < preLimitPcm.length; i += 1) preLimitPcm[i] = input.summed[i]! * staticGain;

  const preLufs = measureLoudness(preLimitPcm, sampleRate).integrated;
  const preLimit: MashupMixMeasurements = {
    samplePeakDb: Number(gainToDb(samplePeak(preLimitPcm)).toFixed(2)),
    truePeakDb: Number(truePeakDb(preLimitPcm, sampleRate).toFixed(2)),
    lufsIntegrated: preLufs === null ? null : Number(preLufs.toFixed(2)),
    clipFree: rawPeak * staticGain <= 1,
    rawPeak,
  };

  const limiter = new OutputPeakLimiter(sampleRate, ceiling);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = preLimitPcm[frame * 2]!;
    right[frame] = preLimitPcm[frame * 2 + 1]!;
  }
  const outLeft = new Float32Array(frames);
  const outRight = new Float32Array(frames);
  limiter.process([left, right], [outLeft, outRight]);

  // The limiter delays its output; drop the leading dead frames so the mix
  // keeps its planned alignment, keeping the same frame count.
  const delay = Math.min(limiter.delayFrames, frames);
  const pcm = new Float32Array(frames * 2);
  for (let frame = delay; frame < frames; frame += 1) {
    pcm[(frame - delay) * 2] = outLeft[frame]!;
    pcm[(frame - delay) * 2 + 1] = outRight[frame]!;
  }

  const postPeak = samplePeak(pcm);
  const postLufs = measureLoudness(pcm, sampleRate).integrated;
  const postLimit: MashupMixMeasurements = {
    samplePeakDb: Number(gainToDb(postPeak).toFixed(2)),
    truePeakDb: Number(truePeakDb(pcm, sampleRate).toFixed(2)),
    lufsIntegrated: postLufs === null ? null : Number(postLufs.toFixed(2)),
    clipFree: postPeak <= 1,
    rawPeak: postPeak,
  };

  return {
    pcm,
    balance: unmeasuredBalance("Balance is recorded by the caller."),
    preLimit,
    postLimit,
    staticGainDb: Number(staticGainDb.toFixed(2)),
    limiter: { ceiling, delayFrames: delay, applied: preLimit.truePeakDb > ceilingDb },
  };
}

/** Explicit "no balance was applied" record, for controlled A/B renders. */
export function unmeasuredBalance(note: string): MashupMixBalance {
  return {
    vocalLufs: null,
    bedLufs: null,
    vocalGainDb: 0,
    bedGainDb: 0,
    correctionClamped: false,
    note,
  };
}

/** Measure one render stage without limiting it (used by A/B bisections). */
export function measureMashupMixStage(pcm: StereoBuffer, sampleRate: number): MashupMixMeasurements {
  const lufs = measureLoudness(pcm, sampleRate).integrated;
  return {
    samplePeakDb: Number(gainToDb(samplePeak(pcm)).toFixed(2)),
    truePeakDb: Number(truePeakDb(pcm, sampleRate).toFixed(2)),
    lufsIntegrated: lufs === null ? null : Number(lufs.toFixed(2)),
    clipFree: samplePeak(pcm) <= 1,
    rawPeak: samplePeak(pcm),
  };
}
