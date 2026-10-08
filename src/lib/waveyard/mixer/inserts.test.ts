/**
 * Insert chain tests — serialization, ordering, bypass, validation, and
 * REAL processing through the chain (no mocks).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  INSERT_PARAM_RANGES,
  addInsert,
  makeInsert,
  moveInsert,
  parseInserts,
  processWithChain,
  removeInsert,
  serializeInserts,
  toggleInsert,
  validateInsertParams,
  type InsertChain,
} from "./inserts";
import { applySoftClipCeiling, designBiquad, applyBiquad, newBiquadState, type StereoBuffer } from "./dsp";
import { gainToDb, dbToGain } from "./gain";

const FS = 48000;

function sine(seconds: number, freqHz: number, amplitude: number): StereoBuffer {
  const frames = Math.round(seconds * FS);
  const buffer = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = amplitude * Math.sin((2 * Math.PI * freqHz * i) / FS);
    buffer[i * 2] = v;
    buffer[i * 2 + 1] = v;
  }
  return buffer;
}

function rmsDb(buffer: StereoBuffer): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return gainToDb(Math.sqrt(sum / buffer.length));
}

test("every registry processor has declared ranges and constructs", () => {
  for (const [processor, ranges] of Object.entries(INSERT_PARAM_RANGES)) {
    const insert = makeInsert(processor as never, {});
    assert.notEqual(insert, null, `${processor} failed to construct`);
    for (const [key, range] of Object.entries(ranges)) {
      assert.ok(insert!.params[key] >= range.min && insert!.params[key] <= range.max, `${processor}.${key} default out of range`);
    }
  }
  assert.equal(makeInsert("no-such-processor" as never, {}), null);
});

test("validateInsertParams clamps out-of-range values and records them", () => {
  const validation = validateInsertParams("eq-band", { freqHz: 999999, gainDb: -500, q: 1 });
  assert.notEqual(validation, null);
  assert.deepEqual(validation!.clamped.sort(), ["freqHz", "gainDb"]);
  assert.equal(validation!.params.freqHz, INSERT_PARAM_RANGES["eq-band"].freqHz.max);
  assert.equal(validation!.params.gainDb, INSERT_PARAM_RANGES["eq-band"].gainDb.min);
  // Non-numeric or unknown keys reject the whole insert (strict).
  assert.equal(validateInsertParams("eq-band", { freqHz: "high" }), null);
  assert.equal(validateInsertParams("eq-band", { mystery: 1 }), null);
});

test("chain ops: add, remove, move, toggle are pure", () => {
  const a = makeInsert("gain", { gainDb: 3 })!;
  const b = makeInsert("highpass", { cutoffHz: 80 })!;
  const c = makeInsert("softclip", { ceilingDb: -1 })!;
  let chain: InsertChain = [a, b, c];
  const snapshot = JSON.stringify(chain);

  assert.equal(moveInsert(chain, 0, 2)[2].id, a.id);
  assert.equal(moveInsert(chain, 5, 0).length, 3); // out of range is a no-op
  assert.equal(removeInsert(chain, b.id).length, 2);
  assert.equal(toggleInsert(chain, b.id).find((i) => i.id === b.id)!.enabled, false);
  assert.equal(JSON.stringify(chain), snapshot); // originals untouched
  assert.equal(addInsert(chain, makeInsert("gate", {})!).length, 4);
});

test("chain serialization round-trips and rejects corrupt data", () => {
  const chain: InsertChain = [
    makeInsert("highpass", { cutoffHz: 90 })!,
    makeInsert("eq-band", { freqHz: 3000, gainDb: 3 })!,
  ];
  const parsed = parseInserts(JSON.parse(serializeInserts(chain)));
  assert.notEqual(parsed, null);
  assert.deepEqual(parsed!.map((i) => i.processor), ["highpass", "eq-band"]);
  assert.equal(parseInserts({ format: "wrong" }), null);
  assert.equal(parseInserts({ format: "waveyard-inserts-v1", inserts: [{ id: "x", processor: "unknown", enabled: true, wet: 1, params: {} }] }), null);
});

test("processWithChain really processes: EQ boost is measurable", () => {
  // processWithChain mutates its input — capture the dry level first.
  const dry = sine(0.5, 1000, 0.25);
  const dryRms = rmsDb(dry);
  const chain: InsertChain = [makeInsert("eq-band", { freqHz: 1000, gainDb: 6, q: 1 })!];
  const out = processWithChain(Float32Array.from(dry), chain, FS);
  assert.ok(rmsDb(out) - dryRms > 4.5, `boost was ${rmsDb(out) - dryRms} dB`);
});

test("bypassed inserts are skipped; ceiling guarantees hold when the clipper runs LAST", () => {
  const source = sine(0.5, 1000, 1.1); // hot signal
  // Professional ordering: filter first, ceiling last. A biquad's zero-state
  // transient can push peaks slightly above an earlier clipper's ceiling,
  // so a soft ceiling only guarantees the final peak when nothing follows it.
  const hpThenClip: InsertChain = [
    makeInsert("highpass", { cutoffHz: 20 })!,
    makeInsert("softclip", { ceilingDb: -6 })!,
  ];
  const out = processWithChain(Float32Array.from(source), hpThenClip, FS);
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  assert.ok(peak <= dbToGain(-6) + 1e-6, `peak ${gainToDb(peak)} dB`);

  const bypassed: InsertChain = [makeInsert("softclip", { ceilingDb: -6 }, { enabled: false })!];
  const out2 = processWithChain(Float32Array.from(source), bypassed, FS);
  let peak2 = 0;
  for (let i = 0; i < out2.length; i++) peak2 = Math.max(peak2, Math.abs(out2[i]));
  assert.ok(peak2 > 1.0); // untouched hot signal
});

test("dry/wet blends between processed and unprocessed", () => {
  const source = sine(0.5, 1000, 0.25);
  const chain: InsertChain = [makeInsert("gain", { gainDb: -40 }, { wet: 0.5 })!];
  const out = processWithChain(Float32Array.from(source), chain, FS);
  const delta = rmsDb(source) - rmsDb(out);
  // 50% mix of −40 dB path: roughly −6 dB total attenuation.
  assert.ok(delta > 4 && delta < 9, `delta was ${delta} dB`);
});

test("reverb inserts validate params and apply defaults", () => {
  for (const processor of ["reverb", "plate-reverb"] as const) {
    const insert = makeInsert(processor, { decaySeconds: 99, bogus: 1 });
    assert.equal(insert, null, `unknown param must invalidate (${processor})`);
    const clamped = makeInsert(processor, { decaySeconds: 99 })!;
    assert.equal(clamped.params.decaySeconds, 20, "decay clamps to range max");
    assert.equal(clamped.params.widthPercent, 100, "defaults fill missing params");
  }
});

test("reverb insert renders a tail through the chain", () => {
  const source = new Float32Array(FS); // FS samples = FS/2 interleaved frames
  // Impulse near the END of the input so the tail region carries fresh energy.
  const lastFrame = FS / 2 - 240;
  source[lastFrame * 2] = 1;
  source[lastFrame * 2 + 1] = 1;
  const chain: InsertChain = [makeInsert("reverb", { decaySeconds: 0.6 }, { wet: 1 })!];
  const out = processWithChain(Float32Array.from(source), chain, FS);
  assert.ok(out.length > source.length, "reverb must extend the buffer with its tail");
  let tailEnergy = 0;
  for (let i = source.length; i < out.length; i += 1) tailEnergy += out[i] * out[i];
  assert.ok(tailEnergy > 1e-6, `tail region must carry energy (${tailEnergy})`);
});

test("partial wet keeps the reverb tail (dry is zero-padded)", () => {
  const source = new Float32Array(FS);
  const lastFrame = FS / 2 - 240;
  source[lastFrame * 2] = 1;
  source[lastFrame * 2 + 1] = 1;
  const chain: InsertChain = [makeInsert("plate-reverb", { decaySeconds: 0.6 }, { wet: 0.3 })!];
  const out = processWithChain(Float32Array.from(source), chain, FS);
  assert.ok(out.length > source.length, "partial wet must not truncate the tail");
  let tailEnergy = 0;
  for (let i = source.length; i < out.length; i += 1) tailEnergy += out[i] * out[i];
  assert.ok(tailEnergy > 1e-8, "wet-only tail must survive the dry/wet mix");
  // Dry region keeps its impulse: mix 0.3 of a wet that starts later, so the
  // impulse sample itself is dominated by the dry contribution.
  const impulseIdx = (FS / 2 - 240) * 2;
  assert.ok(Math.abs(out[impulseIdx] - 1 * 0.7) < 0.35, `impulse survives at ${out[impulseIdx]}`);
});

test("reverb bypass leaves the signal untouched", () => {
  const source = new Float32Array(FS);
  source[50 * 2] = 0.5;
  source[50 * 2 + 1] = 0.5;
  const chain: InsertChain = [
    makeInsert("reverb", { decaySeconds: 2 }, { enabled: false })!,
  ];
  const out = processWithChain(Float32Array.from(source), chain, FS);
  assert.equal(out.length, source.length, "bypassed reverb must not extend the buffer");
  let bypassDiff = 0;
  for (let i = 0; i < source.length; i += 1) {
    bypassDiff = Math.max(bypassDiff, Math.abs(out[i] - source[i]));
  }
  assert.ok(bypassDiff === 0, `bypassed reverb must be an identity (${bypassDiff})`);
});

test("modulation and dynamics inserts validate params and fill defaults", () => {
  const chorus = makeInsert("chorus", { rateHz: 99 })!;
  assert.equal(chorus.params.rateHz, 5, "rate clamps to range max");
  assert.equal(chorus.params.mix, 0.5, "chorus mix default");
  assert.equal(makeInsert("flanger", { nope: 1 }), null, "unknown param invalidates");
  const max = makeInsert("maximizer")!;
  assert.equal(max.params.ceilingDb, -0.3, "maximizer ceiling default");
  const deess = makeInsert("de-esser")!;
  assert.equal(deess.params.freqHz, 6000, "de-esser freq default");
  assert.equal(makeInsert("phaser", { stages: 99 })!.params.stages, 12, "stages clamp");
});

test("chorus/flanger/phaser render tails through the chain", () => {
  const source = sine(0.25, 440, 0.3);
  for (const processor of ["chorus", "flanger", "phaser"] as const) {
    const chain: InsertChain = [makeInsert(processor, {}, { wet: 1 })!];
    const out = processWithChain(Float32Array.from(source), chain, FS);
    assert.ok(out.length > source.length, `${processor} must extend the buffer`);
    for (let i = 0; i < out.length; i += 1) {
      assert.ok(Number.isFinite(out[i]), `${processor} sample ${i} finite`);
    }
  }
});

test("de-esser and maximizer keep the buffer length", () => {
  const source = sine(0.25, 440, 0.3);
  for (const processor of ["de-esser", "maximizer"] as const) {
    const chain: InsertChain = [makeInsert(processor)!];
    const out = processWithChain(Float32Array.from(source), chain, FS);
    assert.equal(out.length, source.length, `${processor} length`);
  }
});

test("maximizer insert enforces its ceiling on a hot signal", () => {
  const frames = FS / 2;
  const source = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const v = Math.sin((2 * Math.PI * 220 * i) / FS) >= 0 ? 1 : -1;
    source[i * 2] = v;
    source[i * 2 + 1] = v;
  }
  const chain: InsertChain = [makeInsert("maximizer", { ceilingDb: -1 })!];
  const out = processWithChain(Float32Array.from(source), chain, FS);
  const ceiling = dbToGain(-1);
  let peak = 0;
  for (let i = 0; i < out.length; i += 1) peak = Math.max(peak, Math.abs(out[i]));
  assert.ok(peak <= ceiling + 1e-6, `chain must respect the ceiling (${gainToDb(peak)} dBFS)`);
});

test("de-esser insert leaves a bass stem essentially untouched", () => {
  const source = sine(0.5, 150, 0.3);
  const chain: InsertChain = [makeInsert("de-esser", { thresholdDb: -30, rangeDb: 12 })!];
  const out = processWithChain(Float32Array.from(source), chain, FS);
  let maxDiff = 0;
  for (let i = 0; i < source.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(source[i] - out[i]));
  }
  assert.ok(maxDiff < 1e-3, `bass must pass through (maxDiff=${maxDiff})`);
});

test("eq7/lofi/rectifier inserts validate params and keep buffer length", () => {
  const source = sine(0.25, 440, 0.3);
  const eq7 = makeInsert("eq7", { mfGainDb: 6 })!;
  assert.equal(eq7.params.mfQ, 1, "eq7 fills Q defaults");
  assert.equal(makeInsert("eq7", { bogus: 1 }), null, "unknown eq7 param invalidates");
  assert.equal(makeInsert("lofi")!.params.bits, 8, "lofi bits default");
  assert.equal(makeInsert("rectifier")!.params.mode, 1, "rectifier defaults to full wave");
  for (const processor of ["eq7", "lofi", "rectifier"] as const) {
    const chain: InsertChain = [makeInsert(processor)!];
    const out = processWithChain(Float32Array.from(source), chain, FS);
    assert.equal(out.length, source.length, `${processor} keeps length`);
    for (let i = 0; i < out.length; i += 1) {
      assert.ok(Number.isFinite(out[i]), `${processor} sample ${i} finite`);
    }
  }
});

test("eq7 insert boosts the band it is set to", () => {
  // 50 Hz sits on the plateau of the default 100 Hz LF shelf corner.
  const low = sine(0.5, 50, 0.3);
  const chain: InsertChain = [makeInsert("eq7", { lfGainDb: 9 })!];
  const out = processWithChain(Float32Array.from(low), chain, FS);
  let inSum = 0;
  let outSum = 0;
  for (let i = Math.floor(0.2 * FS) * 2; i < low.length; i += 1) {
    inSum += low[i] * low[i];
    outSum += out[i] * out[i];
  }
  const gainDb = 10 * Math.log10(outSum / inSum);
  assert.ok(gainDb > 7 && gainDb < 11, `LF shelf boost through the chain was ${gainDb} dB`);
});

test("lofi insert quantizes audibly at low bit depth", () => {
  const source = sine(0.25, 440, 0.5);
  const chain: InsertChain = [makeInsert("lofi", { bits: 4 })!];
  const out = processWithChain(Float32Array.from(source), chain, FS);
  let diff = 0;
  for (let i = 0; i < source.length; i += 1) diff += Math.abs(source[i] - out[i]);
  assert.ok(diff > 1, `4-bit crush must alter the signal (diff=${diff})`);
});

test("rectifier insert doubles a sine's frequency", () => {
  const source = sine(0.5, 440, 0.5);
  const chain: InsertChain = [makeInsert("rectifier", { mode: 1 })!];
  const out = processWithChain(Float32Array.from(source), chain, FS);
  let crossings = 0;
  const from = Math.floor((out.length / 2) * 0.25);
  const to = Math.floor((out.length / 2) * 0.75);
  let prev = out[from * 2];
  for (let i = from + 1; i < to; i += 1) {
    const v = out[i * 2];
    if (prev <= 0 && v > 0) crossings += 1;
    prev = v;
  }
  const hz = crossings / ((to - from) / FS);
  assert.ok(Math.abs(hz - 880) < 25, `full-wave through the chain was ${hz} Hz`);
});
