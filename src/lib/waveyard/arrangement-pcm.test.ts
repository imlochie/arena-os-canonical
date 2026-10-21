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

test("bounded pre-master cache reuses only master edits; source/settings/ranges/FX/automation invalidate and cached PCM is never mutated", () => {
  const { state, audio } = setup(); const cache = { revision: "immutable-source-v1", hit: false, pcm: undefined as Float32Array | undefined };
  const first = prepareArrangementPcm(state, audio, 1000, cache); assert.equal(cache.hit, false); const retained = cache.pcm!.slice();
  const master = structuredClone(state); master.masterVolume = 0.21; master.masterInserts = [makeInsert("delay", { delayMs: 25, feedback: 0, mix: 0.5 })!];
  assert.deepEqual(prepareArrangementPcm(master, audio, 1000, cache), prepareArrangementPcm(master, audio, 1000)); assert.equal(cache.hit, true); assert.deepEqual(cache.pcm, retained);
  assert.notDeepEqual(first, prepareArrangementPcm(master, audio, 1000, cache));
  const edits = [
    (s: ArrangementPreviewState) => { s.tracks[0].volume = 0.3; },
    (s: ArrangementPreviewState) => { s.tracks[0].pan = 0.7; },
    (s: ArrangementPreviewState) => { s.tracks[0].phaseInverted = false; },
    (s: ArrangementPreviewState) => { s.tracks[0].clips[0].gain = 0.4; },
    (s: ArrangementPreviewState) => { s.tracks[0].clips[0].durationMs = 900; },
    (s: ArrangementPreviewState) => { s.tracks[0].clips[0].timelineStartMs = 100; },
    (s: ArrangementPreviewState) => { s.tracks[0].clips[0].durationMs = 800; s.tracks[0].clips[0].sourceOffsetMs = 100; },
    (s: ArrangementPreviewState) => { s.tracks[0].inserts = []; },
    (s: ArrangementPreviewState) => { s.automation = [{ remixTrackId: "track", parameter: "volume", points: [{ timelineMs: 0, value: 0.2 }, { timelineMs: 1000, value: 0.8 }] }]; },
    (s: ArrangementPreviewState) => { s.tempoBpm = 125; s.targetKey = "B minor"; },
  ];
  for (const edit of edits) { const next = structuredClone(state); edit(next); assert.deepEqual(prepareArrangementPcm(next, audio, 1000, cache), prepareArrangementPcm(next, audio, 1000)); assert.equal(cache.hit, false); }
  cache.revision = "replaced-source-v2"; prepareArrangementPcm(state, audio, 1000, cache); assert.equal(cache.hit, false);
});


test("serial tracks reuse one dry bus without bleeding prior lanes or mutating immutable sources", () => {
  const { state, audio } = setup();
  state.masterVolume = 1; state.masterInserts = [];
  const track = { ...state.tracks[0], phaseInverted: false, inserts: [], clips: [state.tracks[0].clips[0]] };
  const reference = prepareArrangementPcm({ ...state, tracks: [track] }, audio, 1000);
  state.tracks = Array.from({ length: 32 }, (_, index) => ({ ...track, id: `lane-${index}` }));
  const Native = globalThis.Float32Array;
  let fullBusAllocations = 0;
  globalThis.Float32Array = new Proxy(Native, { construct(target, args, newTarget) {
    if (args[0] === reference.length) fullBusAllocations++;
    return Reflect.construct(target, args, newTarget);
  } });
  try {
    const output = prepareArrangementPcm(state, audio, 1000);
    assert.equal(fullBusAllocations, 2, "one master sum + one reusable scratch, not 32 dry buses");
    for (let index = 0; index < output.length; index++) assert.ok(Math.abs(output[index] - reference[index] * 32) < 0.00001);
    assert.equal(audio.get("stem")!.getChannelData()[900], Math.fround(0.4), "input buffers remain immutable");
  } finally { globalThis.Float32Array = Native; }
});
