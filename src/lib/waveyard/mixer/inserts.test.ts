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
