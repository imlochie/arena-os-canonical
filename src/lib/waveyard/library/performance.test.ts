import test from "node:test";
import assert from "node:assert/strict";
import { defaultPerformance, nextPerformanceBoundary, normalizePerformance, performanceTick, performMix } from "./performance";
import { normalizeTransitionConfig } from "./session-logic";

test("measured variable-tempo grid: future quarter/half/beat/four-beat boundaries without extrapolation", () => {
  const grid = [100, 600, 1200, 1800, 2500, 3300, 4100, 5000, 6000];
  assert.equal(nextPerformanceBoundary(.65, grid, "quarter"), .75);
  assert.equal(nextPerformanceBoundary(.65, grid, "half"), .9);
  assert.equal(nextPerformanceBoundary(.65, grid, "beat"), 1.2);
  assert.equal(nextPerformanceBoundary(.65, grid, "four-beats"), 2.5);
  assert.equal(nextPerformanceBoundary(.6, grid, "beat"), 1.2);
  assert.equal(nextPerformanceBoundary(6, grid, "beat"), null);
  assert.equal(nextPerformanceBoundary(0, null, "beat"), null);
  assert.equal(nextPerformanceBoundary(0, [0, 0, 500], "beat"), null);
  assert.equal(nextPerformanceBoundary(0, [500, 0], "beat"), null);
  assert.equal(nextPerformanceBoundary(NaN, grid, "off"), null);
});

test("mute and isolate restore exact non-unity gains, including original muted lanes after persisted reload", () => {
  const original = { vocals: .37, drums: .8, bass: 0 };
  const muted = performMix(original, defaultPerformance(), { kind: "mute", stem: "vocals" }, Object.keys(original));
  assert.equal(muted.mix.vocals, 0);
  const reloaded = normalizePerformance(JSON.parse(JSON.stringify(muted.performance)))!;
  assert.equal(performMix(muted.mix, reloaded, { kind: "mute", stem: "vocals" }, Object.keys(original)).mix.vocals, .37);
  const isolated = performMix(original, defaultPerformance(), { kind: "isolate", stem: "vocals" }, Object.keys(original));
  assert.deepEqual(isolated.mix, { vocals: .37, drums: 0, bass: 0 });
  const switched = performMix(isolated.mix, isolated.performance, { kind: "isolate", stem: "drums" }, Object.keys(original));
  assert.deepEqual(switched.mix, { vocals: 0, drums: .8, bass: 0 });
  assert.deepEqual(performMix(switched.mix, normalizePerformance(JSON.parse(JSON.stringify(switched.performance)))!, { kind: "restore" }, Object.keys(original)).mix, original);
  assert.deepEqual(original, { vocals: .37, drums: .8, bass: 0 });
});

test("settings survive existing transition JSON validation; invalid gain/snap/restore state fails closed", () => {
  const settings = { ...defaultPerformance(), snap: "half" as const, instantRestore: false };
  assert.deepEqual(normalizeTransitionConfig({ mode: "beat", crossfadeSeconds: 2, keepStems: [], performance: settings })?.performance, settings);
  for (const change of [{ snap: "guess" }, { recall: { vocals: Infinity } }, { recall: { vocals: -1 } }, { isolatedStem: "vocals" }, { instantRestore: "yes" }]) {
    assert.equal(normalizePerformance({ ...settings, ...change }), null);
    assert.equal(normalizeTransitionConfig({ mode: "beat", crossfadeSeconds: 2, performance: { ...settings, ...change } }), null);
  }
});

test("source-clock queue rejects pause, backwards seek and late/backgrounded callbacks", () => {
  assert.equal(performanceTick(2, 1.8, 1.9, true), "wait");
  assert.equal(performanceTick(2, 1.99, 2.016, true), "apply");
  assert.equal(performanceTick(2, 1.99, 2.016, false), "cancel");
  assert.equal(performanceTick(2, 1.9, 1, true), "cancel");
  assert.equal(performanceTick(2, 1.9, 4, true), "cancel");
});


test("bar requires separate trustworthy downbeats, not the first or an arbitrary fourth measured beat", () => {
  const beats = [125, 625, 1125, 1625, 2125, 2625, 3125, 3625, 4125];
  assert.equal(nextPerformanceBoundary(.7, beats, "bar"), null);
  assert.equal(nextPerformanceBoundary(.7, beats, "four-beats"), 2.125);
  assert.equal(nextPerformanceBoundary(.7, beats, "bar", [625, 2625, 4625]), 2.625);
  assert.equal(nextPerformanceBoundary(4.7, beats, "bar", [625, 2625, 4625]), null);
  assert.equal(nextPerformanceBoundary(.7, beats, "bar", [625, 625]), null);
  assert.equal(normalizePerformance({ ...defaultPerformance(), snap: "bar" })?.snap, "bar");
});
