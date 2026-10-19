import test from "node:test";
import assert from "node:assert/strict";
import { prepareArrangementPcm, type ArrangementPreviewState } from "./arrangement-pcm";
import { makeInsert, parseInserts, processWithChain } from "./mixer/inserts";
import { applyDelay } from "./mixer/dsp";
function setup() {
  const input = new Float32Array(1000); input[900] = 0.4;
  const audio = new Map([["stem", { sampleRate: 1000, length: input.length, numberOfChannels: 2, getChannelData: () => input }]]);
  const clip = { stemAssetId: "stem", timelineStartMs: 0, durationMs: 1000, sourceOffsetMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0, tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false };
  const state: ArrangementPreviewState = { masterVolume: 0.5, masterInserts: [makeInsert("gain", { gainDb: -6 })!], loopStartMs: 0, loopEndMs: null, tracks: [{ id: "track", name: "test", sortOrder: 0, stemAssetId: "stem", volume: 1, pan: 0, muted: false, solo: false, phaseInverted: true, inserts: [makeInsert("saturator", { drive: 3 })!], clips: [clip, { ...clip }] }] };
  return { state, audio };
}
test("audition sums overlapping clips before nonlinear FX, then master processing and polarity", () => {
  const { state, audio } = setup(); const rendered = prepareArrangementPcm(state, audio, 1000);
  const bus = new Float32Array(2000); bus[1800] = bus[1801] = -0.8 * Math.SQRT1_2;
  const expected = processWithChain(bus, state.tracks[0].inserts!, 1000); for (let i = 0; i < expected.length; i++) expected[i] *= state.masterVolume;
  assert.deepEqual(rendered, processWithChain(expected, state.masterInserts!, 1000));
});
test("parallel FX tails use maximum bus length, not the sum of independent tails", () => {
  const { state, audio } = setup(); state.masterInserts = []; state.tracks[0].inserts = [makeInsert("delay", { delayMs: 250, feedback: 0, mix: 1 })!];
  const one = prepareArrangementPcm(state, audio, 1000); state.tracks.push({ ...state.tracks[0], id: "other" });
  const two = prepareArrangementPcm(state, audio, 1000); assert.equal(two.length, one.length);
});
test("delay tail retains each known echo beyond input, bypass retains exact dry duration, unsafe settings fail", () => {
  const pcm = new Float32Array(200); pcm[198] = 1;
  const output = applyDelay(pcm, { delayMs: 250, feedback: 0.5, mix: 1, sampleRate: 1000 });
  assert.equal(output[698], 1); assert.equal(output[1198], 0.5); assert.equal(output[1698], 0.25); assert.ok(output.length < 8000);
  assert.equal(processWithChain(pcm, [makeInsert("delay", {}, { wet: 0 })!], 1000).length, pcm.length);
  assert.equal(applyDelay(pcm, { delayMs: 250, feedback: 0.5, mix: 0, sampleRate: 1000 }).length, pcm.length);
  assert.throws(() => applyDelay(pcm, { delayMs: 2000, feedback: 0.95, mix: 1, sampleRate: 1000 }), /60-second/);
  assert.throws(() => applyDelay(pcm, { delayMs: 250, feedback: NaN, mix: 1, sampleRate: 1000 }), /Invalid delay/);
});
test("unknown processor and unavailable transforms fail explicitly, never successful dry audition", () => {
  const { state, audio } = setup(); state.tracks[0].clips[0].tempoSyncEnabled = true;
  assert.throws(() => prepareArrangementPcm(state, audio, 1000), /Tempo\/key/); state.tracks[0].clips[0].tempoSyncEnabled = false;
  state.masterInserts = [{ ...makeInsert("gain")!, processor: "unknown" as never }]; assert.throws(() => prepareArrangementPcm(state, audio, 1000), /Unsupported/);
});

test("persisted unsafe FX parameters and unbounded chains are rejected rather than silently clamped", () => {
  const delay = makeInsert("delay")!;
  assert.equal(parseInserts({ format: "waveyard-inserts-v1", inserts: [{ ...delay, params: { ...delay.params, feedback: 1.2 } }] }), null);
  assert.equal(parseInserts({ format: "waveyard-inserts-v1", inserts: Array.from({ length: 33 }, (_, index) => ({ ...delay, id: `delay-${index}` })) }), null);
  assert.throws(() => processWithChain(new Float32Array(10), [{ ...delay, processor: "unknown" as never }], 1000), /Unsupported/);
});
