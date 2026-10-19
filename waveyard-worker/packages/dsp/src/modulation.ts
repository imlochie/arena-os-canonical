/**
 * Modulation effects — chorus, flanger, phaser — offline whole-buffer
 * rendering.
 *
 * Adapted from SoundCraft's modulation plugins (crates/dsp/src/plugins/
 * modulation.rs), Copyright (c) 2026 ArtCraft Team and SoundCraft
 * contributors, dual-licensed MIT OR Apache-2.0
 * (https://github.com/storytold/soundcraft). Clean-room TypeScript port:
 * topology and constants preserved, realtime parameter smoothers dropped
 * (renders run with static parameters), output extended by the effect tail
 * with the dry signal zero-padded beyond the input length.
 *
 * Chorus/flanger: a modulated short delay per channel with feedback; the
 * right channel's LFO runs `spread` cycles ahead for stereo movement.
 * Phaser: a cascade of modulated first-order allpasses with feedback, the
 * center frequency swept ±2 octaves by depth.
 */

import { clamp } from "./types";
import type { StereoBuffer } from "./dsp";

const CHORUS_TAIL_MS = 200;
const PHASER_TAIL_MS = 100;
/** Longest chorus/flanger delay line (matches the source's 45 ms ceiling). */
const MOD_LINE_MAX_MS = 45;
/** Flanger sweeps may not read closer than 2 samples behind the write head. */
const MIN_READ_SAMPLES = 2;
const MOD_SPREAD_CYCLES = 0.25;

export type ModulationParams = {
  rateHz: number;
  /** 0..1 sweep depth. */
  depth: number;
  /** Base delay in ms. */
  delayMs: number;
  /** Feedback gain (may be negative for flanger/phaser). */
  feedback: number;
  /** Wet amount 0..1. */
  mix: number;
  sampleRate: number;
};

export type ChorusParams = ModulationParams & {
  /** 0..1 — right-channel LFO phase offset (0.25 cycles at full spread). */
  spread: number;
};

export type FlangerParams = ModulationParams;

export type PhaserParams = {
  rateHz: number;
  depth: number;
  /** Stage count; snapped to 2/4/6/8/12. */
  stages: number;
  feedback: number;
  centerHz: number;
  mix: number;
  sampleRate: number;
};

/** Mono ring delay with cubic (Catmull-Rom) interpolated reads. */
class CubicDelayLine {
  private readonly buf: Float32Array;
  private w = 0;

  constructor(lengthSamples: number) {
    this.buf = new Float32Array(Math.max(4, Math.floor(lengthSamples)));
  }

  push(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) % this.buf.length;
  }

  /** Cubic-interpolated read `delaySamples` behind the write head. */
  read(delaySamples: number): number {
    const len = this.buf.length;
    const d = clamp(delaySamples, MIN_READ_SAMPLES, len - 3);
    const i = Math.floor(d);
    const f = d - i;
    const at = (k: number) => this.buf[(this.w - k + 4 * len) % len];
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    return (
      p1 +
      0.5 * f * (p2 - p0) +
      0.5 * f * f * (2 * p0 - 5 * p1 + 4 * p2 - p3) +
      0.5 * f * f * f * (3 * p1 - p0 - 3 * p2 + p3)
    );
  }
}

function msToSamples(ms: number, sampleRate: number): number {
  return (ms / 1000) * sampleRate;
}

function sinAt(phase: number): number {
  return Math.sin(phase * 2 * Math.PI);
}

function channelPhase(phase: number, right: boolean, spread: number): number {
  const p = phase + (right ? spread : 0);
  return p >= 1 ? p - 1 : p;
}

type ChorusFlangerKind = "chorus" | "flanger";

function applyChorusFlanger(
  buffer: StereoBuffer,
  kind: ChorusFlangerKind,
  params: ModulationParams,
  spread: number,
): StereoBuffer {
  const sampleRate = Math.max(1, params.sampleRate);
  const inFrames = buffer.length / 2;
  const tailFrames = Math.ceil((CHORUS_TAIL_MS / 1000) * sampleRate);
  const outFrames = inFrames + tailFrames;

  const rate = clamp(params.rateHz, 0.02, 5);
  const depth = clamp(params.depth, 0, 1);
  const baseMs =
    kind === "chorus" ? clamp(params.delayMs, 5, 30) : clamp(params.delayMs, 0.1, 10);
  const feedback = clamp(params.feedback, -0.95, 0.95);
  const mix = clamp(params.mix, 0, 1);
  const dry = 1 - mix;

  const lineL = new CubicDelayLine(msToSamples(MOD_LINE_MAX_MS, sampleRate) + 8);
  const lineR = new CubicDelayLine(msToSamples(MOD_LINE_MAX_MS, sampleRate) + 8);
  let fbL = 0;
  let fbR = 0;
  let phase = 0;
  const inc = rate / sampleRate;

  const out = new Float32Array(outFrames * 2);
  for (let n = 0; n < outFrames; n += 1) {
    const inRange = n < inFrames;
    const xl = inRange && Number.isFinite(buffer[n * 2]) ? buffer[n * 2] : 0;
    const xr = inRange && Number.isFinite(buffer[n * 2 + 1]) ? buffer[n * 2 + 1] : xl;

    phase += inc;
    if (phase >= 1) phase -= 1;

    for (let c = 0; c < 2; c += 1) {
      const x = c === 0 ? xl : xr;
      const line = c === 0 ? lineL : lineR;
      const fbPrev = c === 0 ? fbL : fbR;
      const s = sinAt(channelPhase(phase, c === 1, spread));
      const ms =
        kind === "chorus"
          ? baseMs + depth * 6 * 0.5 * (1 + s) // up to +6 ms of sweep
          : Math.max(baseMs * (1 - depth * 0.5 * (1 - s)), 0.05); // (1−depth)·base .. base
      line.push(x + feedback * fbPrev);
      const y = line.read(Math.max(msToSamples(ms, sampleRate), MIN_READ_SAMPLES));
      if (c === 0) fbL = y;
      else fbR = y;
      const wet = y;
      out[n * 2 + c] = x * dry + wet * mix;
    }
  }
  return out;
}

export function applyChorus(buffer: StereoBuffer, params: ChorusParams): StereoBuffer {
  const spread = MOD_SPREAD_CYCLES * clamp(params.spread, 0, 1);
  return applyChorusFlanger(buffer, "chorus", params, spread);
}

export function applyFlanger(buffer: StereoBuffer, params: FlangerParams): StereoBuffer {
  // The flanger's channels share a fixed quarter-cycle offset.
  return applyChorusFlanger(buffer, "flanger", params, MOD_SPREAD_CYCLES);
}

const PHASER_STAGE_CHOICES = [2, 4, 6, 8, 12] as const;

function snapStages(stages: number): number {
  const s = clamp(stages, 2, 12);
  let best: number = PHASER_STAGE_CHOICES[0];
  for (const choice of PHASER_STAGE_CHOICES) {
    if (Math.abs(choice - s) < Math.abs(best - s)) best = choice;
  }
  return best;
}

export function applyPhaser(buffer: StereoBuffer, params: PhaserParams): StereoBuffer {
  const sampleRate = Math.max(1, params.sampleRate);
  const inFrames = buffer.length / 2;
  const tailFrames = Math.ceil((PHASER_TAIL_MS / 1000) * sampleRate);
  const outFrames = inFrames + tailFrames;

  const rate = clamp(params.rateHz, 0.02, 5);
  const depth = clamp(params.depth, 0, 1);
  const stages = snapStages(params.stages);
  const feedback = clamp(params.feedback, -0.95, 0.95);
  const center = clamp(params.centerHz, 100, 4000);
  const mix = clamp(params.mix, 0, 1);
  const dry = 1 - mix;

  const nyquist = sampleRate * 0.45;
  const zL = new Float32Array(12);
  const zR = new Float32Array(12);
  let fbL = 0;
  let fbR = 0;
  let phase = 0;
  const inc = rate / sampleRate;

  const out = new Float32Array(outFrames * 2);
  for (let n = 0; n < outFrames; n += 1) {
    const inRange = n < inFrames;
    const xl = inRange && Number.isFinite(buffer[n * 2]) ? buffer[n * 2] : 0;
    const xr = inRange && Number.isFinite(buffer[n * 2 + 1]) ? buffer[n * 2 + 1] : xl;

    phase += inc;
    if (phase >= 1) phase -= 1;

    for (let c = 0; c < 2; c += 1) {
      const x = c === 0 ? xl : xr;
      const z = c === 0 ? zL : zR;
      const fbPrev = c === 0 ? fbL : fbR;
      const s = sinAt(channelPhase(phase, c === 1, MOD_SPREAD_CYCLES));
      const f = clamp(center * Math.pow(2, 2 * depth * s), 20, nyquist);
      const t = Math.tan((Math.PI * f) / sampleRate);
      const a = (t - 1) / (t + 1);
      let y = x + feedback * fbPrev;
      for (let i = 0; i < stages; i += 1) {
        const stageOut = a * y + z[i];
        z[i] = y - a * stageOut;
        y = stageOut;
      }
      if (c === 0) fbL = y;
      else fbR = y;
      out[n * 2 + c] = x * dry + y * mix;
    }
  }
  return out;
}

/** Declared effect tails (ms) — offline renders extend the buffer by these. */
export const MODULATION_TAIL_MS = {
  chorus: CHORUS_TAIL_MS,
  flanger: CHORUS_TAIL_MS,
  phaser: PHASER_TAIL_MS,
} as const;
