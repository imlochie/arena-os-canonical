/**
 * EQ 7-band tests — analytic response verification plus real audio checks:
 * flat passthrough, shelf/peak behaviour, filter slopes, gain staging.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyEq7, eq7ResponseDb, type Eq7Params } from "./eq7";
import { dbToGain, gainToDb } from "./gain";
import type { StereoBuffer } from "./dsp";

const FS = 48000;

function params(overrides: Partial<Eq7Params> = {}): Eq7Params {
  return {
    inputGainDb: 0,
    hpfOn: 0,
    hpfHz: 80,
    hpfSlope: 1,
    lfHz: 100,
    lfGainDb: 0,
    lfQ: 0.707,
    lmfHz: 250,
    lmfGainDb: 0,
    lmfQ: 1,
    mfHz: 1000,
    mfGainDb: 0,
    mfQ: 1,
    hmfHz: 4000,
    hmfGainDb: 0,
    hmfQ: 1,
    hfHz: 8000,
    hfGainDb: 0,
    hfQ: 0.707,
    lpfOn: 0,
    lpfHz: 18000,
    lpfSlope: 1,
    outputGainDb: 0,
    sampleRate: FS,
    ...overrides,
  };
}

function sine(seconds: number, freqHz: number, amplitude: number): StereoBuffer {
  const frames = Math.round(seconds * FS);
  const buffer = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const v = Math.sin((2 * Math.PI * freqHz * i) / FS) * amplitude;
    buffer[i * 2] = v;
    buffer[i * 2 + 1] = v;
  }
  return buffer;
}

function rmsDb(buffer: StereoBuffer, skipSeconds = 0.2): number {
  const start = Math.round(skipSeconds * FS) * 2;
  let sum = 0;
  let count = 0;
  for (let i = start; i < buffer.length; i += 1) {
    sum += buffer[i] * buffer[i];
    count += 1;
  }
  return gainToDb(Math.sqrt(sum / Math.max(1, count)));
}

/** Rendered gain of `params` at a sine frequency, RELATIVE to the input. */
function renderedGainDb(freqHz: number, p: Eq7Params): number {
  const input = sine(1, freqHz, 0.3);
  const out = Float32Array.from(input);
  applyEq7(out, p);
  return rmsDb(out) - rmsDb(input);
}

test("flat EQ (all bands 0, filters off) is a near-identity", () => {
  const input = sine(1, 1000, 0.3);
  const out = Float32Array.from(input);
  applyEq7(out, params());
  let maxDiff = 0;
  for (let i = 0; i < input.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(input[i] - out[i]));
  }
  assert.ok(maxDiff < 1e-9, `flat EQ must not touch the signal (maxDiff=${maxDiff})`);
});

test("low shelf boost raises lows relative to mids by the shelf gain", () => {
  const p = params({ lfGainDb: 9 });
  // 40 Hz is on the plateau of a 100 Hz corner shelf; 1 kHz is far above it.
  const rel = renderedGainDb(40, p) - renderedGainDb(1000, p);
  assert.ok(rel > 7 && rel < 11, `40 Hz vs 1 kHz relative gain was ${rel} dB (want ~9)`);
});

test("high shelf cut lowers highs relative to mids", () => {
  const p = params({ hfGainDb: -9 });
  const rel = renderedGainDb(16000, p) - renderedGainDb(1000, p);
  assert.ok(rel < -7 && rel > -11, `16 kHz vs 1 kHz relative gain was ${rel} dB (want ~−9)`);
});

test("peaking band boosts its centre and barely moves far frequencies", () => {
  const p = params({ mfGainDb: 12, mfQ: 2 });
  const centreDb = renderedGainDb(1000, p);
  const farDb = renderedGainDb(120, p);
  assert.ok(centreDb > 10.5, `centre must gain ~12 dB (got ${centreDb})`);
  assert.ok(Math.abs(farDb) < 1.5, `far frequency must stay flat (got ${farDb})`);
});

test("high-pass attenuates below its cutoff", () => {
  const p = params({ hpfOn: 1, hpfHz: 200, hpfSlope: 3 }); // 24 dB/oct
  assert.ok(renderedGainDb(60, p) < -25, `60 Hz must be deeply cut (got ${renderedGainDb(60, p)} dB)`);
  assert.ok(Math.abs(renderedGainDb(2000, p)) < 1.5, `2 kHz must pass (got ${renderedGainDb(2000, p)} dB)`);
});

test("low-pass attenuates above its cutoff", () => {
  const p = params({ lpfOn: 1, lpfHz: 2000, lpfSlope: 3 });
  assert.ok(renderedGainDb(12000, p) < -30, `12 kHz must be deeply cut (got ${renderedGainDb(12000, p)} dB)`);
  assert.ok(Math.abs(renderedGainDb(500, p)) < 1.5, `500 Hz must pass (got ${renderedGainDb(500, p)} dB)`);
});

test("input + output gains are applied as one scalar", () => {
  const p = params({ inputGainDb: -6, outputGainDb: -6 });
  const input = sine(1, 1000, 0.3);
  const out = Float32Array.from(input);
  applyEq7(out, p);
  const expected = rmsDb(input) - 12;
  const got = rmsDb(out);
  assert.ok(Math.abs(got - expected) < 0.2, `${got} dB vs expected ${expected} dB`);
});

test("analytic response matches the rendered audio within a dB", () => {
  const p = params({ lfGainDb: 6, mfGainDb: -4, mfQ: 2, hpfOn: 1, hpfHz: 100 });
  const freqs = [80, 300, 1000, 4000];
  const response = eq7ResponseDb(p, freqs, FS);
  for (let i = 0; i < freqs.length; i += 1) {
    const rendered = Float32Array.from(sine(1, freqs[i], 0.3));
    applyEq7(rendered, p);
    const measured = rmsDb(rendered) - rmsDb(sine(1, freqs[i], 0.3));
    assert.ok(
      Math.abs(measured - response[i]) < 1.0,
      `${freqs[i]} Hz: analytic ${response[i].toFixed(2)} vs rendered ${measured.toFixed(2)}`,
    );
  }
});

test("analytic response sanity: shelf gains and unity at centre", () => {
  const flat = eq7ResponseDb(params(), [100, 1000, 10000], FS);
  for (const db of flat) assert.ok(Math.abs(db) < 1e-6, `flat response ${db}`);
  const boosted = eq7ResponseDb(params({ lfGainDb: 12 }), [20, 1000], FS);
  assert.ok(boosted[0] > 11, `shelf plateau ${boosted[0]}`);
  assert.ok(Math.abs(boosted[1]) < 0.5, `mid stays flat ${boosted[1]}`);
  // Slopes: 6 dB/oct first-order halves gain per octave near cutoff.
  const hpf6 = eq7ResponseDb(params({ hpfOn: 1, hpfHz: 1000, hpfSlope: 0 }), [500, 250], FS);
  assert.ok(hpf6[0] - hpf6[1] > 4, `first-order rolloff ${hpf6[0] - hpf6[1]} dB/octave-ish`);
});

test("eq7 stays finite for wild settings and bounded for a hot mix", () => {
  // Wild: every band and both gains maxed. Cascaded +24 dB bands on a
  // full-scale input legitimately reach enormous numbers; the invariant is
  // that every coefficient stays stable and every sample finite.
  const wild = params({
    inputGainDb: 24,
    lfGainDb: 24,
    lmfGainDb: 24,
    mfGainDb: 24,
    hmfGainDb: 24,
    hfGainDb: 24,
    hpfOn: 1,
    lpfOn: 1,
  });
  const hot = Float32Array.from(sine(0.5, 1000, 1.0));
  applyEq7(hot, wild);
  for (let i = 0; i < hot.length; i += 1) {
    assert.ok(Number.isFinite(hot[i]), `wild sample ${i} must be finite`);
  }
  // A realistic hot mix (+12 dB bands, +12 dB input) must stay below the
  // theoretical cascade ceiling of ~+72 dBFS.
  const loud = params({ inputGainDb: 12, lfGainDb: 12, lmfGainDb: 12, mfGainDb: 12, hmfGainDb: 12, hfGainDb: 12 });
  const out = Float32Array.from(sine(0.5, 1000, 1.0));
  applyEq7(out, loud);
  let peak = 0;
  for (let i = 0; i < out.length; i += 1) {
    assert.ok(Number.isFinite(out[i]), `loud sample ${i} must be finite`);
    peak = Math.max(peak, Math.abs(out[i]));
  }
  assert.ok(peak <= dbToGain(72), `peak must stay under the cascade ceiling (${peak})`);
});
