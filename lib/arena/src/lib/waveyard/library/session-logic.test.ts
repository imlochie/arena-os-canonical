/**
 * Session-logic tests — the P3 control contract: transition config
 * validation, crossfade envelopes (incl. hard cut + deterministic cancel),
 * tempo/key compatibility on the engine's own musical primitives, beat/bar
 * alignment from verified grids, session advancement, and stem-swap
 * validation. Pure logic; no browser audio fabricated.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { liveStemBeatOffsetSeconds, liveStemSectionOffsetSeconds } from "./session-logic";

test("live stem phase projects measured donor beats into tempo-stretched recipient time", () => {
  // 120 BPM recipient begins at 100ms; 100 BPM donor begins at 420ms.
  const ratio = 100 / 120;
  const offset = liveStemBeatOffsetSeconds([100, 600, 1100], [420, 1020, 1620], ratio)!;
  assert.ok(Math.abs(offset - 0.25) < 1e-10);
  for (let beat = 0; beat < 3; beat++) {
    assert.ok(Math.abs((0.1 + beat * 0.5 + offset) / ratio - (0.42 + beat * 0.6)) < 1e-10);
  }
  assert.equal(liveStemBeatOffsetSeconds(null, [0, 500], 1), null);
  assert.equal(liveStemBeatOffsetSeconds([0, 500], [0, 500], NaN), null);
});

test("live stem section phase aligns corresponding, structurally compatible sections", () => {
  const recipient = [
    { sectionIndex: 0, startMs: 0, endMs: 8_000, startBeatIndex: 0, endBeatIndex: 16, structuralConfidence: 0.9 },
    { sectionIndex: 1, startMs: 8_000, endMs: 16_000, startBeatIndex: 16, endBeatIndex: 32, structuralConfidence: 0.85 },
  ];
  const donor = [
    { sectionIndex: 0, startMs: 1_000, endMs: 9_000, startBeatIndex: 0, endBeatIndex: 16, structuralConfidence: 0.8 },
    { sectionIndex: 1, startMs: 9_000, endMs: 17_000, startBeatIndex: 16, endBeatIndex: 32, structuralConfidence: 0.8 },
  ];

  assert.equal(liveStemSectionOffsetSeconds(recipient, donor, 4, 1.1), 1.1);
  assert.equal(liveStemSectionOffsetSeconds(recipient, donor, 12, 1.1), 1.9);
});

test("live stem section phase refuses weak, mismatched, or out-of-range maps", () => {
  const recipient = [
    { sectionIndex: 0, startMs: 0, endMs: 8_000, startBeatIndex: 0, endBeatIndex: 16, structuralConfidence: 0.9 },
  ];
  const donor = [
    { sectionIndex: 0, startMs: 1_000, endMs: 9_000, startBeatIndex: 0, endBeatIndex: 24, structuralConfidence: 0.8 },
  ];
  const weak = [{ ...donor[0], structuralConfidence: 0.4 }];

  assert.equal(liveStemSectionOffsetSeconds(recipient, donor, 4, 1), null);
  assert.equal(liveStemSectionOffsetSeconds(recipient, weak, 4, 1), null);
  assert.equal(liveStemSectionOffsetSeconds(recipient, donor, 8, 1), null);
  assert.equal(liveStemSectionOffsetSeconds(recipient, donor, 4, Number.NaN), null);
});

import {
  MAX_CROSSFADE_SECONDS,
  automaticCueTiming,
  automaticTransitionCue,
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

test("performance snap leaves enough lead for the scheduled audio callback", () => {
  const grid = [0, 1000, 2000, 3000];
  assert.equal(nextPerformanceBoundary(0.9, grid, "beat", undefined, 0.18), 2);
  assert.equal(nextPerformanceBoundary(0.75, grid, "beat", undefined, 0.18), 1);
  assert.equal(nextPerformanceBoundary(0.41, grid, "half", undefined, 0.12), 1);
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

for (const kind of ["source-to-stems", "stems-to-stems"] as const) {
  test(`${kind}: unequal stem levels receive exactly one equal-power envelope`, () => {
    const outgoing: Record<string, number> = kind === "source-to-stems"
      ? { source: 1 }
      : { vocals: 0.42, drums: 0.78, bass: 0, other: 0.31 };
    const incoming = { vocals: 0.63, drums: 0.29, bass: 0.81, other: 0 };
    const energy = (mix: Record<string, number>) =>
      Object.values(mix).reduce((sum, gain) => sum + gain * gain, 0);
    for (const master of [0, 0.37, 1]) {
      const fromPower = energy(outgoing) * master * master;
      const toPower = energy(incoming) * master * master;
      for (let step = 0; step <= 100; step++) {
        const envelope = crossfadeEnvelope(step / 25, 4);
        const from = scaleCrossfadeStemVolumes(outgoing, [], envelope.fromGain);
        // Incoming playback uses its unchanged faders and a deck master
        // envelope. Outgoing stems instead receive the envelope at each fader.
        const fromOutput = Object.fromEntries(Object.entries(from).map(([stem, gain]) => [stem, gain * master]));
        const toOutput = Object.fromEntries(Object.entries(incoming).map(([stem, gain]) => [stem, gain * master * envelope.toGain]));
        for (const [stem, level] of Object.entries(outgoing)) {
          assert.ok(Math.abs(fromOutput[stem] - level * master * envelope.fromGain) < 1e-12,
            `${stem} must not receive a squared fade or lose its saved balance`);
        }
        const expectedPower = fromPower * envelope.fromGain ** 2 + toPower * envelope.toGain ** 2;
        const actualPower = energy(fromOutput) + energy(toOutput);
        assert.ok(Math.abs(actualPower - expectedPower) < 1e-12);
        // Unequal source/stem baselines need not have identical RMS. Their
        // uncorrelated power must interpolate between those measured baselines.
        assert.ok(actualPower >= Math.min(fromPower, toPower) - 1e-12);
        assert.ok(actualPower <= Math.max(fromPower, toPower) + 1e-12);
        assert.equal(toOutput.other, 0, "a muted incoming layer stays muted");
        if ("bass" in outgoing) assert.equal(fromOutput.bass, 0, "a muted outgoing layer stays muted");
      }
    }
  });
}

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
  assert.equal(liveStemTempoStretchRatio(120, 140), 140 / 120, "different tempos are processed rather than left unsynchronised");
  assert.equal(liveStemTempoStretchRatio(126, 101), 101 / 126);
  assert.equal(liveStemTempoStretchRatio(101, 126), 126 / 101);
  assert.equal(liveStemTempoStretchRatio(120, 59), null, "do not exceed the engine's supported duration range");
  assert.equal(liveStemTempoStretchRatio(120, 241), null);
  assert.equal(liveStemTempoStretchRatio(0, 120), null);
  assert.equal(liveStemTempoStretchRatio(120, NaN), null);
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

test("automatic fades choose the last verified beat or bar that fits before the end", () => {
  const grid = Array.from({ length: 24 }, (_, i) => 120 + i * 500);
  for (const [mode, expected] of [["beat", 9620], ["bar", 8120]] as const) {
    const cue = automaticTransitionCue({ ...defaultTransitionConfig(), mode, crossfadeSeconds: 2 }, 12, grid, gridB);
    assert.equal(cue.ok, true);
    assert.equal(cue.startInCurrentMs, expected);
    assert.equal(cue.incomingOffsetMs, 120);
    assert.ok(cue.startInCurrentMs! + 2000 <= 12000);
  }
});

test("automatic alignment refuses missing, invalid, or too-late grids rather than guessing", () => {
  for (const mode of ["beat", "bar"] as const) {
    const cfg = { ...defaultTransitionConfig(), mode, crossfadeSeconds: 2 };
    for (const [outgoing, incoming] of [[null, gridB], [gridA, null], [[], gridB], [[0, "bad"], gridB], [[11000, 11500], gridB]]) {
      assert.equal(automaticTransitionCue(cfg, 12, outgoing, incoming).ok, false);
    }
    assert.equal(automaticTransitionCue({ ...cfg, crossfadeSeconds: 20 }, 12, gridA, gridB).ok, false);
  }
});

test("automatic manual crossfade keeps its duration-based cue without beat grids", () => {
  const cue = automaticTransitionCue({ ...defaultTransitionConfig(), crossfadeSeconds: 2 }, 12, null, null);
  assert.equal(cue.startInCurrentMs, 10000);
  assert.equal(cue.incomingOffsetMs, 0);
});

test("automatic cue timing waits before the cue and refuses a late off-beat start", () => {
  assert.equal(automaticCueTiming(9749, 9750), "wait");
  assert.equal(automaticCueTiming(9750, 9750), "start");
  assert.equal(automaticCueTiming(10100, 9750), "start");
  assert.equal(automaticCueTiming(10101, 9750), "missed");
});

test("live fade edits recompute safe cues without moving a late clock onto a beat", () => {
  const grid = Array.from({ length: 24 }, (_, i) => 250 + i * 500);
  for (const [mode, length, cueMs] of [
    ["beat", 2, 9750], ["beat", 3, 8750], ["bar", 2, 8250], ["bar", 4, 6250],
  ] as const) {
    const cue = automaticTransitionCue({ ...defaultTransitionConfig(), mode, crossfadeSeconds: length }, 12, grid, grid);
    assert.equal(cue.startInCurrentMs, cueMs);
    assert.equal(automaticCueTiming(cueMs - 1, cue.startInCurrentMs!), "wait", "a pre-cue edit waits instead of seeking forward");
    assert.equal(automaticCueTiming(cueMs + 200, cue.startInCurrentMs!), "start", "a slightly late callback stays within the control window");
    assert.equal(automaticCueTiming(cueMs + 351, cue.startInCurrentMs!), "missed", "a post-cue edit cannot cause an off-beat start");
    assert.equal(automaticCueTiming(11200, cue.startInCurrentMs!), "missed", "backgrounded clocks must not start a guessed fade");
    assert.ok(cue.startInCurrentMs! + length * 1000 <= 12000);
  }
});

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
