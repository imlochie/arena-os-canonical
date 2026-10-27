/**
 * FDN reverb (room + plate models) — offline whole-buffer rendering.
 *
 * Adapted from SoundCraft's room/plate reverb (crates/dsp/src/plugins/
 * reverb.rs), Copyright (c) 2026 ArtCraft Team and SoundCraft contributors,
 * dual-licensed MIT OR Apache-2.0 (https://github.com/storytold/soundcraft).
 * This is a clean-room TypeScript port for Waveyard's offline insert path:
 * the algorithm and topology are preserved, the real-time parameter smoothers
 * are dropped because renders run with static parameters over whole buffers.
 *
 * Topology: pre-delay → allpass input diffusion → 8-line feedback delay
 * network (Hadamard mixing, per-line RT60 gains, in-loop HF damping, gentle
 * delay modulation) → low-cut → stereo width → dry/wet mix. The output is a
 * NEW buffer longer than the input: it carries the reverb tail, and the dry
 * signal is zero-padded beyond the input length (wet-only tail).
 */

import {
  applyBiquad,
  applyStereoWidth,
  designBiquad,
  newBiquadState,
  type StereoBuffer,
} from "./dsp";
import { clamp } from "./types";

const LINES = 8;
const DIFFUSERS = 4;
const MAX_PREDELAY_MS = 250;
const SIZE_MIN = 0.35;
const SIZE_MAX = 1.6;
/** Right-side diffusers run 7.1% longer to decorrelate the channels. */
const RIGHT_SPREAD = 1.071;

export type ReverbModel = "room" | "plate";

type ReverbConfig = {
  /** FDN line base delays (ms) — mutually prime-ish for a smooth tail. */
  delaysMs: readonly number[];
  /** Input diffuser allpass delays (ms). */
  diffusersMs: readonly number[];
  /** LFO depth (ms) and rate (Hz) for delay modulation. */
  modMs: number;
  modHz: number;
};

const ROOM: ReverbConfig = {
  delaysMs: [23.13, 27.71, 31.87, 36.29, 41.33, 45.67, 51.09, 56.93],
  diffusersMs: [4.71, 3.59, 12.73, 9.31],
  modMs: 0.25,
  modHz: 0.7,
};

const PLATE: ReverbConfig = {
  delaysMs: [13.71, 17.93, 21.07, 24.73, 28.31, 32.89, 36.13, 40.31],
  diffusersMs: [3.13, 4.27, 7.93, 11.29],
  modMs: 0.4,
  modHz: 1.1,
};

export type ReverbParams = {
  model: ReverbModel;
  predelayMs: number; // 0..250
  decaySeconds: number; // 0.1..20 (RT60)
  sizePercent: number; // 0..100 → line-delay scale 0.35..1.6
  dampingHz: number; // 1000..20000 in-loop HF damping
  diffusionPercent: number; // 0..100
  widthPercent: number; // 0..100
  lowCutHz: number; // 20..1000 high-pass on the wet signal
  mix: number; // 0..1 wet amount
  sampleRate: number;
};

/** Force denormals to zero so long decays never degrade to denormal math. */
function flush(x: number): number {
  return Math.abs(x) < 1e-20 ? 0 : x;
}

function msToSamples(ms: number, sampleRate: number): number {
  return (ms / 1000) * sampleRate;
}

/** Ring delay with linear-interpolated reads (delay >= 1 sample). */
class DelayLine {
  private readonly buf: Float32Array;
  private w = 0;

  constructor(lengthSamples: number) {
    this.buf = new Float32Array(Math.max(1, Math.floor(lengthSamples)));
  }

  push(x: number): void {
    this.buf[this.w] = flush(x);
    this.w = (this.w + 1) % this.buf.length;
  }

  /** Read the sample `delaySamples` behind the write head, interpolated. */
  read(delaySamples: number): number {
    const len = this.buf.length;
    const d = clamp(delaySamples, 1, len - 1);
    const i1 = Math.floor(d);
    const frac = d - i1;
    const newer = this.buf[(this.w - i1 + 2 * len) % len]; // delay i1
    const older = this.buf[(this.w - i1 - 1 + 2 * len) % len]; // delay i1+1
    return newer + (older - newer) * frac;
  }
}

/** Schroeder allpass with a fixed integer delay. */
class Allpass {
  private readonly buf: Float32Array;
  private pos = 0;

  constructor(lengthSamples: number) {
    this.buf = new Float32Array(Math.max(1, Math.floor(lengthSamples)));
  }

  process(x: number, g: number): number {
    const d = this.buf[this.pos];
    const v = x + g * d;
    this.buf[this.pos] = flush(v);
    this.pos = (this.pos + 1) % this.buf.length;
    return d - g * v;
  }
}

/** In-place normalized 8-point fast Walsh–Hadamard transform. */
function hadamard8(v: Float32Array): void {
  for (let h = 1; h < LINES; h *= 2) {
    for (let i = 0; i < LINES; i += h * 2) {
      for (let j = i; j < i + h; j += 1) {
        const a = v[j];
        const b = v[j + h];
        v[j] = a + b;
        v[j + h] = a - b;
      }
    }
  }
  const s = 1 / Math.sqrt(LINES);
  for (let i = 0; i < LINES; i += 1) v[i] *= s;
}

/** Frames of tail the reverb adds beyond the input length. */
export function reverbTailFrames(params: ReverbParams): number {
  const decay = clamp(params.decaySeconds, 0.1, 20);
  const predelay = clamp(params.predelayMs, 0, MAX_PREDELAY_MS);
  const seconds = decay * 1.3 + predelay * 0.001 + 0.1;
  return Math.ceil(seconds * params.sampleRate);
}

/**
 * Render the reverb over `buffer`. Returns a new interleaved buffer of
 * `input frames + tail frames`; the input is untouched.
 */
export function applyReverb(buffer: StereoBuffer, params: ReverbParams): StereoBuffer {
  const cfg = params.model === "plate" ? PLATE : ROOM;
  const sampleRate = Math.max(1, params.sampleRate);
  const inFrames = buffer.length / 2;
  const outFrames = inFrames + reverbTailFrames(params);

  const predelaySamples = msToSamples(clamp(params.predelayMs, 0, MAX_PREDELAY_MS), sampleRate);
  const rt60 = Math.max(0.05, clamp(params.decaySeconds, 0.1, 20));
  const size = SIZE_MIN + (SIZE_MAX - SIZE_MIN) * (clamp(params.sizePercent, 0, 100) / 100);
  const damp = Math.exp((-2 * Math.PI * clamp(params.dampingHz, 1000, 20000)) / sampleRate);
  const gDiff = (0.7 * clamp(params.diffusionPercent, 0, 100)) / 100;
  const width = clamp(params.widthPercent, 0, 100) / 100;
  const mix = clamp(params.mix, 0, 1);

  // Per-line feedback gain for the target RT60 at the current size.
  const gains = new Float32Array(LINES);
  const base = new Float32Array(LINES);
  for (let i = 0; i < LINES; i += 1) {
    const seconds = (cfg.delaysMs[i] * size) / 1000;
    gains[i] = Math.min(Math.pow(10, (-3 * seconds) / rt60), 0.9999);
    base[i] = msToSamples(cfg.delaysMs[i] * size, sampleRate);
  }

  const preDelay: DelayLine[] = [
    new DelayLine(msToSamples(MAX_PREDELAY_MS, sampleRate) + 4),
    new DelayLine(msToSamples(MAX_PREDELAY_MS, sampleRate) + 4),
  ];
  const diffusers: Allpass[][] = [0, 1].map((side) => {
    const spread = side === 0 ? 1 : RIGHT_SPREAD;
    return cfg.diffusersMs.map((ms) => new Allpass(msToSamples(ms * spread, sampleRate)));
  });
  const modDepth = msToSamples(cfg.modMs, sampleRate);
  const lfoInc = cfg.modHz / sampleRate;
  const lines: DelayLine[] = cfg.delaysMs.map(
    (ms) => new DelayLine(msToSamples(ms * SIZE_MAX, sampleRate) + modDepth + 4),
  );

  const wet = new Float32Array(outFrames * 2);
  const lp = new Float32Array(LINES);
  const o = new Float32Array(LINES);
  const fb = new Float32Array(LINES);
  let lfo = 0;

  for (let n = 0; n < outFrames; n += 1) {
    const inRange = n < inFrames;
    const xl = inRange && Number.isFinite(buffer[n * 2]) ? buffer[n * 2] : 0;
    const xr = inRange && Number.isFinite(buffer[n * 2 + 1]) ? buffer[n * 2 + 1] : xl;

    // Pre-delay, then input diffusion, per side.
    const ins: [number, number] = [xl, xr];
    for (let side = 0; side < 2; side += 1) {
      const d = preDelay[side];
      d.push(ins[side]);
      let v = predelaySamples < 1 ? ins[side] : d.read(predelaySamples);
      for (const ap of diffusers[side]) {
        v = ap.process(v, gDiff);
      }
      ins[side] = v;
    }

    // Delay modulation: shared LFO, alternating phase per line.
    lfo += lfoInc;
    if (lfo >= 1) lfo -= 1;
    const phase = lfo * 2 * Math.PI;
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const mods = [0, s, 0, c, 0, -s, 0, -c];

    // Read every line, damp the highs in-loop, and mix the feedback bus.
    for (let i = 0; i < LINES; i += 1) {
      const raw = lines[i].read(base[i] + modDepth * (1 + mods[i]));
      lp[i] = flush(raw + (lp[i] - raw) * damp);
      o[i] = raw;
      fb[i] = lp[i] * gains[i];
    }
    hadamard8(fb);
    // Even lines carry the left input, odd lines the right (scaled 0.5).
    for (let i = 0; i < LINES; i += 1) {
      lines[i].push(fb[i] + ins[i % 2] * 0.5);
    }

    // Output taps: alternating sums decorrelate left/right.
    wet[n * 2] = 0.4 * (o[0] - o[2] + o[4] - o[6]);
    wet[n * 2 + 1] = 0.4 * (o[1] - o[3] + o[5] - o[7]);
  }

  // Low-cut the wet signal (per-side high-pass biquad).
  const lowCut = clamp(params.lowCutHz, 20, 1000);
  const lowCutCoeffs = designBiquad({ type: "highpass", freqHz: lowCut, q: Math.SQRT1_2 }, sampleRate);
  applyBiquad(wet, lowCutCoeffs, newBiquadState(), newBiquadState());

  // Stereo width (mid/side) on the wet signal.
  if (width !== 1) applyStereoWidth(wet, width);

  // Dry/wet mix; dry is zero beyond the input length (wet-only tail).
  const out = new Float32Array(outFrames * 2);
  const dry = 1 - mix;
  for (let i = 0; i < out.length; i += 1) {
    const d = i < buffer.length ? buffer[i] : 0;
    out[i] = d * dry + wet[i] * mix;
  }
  return out;
}
