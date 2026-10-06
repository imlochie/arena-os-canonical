/**
 * AI contract-layer tests (Part 27 of the completion plan, verbatim):
 * capability honesty, packet evidence, proposal validation, transactional
 * application, undo, source immutability by construction.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AUDIO_AI_CAPABILITIES,
  capabilityLabel,
  classifyProviderCapability,
  describeCapability,
} from "./capability";
import { buildAnalysisPacket, ANALYSIS_PACKET_FORMAT } from "./packet";
import { applyProposal, CHANNEL_STRIP_PROCESSOR, validateProposal } from "./proposal";
import { createMixerState, findChannel, serializeMixerState } from "../mixer/state";
import { measureAudio } from "../mixer/meters";
import type { StereoBuffer } from "../mixer/dsp";

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

// ---------------------------------------------------------------------------
// Part 6: honest hearing capability
// ---------------------------------------------------------------------------

test("capability labels are the exact honest strings", () => {
  assert.deepEqual(AUDIO_AI_CAPABILITIES, ["audio-model", "audio-derived", "text-only"]);
  assert.equal(capabilityLabel("audio-model"), "AI hearing: direct audio");
  assert.equal(capabilityLabel("audio-derived"), "AI reasoning: derived audio analysis");
  assert.equal(capabilityLabel("text-only"), "AI cannot hear audio in this session.");
  for (const capability of AUDIO_AI_CAPABILITIES)
    assert.ok(describeCapability(capability).length > 10);
});

test("classification: text-only is never presented as hearing", () => {
  assert.equal(
    classifyProviderCapability({
      provider: "openrouter", model: "x", supportsAudioInput: false, analysisPacketAvailable: true,
    }),
    "audio-derived",
  );
  assert.equal(
    classifyProviderCapability({
      provider: "groq", model: "y", supportsAudioInput: false, analysisPacketAvailable: false,
    }),
    "text-only",
  );
  assert.equal(
    classifyProviderCapability({
      provider: "z", model: "audio-capable", supportsAudioInput: true, analysisPacketAvailable: false,
    }),
    "audio-model",
  );
});

// ---------------------------------------------------------------------------
// Part 6: the analysis packet carries real measurements
// ---------------------------------------------------------------------------

test("packet is built from actual PCM and states its basis", () => {
  const pcm = sine(2, 440, 0.5);
  const packet = buildAnalysisPacket({
    target: { kind: "stem", name: "vocals" },
    pcm,
    sampleRate: FS,
    musical: { tempoBpm: 124, key: "A minor" },
    stems: [{ id: "s1", type: "vocals" }, { id: "s2", type: "drums" }],
    now: () => "2026-10-07T00:00:00Z",
  });
  assert.equal(packet.format, ANALYSIS_PACKET_FORMAT);
  assert.equal(packet.basis, "audio-derived");
  assert.ok(Math.abs(packet.measurements.peakDb - measureAudio(pcm, FS).peakDb) < 1e-9);
  assert.ok(packet.observations.some((line) => line.includes("124 BPM")));
  assert.ok(packet.observations.some((line) => line.includes("A minor")));
  assert.ok(packet.spectral.mid > packet.spectral.air);
});

test("packet observations are all derived from measurements (no invention)", () => {
  const silent = new Float32Array(FS * 2 * 2);
  const packet = buildAnalysisPacket({
    target: { kind: "source" },
    pcm: silent,
    sampleRate: FS,
    now: () => "2026-10-07T00:00:00Z",
  });
  assert.ok(packet.observations.some((line) => line.includes("not measurable")));
  assert.equal(packet.measurements.lufsIntegrated, null);
});

// ---------------------------------------------------------------------------
// Parts 7/18: proposal validation + transactional apply + undo
// ---------------------------------------------------------------------------

function baseState() {
  return createMixerState({
    sources: [{ id: "src-1", name: "song.mp3" }],
    stems: [
      { id: "stem-v", sourceAssetId: "src-1", stemType: "vocals" },
      { id: "stem-b", sourceAssetId: "src-1", stemType: "bass" },
    ],
  });
}

const validProposal = {
  rationale: "Vocal is buried; lift presence and tame bass buildup.",
  changes: [
    {
      targetChannelId: "stem:stem-v",
      processor: "eq-band",
      parameters: { freqHz: 3200, gainDb: 3, q: 0.9 },
      reason: "presence lift for intelligibility",
    },
    {
      targetChannelId: "stem:stem-b",
      processor: "channel-strip",
      parameters: { faderDb: -2.5 },
      reason: "reduce low-mid masking of the kick",
    },
  ],
};

test("valid proposal applies transactionally with an undo record", () => {
  const state = baseState();
  const before = serializeMixerState(state);
  const result = applyProposal(state, validProposal);
  assert.equal(result.status, "applied");
  assert.equal(result.applied.length, 2);
  assert.notEqual(result.undo, undefined);
  assert.equal(serializeMixerState(result.undo!), before); // undo is the exact prior state
  const vocal = findChannel(result.next!, "stem:stem-v")!;
  assert.equal(vocal.inserts.length, 1);
  assert.equal(vocal.inserts[0].processor, "eq-band");
  assert.equal(findChannel(result.next!, "stem:stem-b")!.faderDb, -2.5);
  // Original state object untouched.
  assert.equal(serializeMixerState(state), before);
  assert.equal(findChannel(state, "stem:stem-v")!.inserts.length, 0);
});

test("unknown processor and unknown channel are rejected, not clamped", () => {
  const state = baseState();
  const unknownProcessor = {
    rationale: "x",
    changes: [{ targetChannelId: "stem:stem-v", processor: "neural-remaster", parameters: { wow: 1 }, reason: "x" }],
  };
  assert.equal(validateProposal(state, unknownProcessor).valid, false);
  assert.ok(validateProposal(state, unknownProcessor).errors[0].includes("unknown processor"));

  const unknownChannel = {
    rationale: "x",
    changes: [{ targetChannelId: "stem:ghost", processor: "gain", parameters: { gainDb: 1 }, reason: "x" }],
  };
  assert.equal(validateProposal(state, unknownChannel).valid, false);
  assert.ok(validateProposal(state, unknownChannel).errors[0].includes("unknown target"));

  // Rejected proposals leave the state untouched.
  const result = applyProposal(state, unknownProcessor);
  assert.equal(result.status, "rejected");
  assert.equal(result.next, undefined);
});

test("out-of-range parameters are clamped and the clamp is reported", () => {
  const state = baseState();
  const extreme = {
    rationale: "hot take",
    changes: [
      {
        targetChannelId: "stem:stem-v",
        processor: "eq-band",
        parameters: { freqHz: 999999, gainDb: 60, q: 1 },
        reason: "model asked for the moon",
      },
      {
        targetChannelId: "stem:stem-v",
        processor: "channel-strip",
        parameters: { faderDb: 400 },
        reason: "way too loud",
      },
    ],
  };
  const validation = validateProposal(state, extreme);
  assert.equal(validation.valid, true);
  assert.equal(validation.clamped.length, 3);
  const result = applyProposal(state, extreme);
  assert.equal(result.status, "applied");
  const vocal = findChannel(result.next!, "stem:stem-v")!;
  assert.equal(vocal.inserts[0].params.freqHz, 16000); // clamped to registry max
  assert.equal(vocal.inserts[0].params.gainDb, 18);
  assert.equal(vocal.faderDb, 6); // channel-strip range
});

test("malformed proposals are rejected by the contract", () => {
  const state = baseState();
  assert.equal(validateProposal(state, null).valid, false);
  assert.equal(validateProposal(state, {}).valid, false);
  assert.equal(validateProposal(state, { rationale: "x", changes: [] }).valid, false);
  const missingReason = { rationale: "x", changes: [{ targetChannelId: "stem:stem-v", processor: "gain", parameters: { gainDb: 1 } }] };
  assert.equal(validateProposal(state, missingReason).valid, false);
  const emptyReason = { rationale: "x", changes: [{ targetChannelId: "stem:stem-v", processor: "gain", parameters: { gainDb: 1 }, reason: "" }] };
  assert.equal(validateProposal(state, emptyReason).valid, false);
});

test("AI actions cannot touch source assets — immutability by construction", () => {
  const state = baseState();
  const result = applyProposal(state, {
    rationale: "try to break things",
    changes: [
      { targetChannelId: "source:src-1", processor: "channel-strip", parameters: { faderDb: -60 }, reason: "mute the source" },
      { targetChannelId: "stem:stem-v", processor: "gain", parameters: { gainDb: 24 }, reason: "max gain" },
    ],
  });
  // Even a hostile-but-valid proposal only changes MIXER state: asset ids,
  // storage references, and everything outside the mixer are identical.
  assert.equal(result.status, "applied");
  for (const channel of result.next!.channels) {
    const original = findChannel(state, channel.id)!;
    assert.equal(channel.stemAssetId, original.stemAssetId);
    assert.equal(channel.sourceAssetId, original.sourceAssetId);
    assert.equal(channel.stemType, original.stemType);
  }
  assert.equal(result.next!.channels.length, state.channels.length);
  // The module exposes no file, path, or job capability at all — its API
  // surface is exactly { validateProposal, applyProposal } over MixerState.
});

test("channel-strip processor accepts only its declared parameters", () => {
  const state = baseState();
  const bogus = {
    rationale: "x",
    changes: [{
      targetChannelId: "stem:stem-v",
      processor: CHANNEL_STRIP_PROCESSOR,
      parameters: { faderDb: 1, executeShellScript: 1 },
      reason: "x",
    }],
  };
  const validation = validateProposal(state, bogus);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("unknown channel-strip parameter")));
});
