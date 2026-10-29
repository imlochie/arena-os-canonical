/**
 * Session-logic tests — the P3 control contract: transition config
 * validation, crossfade envelopes (incl. hard cut + deterministic cancel),
 * tempo/key compatibility on the engine's own musical primitives, beat/bar
 * alignment from verified grids, session advancement, and stem-swap
 * validation. Pure logic; no browser audio fabricated.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CROSSFADE_SECONDS,
  beatAlignedTransitionStart,
  crossfadeCancel,
  crossfadeEnvelope,
  scaleCrossfadeStemVolumes,
  defaultTransitionConfig,
  keyCompatibility,
  liveStemTempoStretchRatio,
  nextSessionTrack,
  normalizeTransitionConfig,
  tempoCompatibility,
  validateStemSwap,
  compatibilityEvidence,
  TRANSITION_MODES,
} from "./session-logic";
import {
  defaultPerformance,
  normalizePerformance,
  nextPerformanceBoundary,
  performMix,
  performanceTick,
} from "./performance";

// ------------------------------------------------------------ transitions

test("transition config: valid modes round-trip, invalid rejected", () => {
  const manual = normalizeTransitionConfig({ mode: "manual", crossfadeSeconds: 4, keepStems: ["drums"] });
  assert.deepEqual(manual, { mode: "manual", crossfadeSeconds: 4, keepStems: ["drums"] });
  const beat = normalizeTransitionConfig({ mode: "beat", crossfadeSeconds: 0, keepStems: [] });
  assert.deepEqual(beat, { mode: "beat", crossfadeSeconds: 0, keepStems: [] });
  assert.equal(normalizeTransitionConfig({ mode: "timecode", crossfadeSeconds: 4 }), null);
  assert.equal(normalizeTransitionConfig({ mode: "manual", crossfadeSeconds: -1 }), null);
  assert.equal(normalizeTransitionConfig({ mode: "manual", crossfadeSeconds: MAX_CROSSFADE_SECONDS + 1 }), null);
  assert.equal(normalizeTransitionConfig(null), null);
  assert.equal(normalizeTransitionConfig("manual"), null);
  assert.deepEqual(
    normalizeTransitionConfig({ mode: "meeting-point", crossfadeSeconds: 6, keepStems: ["vocals"] }),
    { mode: "manual", crossfadeSeconds: 6, keepStems: ["vocals"] },
    "legacy stored meeting-point settings use the supported current-position crossfade",
  );
  // junk keepStems entries are dropped, duplicates deduped
  const cleaned = normalizeTransitionConfig({ mode: "manual", crossfadeSeconds: 1, keepStems: ["drums", "drums", "", 42, "bass"] });
  assert.deepEqual(cleaned?.keepStems, ["drums", "bass"]);
  assert.deepEqual(defaultTransitionConfig(), { mode: "manual", crossfadeSeconds: 4, keepStems: [] });
});

test("performance mix restores an exact pre-isolation fader state", () => {
  const before = { vocals: 0.43, drums: 0, bass: 1.25, other: 0.72 };
  const isolated = performMix(before, defaultPerformance(), { kind: "isolate", stem: "vocals" }, Object.keys(before));
  assert.deepEqual(isolated.mix, { vocals: 0.43, drums: 0, bass: 0, other: 0 });
  assert.equal(isolated.performance.isolatedStem, "vocals");

  const restored = performMix(
    isolated.mix,
    isolated.performance,
    { kind: "isolate", stem: "vocals" },
    Object.keys(before),
  );
  assert.deepEqual(restored.mix, before);
  assert.equal(restored.performance.isolatedStem, null);
});

test("performance mute remembers and restores the last fader level", () => {
  const muted = performMix({ vocals: 0.61, drums: 1 }, defaultPerformance(), { kind: "mute", stem: "vocals" }, ["vocals", "drums"]);
  assert.equal(muted.mix.vocals, 0);
  const restored = performMix(muted.mix, muted.performance, { kind: "mute", stem: "vocals" }, ["vocals", "drums"]);
  assert.equal(restored.mix.vocals, 0.61);
});

test("muting during isolate restores the previous layers before muting", () => {
  const before = { vocals: 0.7, drums: 0.3, bass: 1.2 };
  const isolated = performMix(before, defaultPerformance(), { kind: "isolate", stem: "vocals" }, Object.keys(before));
  const muted = performMix(isolated.mix, isolated.performance, { kind: "mute", stem: "drums" }, Object.keys(before));
  assert.deepEqual(muted.mix, { vocals: 0.7, drums: 0, bass: 1.2 });
  assert.equal(muted.performance.isolatedStem, null);
});

test("performance config validates bounded recall and paired isolation state", () => {
  const config = { ...defaultPerformance(), snap: "beat" as const, recall: { vocals: 0.5 } };
  assert.deepEqual(normalizePerformance(config), config);
  assert.equal(normalizePerformance({ ...config, recall: { vocals: 3 } }), null);
  assert.equal(normalizePerformance({ ...config, isolatedStem: "vocals" }), null);
});

test("performance snap requires a measured grid and never guesses bar downbeats", () => {
  const grid = [0, 500, 1000, 1500, 2000];
  assert.equal(nextPerformanceBoundary(0.1, grid, "beat"), 0.5);
  assert.equal(nextPerformanceBoundary(0.1, grid, "half"), 0.25);
  assert.equal(nextPerformanceBoundary(0.1, grid, "quarter"), 0.125);
  assert.equal(nextPerformanceBoundary(0.1, grid, "bar"), null);
  assert.equal(nextPerformanceBoundary(0.1, null, "beat"), null);
  assert.equal(nextPerformanceBoundary(0.1, [0, 500, 450], "beat"), null);
});

test("performance boundary rejects late or interrupted source-clock callbacks", () => {
  assert.equal(performanceTick(1, 0.8, 0.9, true), "wait");
  assert.equal(performanceTick(1, 0.9, 1, true), "apply");
  assert.equal(performanceTick(1, 0.9, 1.2, true), "cancel");
  assert.equal(performanceTick(1, 1, 0.7, true), "cancel");
  assert.equal(performanceTick(1, 0.9, 1, false), "cancel");
});

test("crossfade envelope: equal-power throughout with exact endpoints", () => {
  assert.deepEqual(crossfadeEnvelope(0, 4), { fromGain: 1, toGain: 0, done: false });
  const midpoint = crossfadeEnvelope(2, 4);
  assert.ok(Math.abs(midpoint.fromGain - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(midpoint.toGain - Math.SQRT1_2) < 1e-12);
  for (const progress of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const state = crossfadeEnvelope(progress * 4, 4);
    assert.ok(Math.abs(state.fromGain ** 2 + state.toGain ** 2 - 1) < 1e-12,
      `crossfade power stays constant at ${progress * 100}%`);
  }
  const end = crossfadeEnvelope(4, 4);
  assert.deepEqual(end, { fromGain: 0, toGain: 1, done: true });
  assert.deepEqual(crossfadeEnvelope(9, 4), { fromGain: 0, toGain: 1, done: true }, "stays done after the end");
  assert.deepEqual(crossfadeEnvelope(-3, 4), { fromGain: 1, toGain: 0, done: false }, "negative elapsed = not started");
});

test("crossfade envelope: zero duration is an immediate hard cut", () => {
  assert.deepEqual(crossfadeEnvelope(0.001, 0), { fromGain: 0, toGain: 1, done: true });
  assert.deepEqual(crossfadeEnvelope(0, 0), { fromGain: 0, toGain: 1, done: true });
});

test("crossfade stem levels preserve balance and explicit keeps", () => {
  const source = { vocals: 0.42, drums: 0.78, bass: 0.31, other: 1 };
  assert.deepEqual(scaleCrossfadeStemVolumes(source, [], 0.5), {
    vocals: 0.21,
    drums: 0.39,
    bass: 0.155,
    other: 0.5,
  });
  assert.deepEqual(scaleCrossfadeStemVolumes(source, ["vocals"], 0.5), {
    vocals: 0.42,
    drums: 0.39,
    bass: 0.155,
    other: 0.5,
  });
});

test("crossfade cancel: freezes both decks at the cancel point, never advances", () => {
  const at = crossfadeCancel(1, 4);
  assert.ok(Math.abs(at.fromGain - Math.cos(Math.PI / 8)) < 1e-12);
  assert.ok(Math.abs(at.toGain - Math.sin(Math.PI / 8)) < 1e-12);
  assert.equal(at.done, false);
  assert.equal(at.advanced, false);
  const beforeStart = crossfadeCancel(0, 4);
  assert.deepEqual(beforeStart, { fromGain: 1, toGain: 0, done: false, advanced: false });
  const hardCut = crossfadeCancel(0.01, 0);
  assert.deepEqual(hardCut, { fromGain: 0, toGain: 1, done: true, advanced: false });
});

// ---------------------------------------------------------- tempo / key

test("tempo compatibility: close BPMs are compatible with a real ratio", () => {
  const near = tempoCompatibility(120, 122);
  assert.equal(near.compatible, true);
  assert.equal(near.ratio, 122 / 120);
  assert.match(near.reason, /close/i);
});

test("tempo compatibility: double/half locks are compatible, drift is not", () => {
  const half = tempoCompatibility(120, 61);
  assert.equal(half.compatible, true, "61 ≈ half of 120 (ratio 0.5083)");
  assert.match(half.reason, /half/i);
  const drift = tempoCompatibility(120, 140);
  assert.equal(drift.compatible, false);
  assert.match(drift.reason, /not be beat-locked/);
});

test("tempo compatibility: missing analysis is honest, never guessed", () => {
  const missing = tempoCompatibility(120, null);
  assert.equal(missing.compatible, false);
  assert.equal(missing.ratio, null);
  assert.match(missing.reason, /not complete/);
  assert.deepEqual(tempoCompatibility(null, null).ratio, null);
});

test("live stem tempo sync only stretches compatible analyzed tempos", () => {
  assert.equal(liveStemTempoStretchRatio(120, 124), 124 / 120);
  assert.equal(liveStemTempoStretchRatio(120, 60), 0.5);
  assert.equal(liveStemTempoStretchRatio(120, 140), null, "large differences remain at donor tempo");
  assert.equal(liveStemTempoStretchRatio(120, null), null, "missing donor analysis is not guessed");
});

test("key compatibility: same key, fifth, and relative relationships", () => {
  assert.equal(keyCompatibility("A minor", "A minor").compatible, true);
  assert.equal(keyCompatibility("A minor", "A minor").relationship, "same");
  const fifth = keyCompatibility("A minor", "E minor");
  assert.equal(fifth.compatible, true);
  assert.equal(fifth.relationship, "fifth");
  const relative = keyCompatibility("A minor", "C major");
  assert.equal(relative.compatible, true);
  assert.equal(relative.relationship, "relative");
  assert.equal(keyCompatibility("C major", "A minor").relationship, "relative");
});

test("key compatibility: unrelated keys are honestly flagged", () => {
  const clash = keyCompatibility("C major", "F# minor");
  assert.equal(clash.compatible, false);
  assert.equal(clash.relationship, "other");
  assert.match(clash.reason, /no simple relationship/);
});

test("key compatibility: missing or malformed keys say so", () => {
  const missing = keyCompatibility(null, "C major");
  assert.equal(missing.relationship, "unknown");
  assert.match(missing.reason, /not complete/);
  const malformed = keyCompatibility("definitely not a key", "C major");
  assert.equal(malformed.relationship, "unknown");
});

// ------------------------------------------------------------ beat alignment

const gridA = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000];
const gridB = [120, 620, 1120];

test("beat alignment: next beat at/after the current position, incoming snapped to its first beat", () => {
  const beat = beatAlignedTransitionStart(gridA, gridB, 1600, "beat");
  assert.equal(beat.ok, true);
  assert.equal(beat.startInCurrentMs, 2000);
  assert.equal(beat.incomingOffsetMs, 120);
  assert.equal(beat.approximate, true, "start-time alignment only — stated honestly");
  assert.match(beat.reason, /not ongoing phase sync/);
});

test("beat alignment: bar mode lands on every 4th beat from the grid's first beat", () => {
  const bar = beatAlignedTransitionStart(gridA, gridB, 1600, "bar");
  assert.equal(bar.ok, true);
  assert.equal(bar.startInCurrentMs, 2000, "bar boundaries are grid indices 0/4/8 → 0, 2000, 4000ms; next at/after 1600 is 2000");
  const fromStart = beatAlignedTransitionStart(gridA, gridB, 0, "bar");
  assert.equal(fromStart.startInCurrentMs, 0, "position 0 is ON the first bar boundary");
  const midBar = beatAlignedTransitionStart(gridA, gridB, 2100, "bar");
  assert.equal(midBar.startInCurrentMs, 4000, "past the 2000ms bar → the next bar boundary is 4000");
});

test("beat alignment: position before the grid, at the end, and missing grids", () => {
  const before = beatAlignedTransitionStart(gridA, gridB, -50, "beat");
  assert.equal(before.startInCurrentMs, 0);
  const past = beatAlignedTransitionStart(gridA, gridB, 99999, "beat");
  assert.equal(past.startInCurrentMs, 4000, "past the end clamps to the last beat");
  const noGrid = beatAlignedTransitionStart(null, gridB, 100, "beat");
  assert.equal(noGrid.ok, false);
  assert.match(noGrid.reason, /Beat grids are not available/);
  const junk = beatAlignedTransitionStart([0, "x", 500], gridB, 100, "beat");
  assert.equal(junk.ok, false, "unusable (non-integer) grids are rejected, never guessed");
});

// ------------------------------------------------------------- advancement

test("session advancement: ordered, stops at the end, no wrap", () => {
  const order = [
    { id: "st-1", trackId: "t-a" },
    { id: "st-2", trackId: "t-b" },
    { id: "st-3", trackId: "t-c" },
  ];
  assert.deepEqual(nextSessionTrack(order, "st-1"), { action: "play", sessionTrackId: "st-2", trackId: "t-b" });
  assert.deepEqual(nextSessionTrack(order, "st-3"), { action: "stop", reason: "end-of-session" });
  assert.deepEqual(nextSessionTrack(order, "not-there"), { action: "stop", reason: "end-of-session" });
  assert.deepEqual(nextSessionTrack(order, null), { action: "play", sessionTrackId: "st-1", trackId: "t-a" });
  assert.deepEqual(nextSessionTrack([], null), { action: "stop", reason: "empty-session" });
});

// --------------------------------------------------------------- stem swap

const realStems = (types: string[]) => types.map((stemType) => ({ stemType, engine: "demucs" }));

test("stem swap: valid when both tracks really have the stem", () => {
  assert.deepEqual(
    validateStemSwap(realStems(["vocals", "drums", "bass", "other"]), realStems(["vocals", "drums"]), "vocals"),
    { ok: true },
  );
});

test("stem swap: refuses when the current track lacks the layer", () => {
  const result = validateStemSwap(realStems(["drums", "bass"]), realStems(["vocals", "drums"]), "vocals");
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /current track has no real/);
});

test("stem swap: refuses when the donor cannot lend a REAL stem of that type", () => {
  const missing = validateStemSwap(realStems(["vocals", "drums"]), realStems(["drums", "bass"]), "vocals");
  assert.equal(missing.ok, false);
  assert.match((missing as { reason: string }).reason, /donor track has no separated/);
  const passthroughOnly = validateStemSwap(
    realStems(["vocals", "drums"]),
    [{ stemType: "source", engine: "passthrough-unseparated" }],
    "vocals",
  );
  assert.equal(passthroughOnly.ok, false, "a passthrough full-source row is not a lendable stem layer");
  assert.match((passthroughOnly as { reason: string }).reason, /donor track has no separated/);
});

// ------------------------------------------------- evidence labeling (P5) --

test("evidence: REAL tempo/key only when both analyses exist", () => {
  const full = { bpm: 124, musicalKey: "A minor", beatGridMs: [0, 480, 960] };
  const evidence = compatibilityEvidence(full, full, "manual");
  assert.equal(evidence.tempo.level, "real");
  assert.equal(evidence.key.level, "real");
});

test("evidence: UNAVAILABLE tempo/key when either analysis is missing", () => {
  const full = { bpm: 124, musicalKey: "A minor", beatGridMs: [0, 480, 960] };
  const none = { bpm: null, musicalKey: null, beatGridMs: null };
  const one = compatibilityEvidence(full, none, "manual");
  assert.equal(one.tempo.level, "unavailable");
  assert.equal(one.key.level, "unavailable");
  const other = compatibilityEvidence(null, full, "manual");
  assert.equal(other.tempo.level, "unavailable");
  assert.equal(other.key.level, "unavailable");
});

test("evidence: manual mode has no alignment concept (null)", () => {
  const full = { bpm: 124, musicalKey: "A minor", beatGridMs: [0, 480, 960] };
  assert.equal(compatibilityEvidence(full, full, "manual").alignment, null);
});

test("evidence: beat/bar alignment REAL on verified grids, UNAVAILABLE without", () => {
  const full = { bpm: 124, musicalKey: "A minor", beatGridMs: [0, 480, 960] };
  assert.equal(compatibilityEvidence(full, full, "bar").alignment?.level, "real");
  assert.match(compatibilityEvidence(full, full, "bar").alignment?.label ?? "", /start-time alignment/);
  const partial = { ...full, beatGridMs: null };
  assert.equal(compatibilityEvidence(full, partial, "beat").alignment?.level, "unavailable");
});

test("evidence: never claims phase-locked sync in any label", () => {
  const full = { bpm: 124, musicalKey: "A minor", beatGridMs: [0, 480, 960] };
  for (const mode of TRANSITION_MODES) {
    const evidence = compatibilityEvidence(full, full, mode);
    const text = [evidence.tempo.label, evidence.key.label, evidence.alignment?.label ?? ""].join(" ");
    assert.equal(/phase-locked/i.test(text), false, mode);
  }
});
