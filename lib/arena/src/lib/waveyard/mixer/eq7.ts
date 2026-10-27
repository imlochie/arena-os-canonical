/**
 * EQ 7-Band — high-pass, low shelf, three peaking bands, high shelf,
 * low-pass — offline whole-buffer, in-place.
 *
 * Adapted from SoundCraft's EQ 7-Band plugin (crates/dsp/src/plugins/eq.rs),
 * Copyright (c) 2026 ArtCraft Team and SoundCraft contributors,
 * dual-licensed MIT OR Apache-2.0 (https://github.com/storytold/soundcraft).
 * Clean-room TypeScript port: band layout, slope cascades (6 dB/oct
 * first-order up to 24 dB/oct Butterworth pair), and the skip-when-flat
 * design are preserved; offline static sections replace the realtime
 * smoothers. An analytic magnitude response (`eq7ResponseDb`) is included so
 * tests and UI curves can verify the design without running audio.
 */

import { biquadSample, designBiquad, dspDbToGain, type BiquadCoeffs, type BiquadState, type StereoBuffer } from "./dsp";

export type Eq7Params = {
  inputGainDb: number; // −24..24
  hpfOn: number; // 0 | 1
  hpfHz: number; // 10..2000
  hpfSlope: number; // 0..3 (6/12/18/24 dB per octave)
  lfHz: number; // 20..1000 (low shelf)
  lfGainDb: number; // −24..24
  lfQ: number; // 0.3..2
  lmfHz: number; // 20..2000 (peak)
  lmfGainDb: number;
  lmfQ: number; // 0.1..10
  mfHz: number; // 100..8000 (peak)
  mfGainDb: number;
  mfQ: number;
  hmfHz: number; // 500..20000 (peak)
  hmfGainDb: number;
  hmfQ: number;
  hfHz: number; // 1000..20000 (high shelf)
  hfGainDb: number;
  hfQ: number; // 0.3..2
  lpfOn: number; // 0 | 1
  lpfHz: number; // 1000..20000
  lpfSlope: number; // 0..3
  outputGainDb: number; // −24..24
  sampleRate: number;
};

type Section =
  | { kind: "first-order"; highpass: boolean; freqHz: number }
  | { kind: "biquad"; coeffs: BiquadCoeffs };

/** 4th-order Butterworth Q pair for the 24 dB/oct slope. */
const BUTTERWORTH_Q = [0.5412, 1.3066];

/** 1–2 cascaded sections for a HPF/LPF of the given slope index. */
function passFilterSections(slope: number, highpass: boolean, freqHz: number, sampleRate: number): Section[] {
  switch (Math.round(slope)) {
    case 0: // 6 dB/oct: single first-order section.
      return [{ kind: "first-order", highpass, freqHz }];
    case 2: // 18 dB/oct: first-order + biquad (Q 1.0).
      return [
        { kind: "first-order", highpass, freqHz },
        { kind: "biquad", coeffs: designBiquad({ type: highpass ? "highpass" : "lowpass", freqHz, q: 1 }, sampleRate) },
      ];
    case 3: // 24 dB/oct: Butterworth biquad pair.
      return BUTTERWORTH_Q.map((q) => ({
        kind: "biquad" as const,
        coeffs: designBiquad({ type: highpass ? "highpass" : "lowpass", freqHz, q }, sampleRate),
      }));
    default: // 12 dB/oct: single biquad.
      return [{ kind: "biquad", coeffs: designBiquad({ type: highpass ? "highpass" : "lowpass", freqHz, q: Math.SQRT1_2 }, sampleRate) }];
  }
}

/** Build the cascaded section list. Flat bands and disabled filters are skipped. */
export function designEq7Sections(p: Eq7Params, sampleRate: number): Section[] {
  const sections: Section[] = [];
  if (p.hpfOn >= 0.5) {
    sections.push(...passFilterSections(p.hpfSlope, true, p.hpfHz, sampleRate));
  }
  const bands = [
    { freqHz: p.lfHz, gainDb: p.lfGainDb, q: p.lfQ, type: "lowshelf" as const },
    { freqHz: p.lmfHz, gainDb: p.lmfGainDb, q: p.lmfQ, type: "peaking" as const },
    { freqHz: p.mfHz, gainDb: p.mfGainDb, q: p.mfQ, type: "peaking" as const },
    { freqHz: p.hmfHz, gainDb: p.hmfGainDb, q: p.hmfQ, type: "peaking" as const },
    { freqHz: p.hfHz, gainDb: p.hfGainDb, q: p.hfQ, type: "highshelf" as const },
  ];
  for (const band of bands) {
    if (Math.abs(band.gainDb) > 1e-4) {
      sections.push({
        kind: "biquad",
        coeffs: designBiquad({ type: band.type, freqHz: band.freqHz, q: band.q, gainDb: band.gainDb }, sampleRate),
      });
    }
  }
  if (p.lpfOn >= 0.5) {
    sections.push(...passFilterSections(p.lpfSlope, false, p.lpfHz, sampleRate));
  }
  return sections;
}

/** One-pole state shared by first-order sections. */
type OnePoleState = { z: number };

function firstOrderSample(
  state: OnePoleState,
  x: number,
  freqHz: number,
  sampleRate: number,
  highpass: boolean,
): number {
  const a = 1 - Math.exp((-2 * Math.PI * freqHz) / sampleRate);
  const lp = state.z + a * (x - state.z);
  state.z = lp;
  return highpass ? x - lp : lp;
}

/** Apply the 7-band EQ in place; the buffer length is unchanged. */
export function applyEq7(buffer: StereoBuffer, params: Eq7Params): void {
  const sampleRate = Math.max(1, params.sampleRate);
  const sections = designEq7Sections(params, sampleRate);
  const gain = dspDbToGain(clampNum(params.inputGainDb, -24, 24) + clampNum(params.outputGainDb, -24, 24));
  const frames = buffer.length / 2;
  const onePoleL: OnePoleState[] = [];
  const onePoleR: OnePoleState[] = [];
  const bqL: BiquadState[] = [];
  const bqR: BiquadState[] = [];
  for (const section of sections) {
    if (section.kind === "first-order") {
      onePoleL.push({ z: 0 });
      onePoleR.push({ z: 0 });
    } else {
      bqL.push({ x1: 0, x2: 0, y1: 0, y2: 0 });
      bqR.push({ x1: 0, x2: 0, y1: 0, y2: 0 });
    }
  }
  for (let n = 0; n < frames; n += 1) {
    let l = buffer[n * 2];
    let r = buffer[n * 2 + 1];
    let poleIdx = 0;
    let bqIdx = 0;
    for (const section of sections) {
      if (section.kind === "first-order") {
        l = firstOrderSample(onePoleL[poleIdx], l, section.freqHz, sampleRate, section.highpass);
        r = firstOrderSample(onePoleR[poleIdx], r, section.freqHz, sampleRate, section.highpass);
        poleIdx += 1;
      } else {
        l = biquadSample(section.coeffs, bqL[bqIdx], l);
        r = biquadSample(section.coeffs, bqR[bqIdx], r);
        bqIdx += 1;
      }
    }
    buffer[n * 2] = l * gain;
    buffer[n * 2 + 1] = r * gain;
  }
}

function clampNum(x: number, min: number, max: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(max, Math.max(min, x));
}

// ---------------------------------------------------------------------------
// Analytic magnitude response (dB) — verification without running audio
// ---------------------------------------------------------------------------

type Complex = { re: number; im: number };

function cDiv(a: Complex, b: Complex): Complex {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

function biquadMagnitude(coeffs: BiquadCoeffs, w: number): number {
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const cw2 = Math.cos(2 * w);
  const sw2 = Math.sin(2 * w);
  const num: Complex = {
    re: coeffs.b0 + coeffs.b1 * cw + coeffs.b2 * cw2,
    im: -(coeffs.b1 * sw + coeffs.b2 * sw2),
  };
  const den: Complex = { re: 1 + coeffs.a1 * cw + coeffs.a2 * cw2, im: -(coeffs.a1 * sw + coeffs.a2 * sw2) };
  const h = cDiv(num, den);
  return Math.sqrt(h.re * h.re + h.im * h.im);
}

/** First-order section magnitude at radian frequency w. */
function firstOrderMagnitude(freqHz: number, sampleRate: number, highpass: boolean, w: number): number {
  const a = 1 - Math.exp((-2 * Math.PI * freqHz) / sampleRate);
  // H_lp(e^{jw}) = a / (1 − (1−a)·e^{−jw})
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const den: Complex = { re: 1 - (1 - a) * cw, im: (1 - a) * sw };
  const lp = cDiv({ re: a, im: 0 }, den);
  const magLp = Math.sqrt(lp.re * lp.re + lp.im * lp.im);
  // |H_hp| needs the full complex difference, not just |1 − |H_lp||.
  const hp = { re: 1 - lp.re, im: -lp.im };
  return highpass ? Math.sqrt(hp.re * hp.re + hp.im * hp.im) : magLp;
}

/**
 * Magnitude response of the full EQ (including input/output gain) at each
 * frequency, in dB. Frequencies are clamped to (0, Nyquist).
 */
export function eq7ResponseDb(params: Eq7Params, freqs: readonly number[], sampleRate: number): number[] {
  const sr = Math.max(1, sampleRate);
  const sections = designEq7Sections(params, sr);
  const gainDb = clampNum(params.inputGainDb, -24, 24) + clampNum(params.outputGainDb, -24, 24);
  const nyquist = sr / 2;
  return freqs.map((f) => {
    const freq = Math.min(nyquist * 0.9999, Math.max(1e-6, f));
    const w = (2 * Math.PI * freq) / sr;
    let mag = 1;
    for (const section of sections) {
      if (section.kind === "first-order") {
        mag *= firstOrderMagnitude(section.freqHz, sr, section.highpass, w);
      } else {
        mag *= biquadMagnitude(section.coeffs, w);
      }
    }
    return gainDb + 20 * Math.log10(Math.max(mag, 1e-12));
  });
}
