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

import { clippedRegions, measureLoudness, samplePeak, stereoCorrelation, truePeakDb } from "../mixer/meters";
import type { StereoBuffer } from "../mixer/dsp";
import { OutputPeakLimiter } from "../output-peak-limiter";

/**
 * Widest vocal-versus-bed loudness correction this bus will apply.
 *
 * Separated stems routinely differ by several LU. Beyond ±6 LU the "fix" is
 * really a re-balance of the arrangement, not a mix correction, so the bus
 * clamps and reports an exact `correctionClamped` flag instead of silently
 * doing it. Measured on the fixtures in `mashup-mix-bus.test.ts`, a ±9 dB
 * window let a sparse vocal (4 % active) be pushed to the clamp and still sit
 * under a dense bed, which is the wrong behaviour: clamping is a signal that
 * the pair needs a different arrangement, not a bigger gain.
 */
export const MASHUP_MAX_BALANCE_CORRECTION_DB = 6;

/**
 * Block reporting window. This is *reporting only*: the balance statistic is
 * BS.1770 integrated loudness, whose absolute and relative gates already
 * exclude silence and low-level bleed (measured on the fixtures in
 * `mashup-mix-bus.test.ts`: a 1.5 s phrase inside 30 s of silence reads the
 * same integrated as the phrase alone, and a continuous −50 dB bleed floor
 * does not dilute it either). A second, hand-rolled gating statistic was tried
 * here and did not change the result, so it was removed rather than kept as
 * extra machinery.
 */
export const MASHUP_VOCAL_PRESENCE_WINDOW_DB = 20;
const PRESENCE_BLOCK_SECONDS = 0.4;

/** Limiter ceiling for the rendered mix (≈ −0.18 dBFS at 4× true peak). */
export const MASHUP_LIMITER_CEILING = 0.98;

export type MashupMixBalance = {
  /** Loudness actually used for the match (present blocks when available). */
  vocalLufs: number | null;
  /** Loudness actually used for the match (present blocks when available). */
  bedLufs: number | null;
  /** Whole-programme BS.1770 integrated loudness, for comparison only. */
  vocalIntegratedLufs?: number | null;
  bedIntegratedLufs?: number | null;
  /** Fraction of 0.4 s blocks considered present; low values flag sparse stems. */
  vocalActiveFraction?: number | null;
  bedActiveFraction?: number | null;
  /** Which statistic produced the match. */
  method?: "integrated";
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
  /** Reconstructed 4× true peak. */
  truePeakDb: number;
  /** Loudness used for the reported level. */
  loudnessDb: number | null;
  /** Loudness statistic used for the reported level. */
  loudnessBasis: "integrated" | "unmeasurable";
  lufsIntegrated: number | null;
  stereoCorrelation: number | null;
  /** Number of clipped-sample regions in this stage. */
  clippedRegions: number;
  /** True when nothing in the stage exceeded full scale. */
  clipFree: boolean;
  /** Largest sample magnitude, before any gain stage. */
  rawPeak: number;
};

/**
 * Measure one stage of the mix.
 *
 * True-peak reconstruction is the expensive part (4× oversampled FIR over
 * every sample), so it is measured on the *pre-limit* sum and the limiter's
 * output is measured for sample peak/clipping/correlation. A post-limit true
 * peak is still reported when `fullTruePeak` is true, which the mix bus does
 * for short renders and skips for multi-minute ones.
 */
export function measureMashupMixStage(
  pcm: StereoBuffer,
  sampleRate: number,
  options: { fullTruePeak?: boolean } = {},
): MashupMixMeasurements {
  const integrated = measureLoudness(pcm, sampleRate).integrated;
  const present = measurePresentLoudness(pcm, sampleRate);
  const clipped = clippedRegions(pcm, sampleRate);
  const loudnessDb = integrated;
  return {
    samplePeakDb: Number(gainToDb(samplePeak(pcm)).toFixed(2)),
    truePeakDb: options.fullTruePeak === false ? Number.NaN : Number(truePeakDb(pcm, sampleRate).toFixed(2)),
    loudnessDb: loudnessDb === null ? null : Number(loudnessDb.toFixed(2)),
    loudnessBasis: integrated !== null ? "integrated" : "unmeasurable",
    lufsIntegrated: integrated === null ? null : Number(integrated.toFixed(2)),
    stereoCorrelation: (() => {
      const value = stereoCorrelation(pcm);
      return value === null ? null : Number(value.toFixed(3));
    })(),
    clippedRegions: clipped.regions,
    clipFree: samplePeak(pcm) <= 1 && clipped.regions === 0,
    rawPeak: samplePeak(pcm),
  };
}

export type MashupMixResult = {
  pcm: StereoBuffer;
  balance: MashupMixBalance;
  preLimit: MashupMixMeasurements;
  postLimit: MashupMixMeasurements;
  /** Static attenuation applied before limiting (0 when the mix already fitted). */
  staticGainDb: number;
  /** False when the render was too long to re-measure true peak after limiting. */
  postTruePeakMeasured: boolean;
  limiter: { ceiling: number; delayFrames: number; applied: boolean };
};

function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(gain, 1e-12));
}

/**
 * Loudness of the blocks in which the stem is actually present.
 *
 * Non-finite/absent evidence returns null rather than a fabricated number.
 * `activeFraction` is reported so a caller can see that a stem was mostly
 * silent — that is usually a sign the phrase selection, not the gain, is the
 * thing to look at.
 */
export function measurePresentLoudness(
  buffer: StereoBuffer,
  sampleRate: number,
  presenceWindowDb = MASHUP_VOCAL_PRESENCE_WINDOW_DB,
): { loudness: number; activeFraction: number; blockCount: number } | null {
  const frames = buffer.length >> 1;
  const blockFrames = Math.round(PRESENCE_BLOCK_SECONDS * sampleRate);
  if (frames < blockFrames) return null;
  const powers: number[] = [];
  for (let start = 0; start + blockFrames <= frames; start += blockFrames) {
    let sum = 0;
    for (let frame = start; frame < start + blockFrames; frame += 1) {
      const l = buffer[frame * 2]!;
      const r = buffer[frame * 2 + 1]!;
      sum += l * l + r * r;
    }
    powers.push(sum / blockFrames);
  }
  if (powers.length === 0) return null;
  const loudest = Math.max(...powers);
  if (!(loudest > 0)) return null;
  const floor = loudest * 10 ** (-presenceWindowDb / 10);
  const active = powers.filter((power) => power >= floor);
  if (active.length === 0) return null;
  const meanPower = active.reduce((total, power) => total + power, 0) / active.length;
  // Same 2-channel sum convention as measureLoudness's ungated path; this is
  // a relative comparison between two stems, not a certification of LUFS.
  const loudness = -0.691 + 10 * Math.log10(meanPower);
  return {
    loudness: Number(loudness.toFixed(2)),
    activeFraction: Number((active.length / powers.length).toFixed(3)),
    blockCount: powers.length,
  };
}

/**
 * Decide the vocal gain from measured loudness.
 *
 * The bed is the master timeline and the master level; the vocal is fitted to
 * it. The basis is BS.1770 integrated loudness on both sides — the same
 * already-tested statistic the rest of Waveyard uses — and the report also
 * carries each side's active-block fraction so a caller can see when a stem is
 * mostly empty. When either side cannot be measured the correction is 0 and
 * the reason is recorded, never guessed.
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
  const vocalPresence = measurePresentLoudness(input.vocals, input.sampleRate);
  const bedPresence = measurePresentLoudness(input.bed, input.sampleRate);

  if (vocalLufs === null || bedLufs === null) {
    return {
      vocalLufs,
      bedLufs,
      vocalIntegratedLufs: vocalLufs,
      bedIntegratedLufs: bedLufs,
      vocalActiveFraction: vocalPresence?.activeFraction ?? null,
      bedActiveFraction: bedPresence?.activeFraction ?? null,
      vocalGainDb: 0,
      bedGainDb: 0,
      correctionClamped: false,
      method: "integrated",
      note: "Vocal and/or bed loudness is not measurable (silence or shorter than one gating block); the vocal stays at unity instead of guessing a balance.",
    };
  }

  const wanted = bedLufs - vocalLufs;
  const applied = Math.max(-maxCorrection, Math.min(maxCorrection, wanted));
  const clamped = Math.abs(wanted - applied) > 1e-6;
  return {
    vocalLufs,
    bedLufs,
    vocalIntegratedLufs: vocalLufs,
    bedIntegratedLufs: bedLufs,
    vocalActiveFraction: vocalPresence?.activeFraction ?? null,
    bedActiveFraction: bedPresence?.activeFraction ?? null,
    vocalGainDb: Number(applied.toFixed(3)),
    bedGainDb: 0,
    correctionClamped: clamped,
    method: "integrated",
    note: clamped
      ? `Measured BS.1770 difference is ${wanted.toFixed(2)} dB; applied ${applied.toFixed(2)} dB and clamped to ±${maxCorrection} dB. A clamped correction means this pair needs a bigger change than a mix balance should make — the pairing or the phrase selection is the open question, not the gain.`
      : `Vocal fitted to the bed's measured loudness: ${vocalLufs.toFixed(2)} → ${bedLufs.toFixed(2)} LUFS, ${applied.toFixed(2)} dB.`,
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
 *      attenuation applied, and then the limiter catches whatever inter-sample
 *      peaks remain.
 *
 * Measurement cost is bounded deliberately: full 4× true-peak reconstruction
 * over a multi-minute render costs several seconds, so it is measured on the
 * pre-limit sum (where the decision is made) and on the finished mix only for
 * renders shorter than `FULL_TRUE_PEAK_MAX_SECONDS`. Longer renders report the
 * post-limit *sample* peak and say `postTruePeakMeasured: false` rather than
 * implying a true-peak measurement that did not happen.
 */
export const FULL_TRUE_PEAK_MAX_SECONDS = 60;

export function finishMashupMix(input: {
  summed: StereoBuffer;
  sampleRate: number;
  ceiling?: number;
}): MashupMixResult {
  const { sampleRate } = input;
  const ceiling = input.ceiling ?? MASHUP_LIMITER_CEILING;
  const frames = Math.floor(input.summed.length / 2);
  const durationSeconds = frames / sampleRate;
  const rawPeak = samplePeak(input.summed);
  const rawTruePeakDb = truePeakDb(input.summed, sampleRate);
  const ceilingDb = gainToDb(ceiling);

  // Static attenuation only when needed; never a boost.
  const overshootDb = rawTruePeakDb - ceilingDb;
  const staticGainDb = overshootDb > 0 ? -overshootDb : 0;
  const staticGain = dbToGain(staticGainDb);

  const preLimitPcm = new Float32Array(frames * 2);
  for (let i = 0; i < preLimitPcm.length; i += 1) preLimitPcm[i] = input.summed[i]! * staticGain;
  const preLimit = measureMashupMixStage(preLimitPcm, sampleRate);
  // The decision was made on the summed true peak, before attenuation.
  preLimit.truePeakDb = Number(rawTruePeakDb.toFixed(2));
  preLimit.rawPeak = rawPeak;

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

  const postTruePeakMeasured = durationSeconds <= FULL_TRUE_PEAK_MAX_SECONDS;
  const postLimit = measureMashupMixStage(pcm, sampleRate, { fullTruePeak: postTruePeakMeasured });

  return {
    pcm,
    balance: unmeasuredBalance("Balance is recorded by the caller."),
    preLimit,
    postLimit,
    postTruePeakMeasured,
    staticGainDb: Number(staticGainDb.toFixed(2)),
    limiter: { ceiling, delayFrames: delay, applied: rawTruePeakDb > ceilingDb },
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
