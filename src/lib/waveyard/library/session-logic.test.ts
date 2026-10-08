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
  defaultTransitionConfig,
  keyCompatibility,
  nextSessionTrack,
  normalizeTransitionConfig,
  tempoCompatibility,
  validateStemSwap,
} from "./session-logic";

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
  // junk keepStems entries are dropped, duplicates deduped
  const cleaned = normalizeTransitionConfig({ mode: "manual", crossfadeSeconds: 1, keepStems: ["drums", "drums", "", 42, "bass"] });
  assert.deepEqual(cleaned?.keepStems, ["drums", "bass"]);
  assert.deepEqual(defaultTransitionConfig(), { mode: "manual", crossfadeSeconds: 4, keepStems: [] });
});

test("crossfade envelope: linear, midpoint exact, completes exactly once at the end", () => {
  assert.deepEqual(crossfadeEnvelope(0, 4), { fromGain: 1, toGain: 0, done: false });
  assert.deepEqual(crossfadeEnvelope(2, 4), { fromGain: 0.5, toGain: 0.5, done: false });
  assert.deepEqual(crossfadeEnvelope(1, 4), { fromGain: 0.75, toGain: 0.25, done: false });
  const end = crossfadeEnvelope(4, 4);
  assert.deepEqual(end, { fromGain: 0, toGain: 1, done: true });
  assert.deepEqual(crossfadeEnvelope(9, 4), { fromGain: 0, toGain: 1, done: true }, "stays done after the end");
  assert.deepEqual(crossfadeEnvelope(-3, 4), { fromGain: 1, toGain: 0, done: false }, "negative elapsed = not started");
});

test("crossfade envelope: zero duration is an immediate hard cut", () => {
  assert.deepEqual(crossfadeEnvelope(0.001, 0), { fromGain: 0, toGain: 1, done: true });
  assert.deepEqual(crossfadeEnvelope(0, 0), { fromGain: 0, toGain: 1, done: true });
});

test("crossfade cancel: freezes both decks at the cancel point, never advances", () => {
  const at = crossfadeCancel(1, 4);
  assert.deepEqual(at, { fromGain: 0.75, toGain: 0.25, done: false, advanced: false });
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
