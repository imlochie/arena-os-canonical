/**
 * FDN reverb tests — real processing, no mocks. Energy decay, tail
 * extension, dry/wet honesty, decorrelation, and determinism.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyReverb,
  reverbTailFrames,
  type ReverbParams,
} from "./reverb";
import type { StereoBuffer } from "./dsp";

const FS = 48000;

function baseParams(overrides: Partial<ReverbParams> = {}): ReverbParams {
  return {
    model: "room",
    predelayMs: 0,
    decaySeconds: 0.5,
    sizePercent: 50,
    dampingHz: 8000,
    diffusionPercent: 70,
    widthPercent: 100,
    lowCutHz: 20,
    mix: 1,
    sampleRate: FS,
    ...overrides,
  };
}

/** Single-frame stereo impulse at the given sample. */
function impulse(frames: number, at = 0): StereoBuffer {
  const buffer = new Float32Array(frames * 2);
  buffer[at * 2] = 1;
  buffer[at * 2 + 1] = 1;
  return buffer;
}

function rms(buffer: StereoBuffer, fromFrame: number, toFrame: number): number {
  let sum = 0;
  let count = 0;
  for (let i = fromFrame * 2; i < toFrame * 2; i += 1) {
    sum += buffer[i] * buffer[i];
    count += 1;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

test("mix 0 returns the dry signal unchanged", () => {
  const input = impulse(1000, 10);
  const out = applyReverb(input, baseParams({ mix: 0 }));
  assert.equal(out.length, input.length + reverbTailFrames(baseParams({ mix: 0 })) * 2);
  for (let i = 0; i < input.length; i += 1) {
    assert.equal(out[i], input[i]);
  }
});

test("output extends beyond the input by the tail", () => {
  const input = impulse(FS / 2); // 0.5 s
  const params = baseParams({ decaySeconds: 1 });
  const out = applyReverb(input, params);
  const expectedFrames = FS / 2 + reverbTailFrames(params);
  assert.equal(out.length, expectedFrames * 2);
  // The wet-only region beyond the input must carry energy.
  const tailRms = rms(out, FS / 2 + 100, FS / 2 + FS / 2);
  assert.ok(tailRms > 1e-5, `tail should carry energy, rms=${tailRms}`);
});

test("tail energy decays with the RT60 target", () => {
  const input = impulse(FS / 4); // 250 ms of signal
  // decay 0.4 s: energy around 320 ms should be far below energy at 30..50 ms.
  const out = applyReverb(input, baseParams({ decaySeconds: 0.4 }));
  const early = rms(out, Math.floor(0.03 * FS), Math.floor(0.05 * FS));
  const late = rms(out, Math.floor(0.3 * FS), Math.floor(0.32 * FS));
  assert.ok(early > 0, `early reflections must carry energy (rms=${early})`);
  assert.ok(late < early * 0.2, `late (${late}) should be well below early (${early})`);
});

test("longer decay keeps more late energy", () => {
  const input = impulse(FS / 4);
  const short = applyReverb(input, baseParams({ decaySeconds: 0.4 }));
  const long = applyReverb(input, baseParams({ decaySeconds: 3 }));
  const window: [number, number] = [Math.floor(0.5 * FS), Math.floor(0.6 * FS)];
  const shortLate = rms(short, ...window);
  const longLate = rms(long, ...window);
  assert.ok(longLate > shortLate * 4, `long decay must retain more energy (${longLate} vs ${shortLate})`);
});

test("an impulse in one channel reaches both output channels", () => {
  const input = new Float32Array(FS); // 0.5 s, silence
  input[100 * 2] = 1; // left channel only
  const out = applyReverb(input, baseParams({ decaySeconds: 1 }));
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let i = 0; i < out.length; i += 2) {
    leftEnergy += out[i] * out[i];
    rightEnergy += out[i + 1] * out[i + 1];
  }
  assert.ok(leftEnergy > 0, "left must carry energy");
  assert.ok(rightEnergy > leftEnergy * 0.05, `right must be fed by the network (${rightEnergy} vs ${leftEnergy})`);
});

test("left and right tails are decorrelated", () => {
  const input = impulse(FS, 50);
  const out = applyReverb(input, baseParams({ decaySeconds: 1 }));
  let diff = 0;
  let total = 0;
  for (let i = 0; i < out.length; i += 2) {
    diff += Math.abs(out[i] - out[i + 1]);
    total += Math.abs(out[i]) + Math.abs(out[i + 1]);
  }
  assert.ok(total > 0);
  assert.ok(diff / total > 0.05, `channels should not be identical (${diff}/${total})`);
});

test("low cut attenuates low-frequency tail energy", () => {
  // 55 Hz sine burst: 0.5 s of tone, then compare tails at lowCut 20 vs 300 Hz.
  const frames = FS / 2;
  const input = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const v = Math.sin((2 * Math.PI * 55 * i) / FS) * 0.5;
    input[i * 2] = v;
    input[i * 2 + 1] = v;
  }
  const open = applyReverb(input, baseParams({ lowCutHz: 20, decaySeconds: 1 }));
  const cut = applyReverb(input, baseParams({ lowCutHz: 300, decaySeconds: 1 }));
  const window: [number, number] = [frames + 1000, frames + FS / 2];
  const openRms = rms(open, ...window);
  const cutRms = rms(cut, ...window);
  assert.ok(cutRms < openRms * 0.5, `low-cut must attenuate the bass tail (${cutRms} vs ${openRms})`);
});

test("HF damping attenuates high-frequency tail energy", () => {
  const frames = FS / 2;
  const input = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const v = Math.sin((2 * Math.PI * 6000 * i) / FS) * 0.5;
    input[i * 2] = v;
    input[i * 2 + 1] = v;
  }
  const open = applyReverb(input, baseParams({ dampingHz: 20000, decaySeconds: 1 }));
  const damped = applyReverb(input, baseParams({ dampingHz: 2000, decaySeconds: 1 }));
  const window: [number, number] = [frames + 1000, frames + FS / 2];
  const openRms = rms(open, ...window);
  const dampedRms = rms(damped, ...window);
  assert.ok(dampedRms < openRms, `damping must attenuate the HF tail (${dampedRms} vs ${openRms})`);
});

test("output is finite and bounded for extreme parameters", () => {
  const input = impulse(FS / 2, 0);
  for (const model of ["room", "plate"] as const) {
    const out = applyReverb(input, baseParams({
      model,
      decaySeconds: 20,
      sizePercent: 100,
      diffusionPercent: 100,
      predelayMs: 250,
      dampingHz: 1000,
      lowCutHz: 1000,
      widthPercent: 0,
    }));
    for (let i = 0; i < out.length; i += 1) {
      assert.ok(Number.isFinite(out[i]), `sample ${i} must be finite`);
      assert.ok(Math.abs(out[i]) <= 4, `sample ${i} must stay bounded (${out[i]})`);
    }
  }
});

test("processing is deterministic (LFO is seeded by the signal, not random)", () => {
  const input = impulse(FS, 20);
  const a = applyReverb(input, baseParams({ decaySeconds: 1.5 }));
  const b = applyReverb(input, baseParams({ decaySeconds: 1.5 }));
  assert.deepEqual(Array.from(a.slice(0, FS)), Array.from(b.slice(0, FS)));
});

test("plate model differs from room model", () => {
  const input = impulse(FS, 20);
  const room = applyReverb(input, baseParams({ model: "room", decaySeconds: 1 }));
  const plate = applyReverb(input, baseParams({ model: "plate", decaySeconds: 1 }));
  let diff = 0;
  const n = Math.min(room.length, plate.length);
  for (let i = 0; i < n; i += 1) diff += Math.abs(room[i] - plate[i]);
  assert.ok(diff > 0.01, `plate and room must produce different tails (diff=${diff})`);
});

test("pre-delay delays the first wet energy", () => {
  const input = impulse(64, 0);
  const instant = applyReverb(input, baseParams({ predelayMs: 0 }));
  const delayed = applyReverb(input, baseParams({ predelayMs: 50 }));
  const firstEnergy = (buf: StereoBuffer) => {
    for (let i = 0; i < buf.length; i += 1) if (Math.abs(buf[i]) > 1e-4) return i;
    return buf.length;
  };
  const instantFirst = firstEnergy(instant);
  const delayedFirst = firstEnergy(delayed);
  // 50 ms at 48 kHz = 2400 samples of delay; allow slack for the diffusers.
  assert.ok(delayedFirst >= instantFirst + FS * 0.045, `pre-delay must hold the wet back (${delayedFirst} vs ${instantFirst})`);
});

test("dry zero-padding: wet-only region has no dry leakage at partial mix", () => {
  const input = impulse(FS / 2, 10);
  const out = applyReverb(input, baseParams({ mix: 0.5, decaySeconds: 0.5 }));
  // Beyond the input the dry contribution is exactly zero, so the mix is a
  // pure scaled wet — finite and nonzero somewhere.
  const tailStart = FS / 2;
  let tailMax = 0;
  for (let i = tailStart * 2; i < out.length; i += 1) {
    tailMax = Math.max(tailMax, Math.abs(out[i]));
  }
  assert.ok(tailMax > 0, "wet-only tail must be nonzero at mix 0.5");
});
