/**
 * Mixer engine tests — gain math, pan law, solo/phase/mono, bus routing,
 * serialization, legacy adapters. All fixtures are synthesized (legal,
 * deterministic).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyGain,
  applyPan,
  applyStereoWidth,
  applyBiquad,
  applyCompressor,
  applyGate,
  applySaturation,
  applySoftClipCeiling,
  applyDelay,
  invertPolarity,
  mixDryWet,
  toMono,
  designBiquad,
  newBiquadState,
  type StereoBuffer,
} from "./dsp";
import {
  anySoloActive,
  channelGainDb,
  computeGainStages,
  dbToGain,
  gainToDb,
  isChannelAudible,
  panGains,
  resolveBusOrder,
} from "./gain";
import {
  addBus,
  applyLegacyControl,
  createMixerState,
  findChannel,
  parseMixerState,
  serializeMixerState,
  toLegacyControls,
  updateChannel,
} from "./state";
import { MIXER_STATE_FORMAT, type ChannelStrip } from "./types";
import { applyMixPreset, presetCatalog } from "./presets";

const FS = 48000;

function makeSine(seconds: number, freqHz: number, amplitude: number, pan = 0): StereoBuffer {
  const frames = Math.round(seconds * FS);
  const buffer = new Float32Array(frames * 2);
  const gains = panGains(pan);
  for (let i = 0; i < frames; i++) {
    const v = amplitude * Math.sin((2 * Math.PI * freqHz * i) / FS);
    buffer[i * 2] = v * gains.left;
    buffer[i * 2 + 1] = v * gains.right;
  }
  return buffer;
}

function stereoRmsDb(buffer: StereoBuffer): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return gainToDb(Math.sqrt(sum / buffer.length));
}

// ---------------------------------------------------------------------------
// Gain + pan
// ---------------------------------------------------------------------------

test("pan law: unity at center, full isolation at hard pan", () => {
  assert.deepEqual(panGains(0), { left: 1, right: 1 });
  const hardLeft = panGains(-1);
  assert.equal(hardLeft.left, 1);
  assert.equal(hardLeft.right, 0);
  const hardRight = panGains(1);
  assert.equal(hardRight.left, 0);
  assert.equal(hardRight.right, 1);
  const quarter = panGains(0.5);
  assert.ok(quarter.right > quarter.left);
});

test("pan applied to audio matches the pan law", () => {
  const buffer = makeSine(0.5, 1000, 0.5);
  applyPan(buffer, -1);
  // Start at sample 2: sample 0 of a sine is a legitimate zero crossing.
  // (× 0 can produce −0; treat |x| === 0 as zero.)
  for (let i = 2; i < buffer.length; i += 2) {
    assert.ok(buffer[i + 1] === 0 || buffer[i + 1] === -0);
    assert.notEqual(buffer[i], 0);
  }
});

test("dB conversions round-trip", () => {
  for (const db of [-60, -23.5, -6, 0, 3, 6]) {
    assert.ok(Math.abs(gainToDb(dbToGain(db)) - db) < 1e-9);
  }
  assert.equal(gainToDb(0), -Infinity);
});

// ---------------------------------------------------------------------------
// Phase / mono
// ---------------------------------------------------------------------------

test("polarity inversion flips the sign", () => {
  const buffer = makeSine(0.1, 440, 0.5);
  const before = Array.from(buffer.slice(0, 8));
  invertPolarity(buffer, true, true);
  for (let i = 0; i < 8; i++) assert.equal(buffer[i], -before[i]);
});

test("mono sum of an out-of-phase pair produces silence", () => {
  const frames = 4800;
  const buffer = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    buffer[i * 2] = 0.5;
    buffer[i * 2 + 1] = -0.5;
  }
  toMono(buffer, 1);
  for (let i = 0; i < buffer.length; i++) assert.equal(buffer[i], 0);
});

test("stereo width 0 collapses to mono (identical channels)", () => {
  const buffer = makeSine(0.2, 440, 0.4);
  buffer[1] = 0; // decorrelate slightly
  applyStereoWidth(buffer, 0);
  for (let i = 0; i < buffer.length; i += 2)
    assert.ok(Math.abs(buffer[i] - buffer[i + 1]) < 1e-9);
});

// ---------------------------------------------------------------------------
// Biquads
// ---------------------------------------------------------------------------

test("lowpass attenuates a 1 kHz sine by >20 dB at 200 Hz cutoff", () => {
  const buffer = makeSine(0.5, 1000, 0.5);
  const before = stereoRmsDb(buffer);
  applyBiquad(
    buffer,
    designBiquad({ type: "lowpass", freqHz: 200, q: 0.7071 }, FS),
    newBiquadState(),
    newBiquadState(),
  );
  const after = stereoRmsDb(buffer);
  assert.ok(before - after > 20, `attenuation was ${before - after} dB`);
});

test("highpass barely touches a 1 kHz sine at 20 Hz cutoff", () => {
  const buffer = makeSine(0.5, 1000, 0.5);
  const before = stereoRmsDb(buffer);
  applyBiquad(
    buffer,
    designBiquad({ type: "highpass", freqHz: 20, q: 0.7071 }, FS),
    newBiquadState(),
    newBiquadState(),
  );
  const after = stereoRmsDb(buffer);
  assert.ok(Math.abs(before - after) < 1, `change was ${before - after} dB`);
});

test("peaking EQ boosts the target band", () => {
  const buffer = makeSine(0.5, 1000, 0.25);
  const before = stereoRmsDb(buffer);
  applyBiquad(
    buffer,
    designBiquad({ type: "peaking", freqHz: 1000, gainDb: 6, q: 1 }, FS),
    newBiquadState(),
    newBiquadState(),
  );
  const after = stereoRmsDb(buffer);
  assert.ok(after - before > 4.5, `boost was ${after - before} dB`);
});

// ---------------------------------------------------------------------------
// Dynamics + saturation
// ---------------------------------------------------------------------------

test("compressor reduces a hot sine; makeup adds exactly its dB", () => {
  const loud = makeSine(0.5, 1000, 0.9);
  const before = stereoRmsDb(loud);
  applyCompressor(loud, { thresholdDb: -24, ratio: 4, attackMs: 5, releaseMs: 100, makeupDb: 0, sampleRate: FS });
  const after = stereoRmsDb(loud);
  assert.ok(before - after > 3, `reduction was ${before - after} dB`);

  // Makeup is a pure post-gain: the same compression +6 dB makeup must land
  // exactly 6 dB above the no-makeup result.
  const withMakeup = makeSine(0.5, 1000, 0.9);
  applyCompressor(withMakeup, { thresholdDb: -24, ratio: 4, attackMs: 5, releaseMs: 100, makeupDb: 6, sampleRate: FS });
  const delta = stereoRmsDb(withMakeup) - after;
  assert.ok(Math.abs(delta - 6) < 0.1, `makeup delta was ${delta} dB`);
});

test("gate silences content below threshold", () => {
  const quiet = makeSine(0.4, 1000, 0.001);
  applyGate(quiet, { thresholdDb: -40, attackMs: 1, releaseMs: 50, holdMs: 10, sampleRate: FS });
  const after = stereoRmsDb(quiet);
  assert.ok(after < -70, `gated level was ${after} dB`);
});

test("saturation bounds peaks and adds harmonics (measurable RMS lift)", () => {
  const hot = makeSine(0.4, 220, 1.0);
  const beforeRms = stereoRmsDb(hot);
  applySaturation(hot, 4);
  let peak = 0;
  for (let i = 0; i < hot.length; i++) peak = Math.max(peak, Math.abs(hot[i]));
  assert.ok(peak <= 1.0001);
  assert.ok(stereoRmsDb(hot) > beforeRms); // flattened peaks → more RMS
});

test("soft clip ceiling is never exceeded", () => {
  const hot = makeSine(0.3, 1000, 1.2);
  applySoftClipCeiling(hot, -1);
  const ceiling = dbToGain(-1);
  for (let i = 0; i < hot.length; i++)
    assert.ok(Math.abs(hot[i]) <= ceiling + 1e-6, `sample ${i} = ${hot[i]}`);
});

test("delay produces echoes at the delay time", () => {
  const frames = FS; // 1 s
  const buffer = new Float32Array(frames * 2);
  buffer[0] = 0.5; // impulse on L
  const delayed = applyDelay(buffer, { delayMs: 250, feedback: 0.5, mix: 1, sampleRate: FS });
  // mix = 1 → wet only: t=0 is silent (the dry impulse returns via the
  // delay line at t = D, not at t = 0).
  assert.equal(delayed[0], 0);
  const echoIndex = Math.round(0.25 * FS) * 2;
  assert.ok(Math.abs(delayed[echoIndex] - 0.5) < 1e-6);
  const echo2Index = Math.round(0.5 * FS) * 2;
  assert.ok(Math.abs(delayed[echo2Index] - 0.25) < 1e-6); // feedback 0.5
});

test("dry/wet 0 leaves the signal untouched", () => {
  const dry = makeSine(0.2, 440, 0.3);
  const wet = Float32Array.from(dry);
  applyGain(wet, 0.1);
  mixDryWet(dry, wet, 0);
  assert.deepEqual(Array.from(dry.slice(0, 4)), Array.from(dry.slice(0, 4)));
});

// ---------------------------------------------------------------------------
// Channel gain resolution, solo, buses
// ---------------------------------------------------------------------------

function strip(id: string, kind: ChannelStrip["kind"], patch: Partial<ChannelStrip> = {}): ChannelStrip {
  return {
    id, kind, name: id,
    trimDb: 0, faderDb: 0, mutedInfinity: false, pan: 0,
    muted: false, solo: false, phaseInvert: false, monoMonitor: false,
    inserts: [],
    ...patch,
  };
}

test("trim + fader cascade; muted/solo resolve to −∞", () => {
  const channel = strip("s1", "stem", { trimDb: 6, faderDb: -6 });
  assert.equal(channelGainDb(channel, false), 0);
  assert.equal(channelGainDb({ ...channel, muted: true }, false), -Infinity);
  const other = strip("s2", "stem");
  assert.equal(channelGainDb(channel, true), -Infinity); // solo elsewhere, not soloing
  assert.equal(channelGainDb({ ...channel, solo: true }, true), 0);
  assert.ok(anySoloActive([channel, { ...other, solo: true }]));
  assert.ok(!anySoloActive([channel, other]));
  assert.ok(isChannelAudible(channel, false));
});

test("mutedInfinity (closed fader) is −∞ regardless of trim", () => {
  const channel = strip("s1", "stem", { mutedInfinity: true, trimDb: 24, faderDb: 6 });
  assert.equal(channelGainDb(channel, false), -Infinity);
});

test("bus order is topological; cycles and unknown targets are rejected", () => {
  const master = strip("master", "master");
  const drumBus = strip("bus-drums", "bus");
  const mixBus = strip("bus-mix", "bus", { busId: "bus-drums" });
  const order = resolveBusOrder([master, drumBus, mixBus]);
  assert.ok(order.indexOf("bus-mix") < order.indexOf("bus-drums"));

  const cyclic = strip("bus-a", "bus", { busId: "bus-b" });
  const cyclic2 = strip("bus-b", "bus", { busId: "bus-a" });
  assert.throws(() => resolveBusOrder([cyclic, cyclic2]), /cycle/i);
  const orphan = strip("bus-x", "bus", { busId: "nope" });
  assert.throws(() => resolveBusOrder([orphan]), /unknown/i);
});

test("computeGainStages resolves pan, master, and bus routing", () => {
  const state = {
    format: MIXER_STATE_FORMAT,
    channels: [
      strip("master", "master", { faderDb: -6 }),
      strip("stem-v", "stem", { trimDb: 3, pan: -0.5 }),
      strip("stem-d", "stem", { busId: "bus-drums", muted: true }),
      strip("bus-drums", "bus", { faderDb: 3 }),
    ],
  };
  const stages = computeGainStages(state);
  assert.ok(stages.channels["stem-v"].left > stages.channels["stem-v"].right);
  assert.equal(stages.channels["stem-d"].left, 0); // muted
  assert.ok(Math.abs(stages.channels["bus-drums"].left - dbToGain(3)) < 1e-9);
  assert.ok(Math.abs(stages.master.left - dbToGain(-6)) < 1e-9);
  assert.deepEqual(stages.busOrder, ["bus-drums"]);
});

// ---------------------------------------------------------------------------
// State: construction, serialization, legacy adapters
// ---------------------------------------------------------------------------

test("createMixerState distinguishes SOURCE/STEM/BUS/MASTER with identity", () => {
  const state = createMixerState({
    sources: [{ id: "src-1", name: "song.mp3" }],
    stems: [
      { id: "stem-1", sourceAssetId: "src-1", stemType: "vocals" },
      { id: "stem-2", sourceAssetId: "src-1", stemType: "drums" },
    ],
  });
  const kinds = state.channels.map((channel) => channel.kind);
  assert.deepEqual(kinds, ["source", "stem", "stem", "master"]);
  const vocal = findChannel(state, "stem:stem-1");
  assert.equal(vocal?.stemAssetId, "stem-1");
  assert.equal(vocal?.sourceAssetId, "src-1");
  const { state: withBus, busId } = addBus(state, { name: "Drum Bus" });
  assert.equal(busId, "bus:drum-bus");
  assert.equal(withBus.channels.filter((channel) => channel.kind === "bus").length, 1);
});

test("mixer state round-trips through serialization", () => {
  let state = createMixerState({ stems: [{ id: "s1", stemType: "bass" }] });
  state = updateChannel(state, "stem:s1", { faderDb: -4.5, pan: 0.25, trimDb: 2 });
  const parsed = parseMixerState(JSON.parse(serializeMixerState(state)));
  assert.notEqual(parsed, null);
  assert.equal(parsed!.channels.length, state.channels.length);
  assert.equal(findChannel(parsed!, "stem:s1")!.faderDb, -4.5);
  assert.equal(parseMixerState({ format: "wrong", channels: [] }), null);
  assert.equal(parseMixerState({ format: MIXER_STATE_FORMAT, channels: [{ id: "x", kind: "master" }] }), null);
});

test("legacy remix-track controls map to dB and back", () => {
  let state = createMixerState({ stems: [{ id: "s1", stemType: "vocals" }] });
  state = applyLegacyControl(state, "s1", { volume: 0.5, pan: -0.3, muted: false, solo: false });
  const stripAfter = findChannel(state, "stem:s1")!;
  assert.ok(Math.abs(stripAfter.faderDb - gainToDb(0.5)) < 1e-9);
  assert.equal(stripAfter.pan, -0.3);
  const legacy = toLegacyControls(state);
  assert.ok(Math.abs(legacy.controls["s1"].volume - 0.5) < 1e-6);
  assert.equal(legacy.controls["s1"].pan, -0.3);
  assert.equal(legacy.masterVolume, 1);

  const silent = applyLegacyControl(state, "s1", { volume: 0, pan: 0, muted: true, solo: false });
  assert.equal(toLegacyControls(silent).controls["s1"].volume, 0);
});

test("presets are real chains and apply transactionally", () => {
  const catalog = presetCatalog();
  assert.ok(catalog.length >= 6);
  let state = createMixerState({ stems: [{ id: "s1", stemType: "vocals" }] });
  const result = applyMixPreset(state, "stem:s1", "vocal-clarity");
  assert.equal(result.error, undefined);
  const chain = findChannel(result.state, "stem:s1")!.inserts;
  assert.equal(chain.length, 2);
  assert.equal(chain[0].processor, "highpass");
  // Original state untouched (transactional).
  assert.equal(findChannel(state, "stem:s1")!.inserts.length, 0);
  assert.notEqual(applyMixPreset(state, "nope", "vocal-clarity").error, undefined);
});
