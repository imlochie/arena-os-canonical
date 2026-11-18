import assert from "node:assert/strict";
import test from "node:test";
import { ANALYSIS_PCM_RATE } from "./analysis-engine";
import {
  applyBreakdownCandidates,
  applyFormPredictions,
  detectBreakdownCandidates,
  inferFormFromWindows,
  measureFormWindows,
  type FormWindow,
} from "./musical-form";
import { displaySourceSectionLabel, normalizeSourceSections } from "../types/source-sections";
import { DESKTOP_SECTION_ENGINE_VERSION } from "../types/analysis-provenance";

const window = (startBar: number, role: "a" | "b" | "c", energyDb = -20): FormWindow => ({
  startBar,
  vocal: role === "a" ? [1, 0, 0] : role === "b" ? [0, 1, 0] : [0, 0, 1],
  backing: [1, 0, 0], vocalCoverage: 0.9, energyDb,
});
const arrangement = () => Array.from({ length: 32 }, (_, startBar) => {
  const phase = (startBar + 4) % 16;
  return window(startBar, phase < 8 ? "a" : "b", phase < 8 ? -20 : -15);
});

test("infers both recurrent vocal roles from an alternating arrangement and measured lift", () => {
  const predictions = inferFormFromWindows(arrangement());
  assert.deepEqual(predictions.map(p => [p.startBar, p.label]), [
    [0, "verse"], [8, "chorus"], [16, "verse"], [24, "chorus"],
  ]);
  assert.deepEqual(predictions.map(p => p.endBar), [8, 16, 24, 32]);
  assert.ok(predictions.every(p => p.strength <= 0.7));
});

test("a recurrent chorus can anchor verses whose vocal melodies do not repeat", () => {
  const verseOne = window(0, "a");
  verseOne.vocalPhraseTiming = [1, 0, 0];
  const chorusOne = window(8, "c", -15);
  chorusOne.vocalPhraseTiming = [0, 0, 1];
  const verseTwo = window(16, "b");
  verseTwo.vocalPhraseTiming = [1, 0, 0];
  const chorusTwo = window(24, "c", -15);
  chorusTwo.vocalPhraseTiming = [0, 0, 1];
  const evidence = [
    verseOne, chorusOne, verseTwo, chorusTwo,
    ...[4, 12, 20, 28].map(startBar => ({ ...window(startBar, "a"), vocalCoverage: 0 })),
  ];

  assert.deepEqual(inferFormFromWindows(evidence).map(p => [p.startBar, p.label]), [
    [0, "verse"], [8, "chorus"], [16, "verse"], [24, "chorus"],
  ]);
});

test("one-off verse candidates abstain when their backing patterns conflict", () => {
  const verseOne = window(0, "a");
  verseOne.vocalPhraseTiming = [1, 0, 0];
  const chorusOne = window(8, "c", -15);
  chorusOne.vocalPhraseTiming = [0, 0, 1];
  const verseTwo = window(16, "b");
  verseTwo.vocalPhraseTiming = [1, 0, 0];
  verseTwo.backing = [0, 1, 0];
  const chorusTwo = window(24, "c", -15);
  chorusTwo.vocalPhraseTiming = [0, 0, 1];
  const evidence = [
    verseOne, chorusOne, verseTwo, chorusTwo,
    ...[4, 12, 20, 28].map(startBar => ({ ...window(startBar, "a"), vocalCoverage: 0 })),
  ];

  assert.deepEqual(inferFormFromWindows(evidence), []);
});

test("repetition, energy alone, missing vocal activity and ambiguous competing hooks abstain", () => {
  assert.deepEqual(inferFormFromWindows(arrangement().map(w => ({ ...w, vocal: [1, 0, 0] }))), []);
  assert.deepEqual(inferFormFromWindows(arrangement().map(w => ({ ...w, energyDb: -20 }))), []);
  assert.deepEqual(inferFormFromWindows(arrangement().map(w => ({ ...w, vocalCoverage: 0 }))), []);
  const competing = [
    window(0, "a"), window(8, "b", -15), window(16, "c", -15),
    window(24, "a"), window(32, "b", -15), window(40, "c", -15),
    window(48, "a"), window(56, "a"),
  ];
  assert.deepEqual(inferFormFromWindows(competing), []);
});

test("a repeated hook after the alternating form is not automatically another chorus", () => {
  const predicted = inferFormFromWindows([...arrangement(), window(40, "b", -15), window(48, "b", -15)]);
  assert.ok(predicted.length >= 4);
  assert.ok(predicted.every(p => p.startBar < 40));
  assert.ok(predicted.at(-1)!.endBar - predicted.at(-1)!.startBar <= 8,
    "a second hook match must not stretch a chorus across an unverified breakdown or outro");
});

test("overlapping role windows resolve to non-overlapping section timing", () => {
  const windows = Array.from({ length: 64 }, (_, startBar) => {
    const phase = startBar % 32;
    const isA = phase < 8 || (phase >= 16 && phase < 24);
    return {
      ...window(startBar, isA ? "a" : "b", isA ? -20 : -15),
      vocal: isA ? [1, 0] : [0, 1],
    };
  });
  const predictions = inferFormFromWindows(windows);
  assert.ok(predictions.length > 4);
  for (const left of predictions) {
    for (const right of predictions) {
      if (left.label !== right.label) {
        assert.ok(left.endBar <= right.startBar || right.endBar <= left.startBar,
          "overlapping role claims are left unlabelled rather than guessed");
      }
    }
  }
  assert.ok(predictions.some(p => p.startBar === 0 && p.endBar === 8 && p.label === "verse"));
  assert.ok(predictions.some(p => p.startBar === 8 && p.endBar === 16 && p.label === "chorus"));
});

test("provenance-checked vocal continuity timing strengthens repeated vocal-flow matches", () => {
  const verseA = window(0, "a");
  verseA.vocalPhraseTiming = [1, 0, 0];
  const verseB = window(16, "a");
  verseB.vocal = [0.65, Math.sqrt(1 - 0.65 ** 2), 0];
  verseB.vocalPhraseTiming = [1, 0, 0];
  const chorusA = window(8, "c", -15);
  chorusA.vocalPhraseTiming = [0, 0, 1];
  const chorusB = window(24, "c", -15);
  chorusB.vocalPhraseTiming = [0, 0, 1];
  const evidence = [
    verseA, chorusA, verseB, chorusB,
    ...[4, 12, 20, 28].map(startBar => ({ ...window(startBar, "b"), vocalCoverage: 0 })),
  ];

  assert.deepEqual(inferFormFromWindows(evidence).map(p => [p.startBar, p.label]), [
    [0, "verse"], [8, "chorus"], [16, "verse"], [24, "chorus"],
  ]);
  assert.deepEqual(inferFormFromWindows(evidence.map(({ vocalPhraseTiming: _timing, ...w }) => w)), [],
    "the same sub-threshold chroma similarity still abstains without vocal-timing evidence");
});

test("invalid/insufficient audio cannot produce form observations", () => {
  assert.deepEqual(measureFormWindows(new Float32Array(), new Float32Array(), []), []);
  assert.deepEqual(measureFormWindows(new Float32Array(100), new Float32Array(100), [0, 500, 400]), []);
});

test("a breakdown candidate requires active vocals and drums around a sustained accompaniment drop", () => {
  const bars = 32;
  const levels = (role: string) => Array.from({ length: bars }, (_, bar) => {
    if (role === "other" && bar >= 8 && bar < 16) return -42;
    return role === "bass" ? -50 : -24;
  });
  const profiles = ["vocals", "drums", "bass", "other"].map((stemType) => ({
    stemType,
    rmsDbByBar: levels(stemType),
  }));
  const beatGridMs = Array.from({ length: bars * 4 + 1 }, (_, beat) => beat * 500);
  const activity = [{ startMs: 16_000, endMs: 32_000, confidence: 0.9 }];
  const predicted = detectBreakdownCandidates({
    profiles,
    beatGridMs,
    vocalActivityIntervals: activity,
  });
  assert.deepEqual(predicted.map((entry) => [
    entry.startBar, entry.endBar, entry.accompanimentRole, entry.accompanimentDropDb,
  ]), [[8, 16, "other", 18]]);

  const resulting = applyBreakdownCandidates([{
    startBeatIndex: 0,
    endBeatIndex: bars * 4,
    label: "section",
    labelConfidence: 0,
    structuralConfidence: 0.8,
  }], predicted);
  assert.deepEqual(resulting.map((entry) => [entry.startBeatIndex, entry.endBeatIndex, entry.label]), [
    [0, 32, "section"], [32, 64, "breakdown-candidate"], [64, 128, "section"],
  ]);
  const withFormEvidence = applyFormPredictions(resulting, [
    { startBar: 8, endBar: 16, label: "verse", strength: 0.7 },
  ]);
  assert.equal(withFormEvidence[1]!.label, "breakdown-candidate",
    "a semantic-form hypothesis must not overwrite the explicit arrangement event");
  const persistedShape = normalizeSourceSections(
    withFormEvidence,
    beatGridMs,
    { analysisEngine: "arena-js-structure", analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION, sourceChecksumSha256: "a".repeat(64) },
    ({ startBeatIndex, endBeatIndex }) => `${startBeatIndex}-${endBeatIndex}`,
    64_000,
  );
  assert.deepEqual(persistedShape.map((section) => section.label), [
    "section", "breakdown-candidate", "section",
  ]);
  assert.equal(persistedShape[1]!.startMs, 16_000);
  assert.equal(persistedShape[1]!.endMs, 32_000);
  assert.match(displaySourceSectionLabel(persistedShape[1]!), /Possible vocal\/percussion-led breakdown/);
});

test("a dropout without maintained vocals or drums is not called a vocal/percussion breakdown", () => {
  const bars = 32;
  const profiles = ["vocals", "drums", "bass", "other"].map((stemType) => ({
    stemType,
    rmsDbByBar: Array.from({ length: bars }, (_, bar) => {
      if (bar >= 8 && bar < 16 && (stemType === "other" || stemType === "drums")) return -48;
      return stemType === "bass" ? -50 : -24;
    }),
  }));
  const beatGridMs = Array.from({ length: bars * 4 + 1 }, (_, beat) => beat * 500);
  assert.deepEqual(detectBreakdownCandidates({
    profiles,
    beatGridMs,
    vocalActivityIntervals: [{ startMs: 16_000, endMs: 32_000, confidence: 0.9 }],
  }), []);
  assert.deepEqual(detectBreakdownCandidates({
    profiles: profiles.map((profile) => ({
      ...profile,
      rmsDbByBar: profile.rmsDbByBar.map((level, bar) =>
        profile.stemType === "drums" && bar >= 8 && bar < 16 ? -24 : level),
    })),
    beatGridMs,
    vocalActivityIntervals: [],
  }), []);
});

test("a small accompaniment dip is left as an unlabelled section", () => {
  const bars = 32;
  const profiles = ["vocals", "drums", "bass", "other"].map((stemType) => ({
    stemType,
    rmsDbByBar: Array.from({ length: bars }, (_, bar) =>
      stemType === "other" && bar >= 8 && bar < 16 ? -31 : stemType === "bass" ? -50 : -24),
  }));
  const beatGridMs = Array.from({ length: bars * 4 + 1 }, (_, beat) => beat * 500);
  assert.deepEqual(detectBreakdownCandidates({
    profiles,
    beatGridMs,
    vocalActivityIntervals: [{ startMs: 16_000, endMs: 32_000, confidence: 0.9 }],
  }), [], "a 7 dB accompaniment change does not cross the conservative evidence floor");
});

test("beat-relative vocal pitch-continuity runs are added as timing evidence", () => {
  const sampleCount = ANALYSIS_PCM_RATE * 41;
  const audio = Float32Array.from({ length: sampleCount }, (_, i) =>
    0.3 * Math.sin(2 * Math.PI * 110 * i / ANALYSIS_PCM_RATE));
  const beatGrid = Array.from({ length: 20 * 4 + 1 }, (_, i) => i * 500);
  const windows = measureFormWindows(audio, audio, beatGrid, [
    { startMs: 500, endMs: 1_000, confidence: 0.9 },
  ]);
  assert.ok(windows.length > 0);
  assert.equal(windows[0]!.vocalPhraseTiming?.length, 128);
  assert.ok(windows[0]!.vocalPhraseTiming![2]! > 0);
  assert.ok(windows[0]!.vocalPhraseTiming![64 + 2]! > 0);
  const combined = measureFormWindows(audio, audio, beatGrid,
    [{ startMs: 750, endMs: 1_000, confidence: 0.9 }],
    [{ startMs: 500, endMs: 1_250, confidence: 0.8 }]);
  assert.ok(combined[0]!.vocalPhraseTiming![2]! > 0, "unpitched vocal entry survives sparse pitch coverage");
  assert.equal(combined[0]!.vocalPhraseTiming![64 + 2], 0);
  assert.ok(combined[0]!.vocalPhraseTiming![64 + 3]! > 0, "pitched articulation remains independent of coarse activity");
  assert.deepEqual(measureFormWindows(audio, audio, beatGrid, [
    { startMs: 500, endMs: 1_000, confidence: 0.9 },
    { startMs: 400, endMs: 800, confidence: 0.8 },
  ]), measureFormWindows(audio, audio, beatGrid),
  "invalid optional timing preserves the verified PCM fallback");
});

test("inferred roles keep section IDs, gaps and fingerprint ranges stable through persistence", () => {
  const original = Array.from({ length: 5 }, (_, i) => ({
    startBeatIndex: i * 32, endBeatIndex: (i + 1) * 32,
    label: "section", labelConfidence: 0, structuralConfidence: 0.9,
  }));
  const predictions = inferFormFromWindows(arrangement());
  const candidates = applyFormPredictions(original, predictions);
  assert.equal(original.length, 5);
  assert.equal(original[0]!.label, "section");
  const sections = normalizeSourceSections(candidates,
    Array.from({ length: 161 }, (_, i) => i * 500),
    { analysisEngine: "arena-js-structure", analysisEngineVersion: "1.9.0", sourceChecksumSha256: "a".repeat(64) },
    ({ startBeatIndex, endBeatIndex }) => `${startBeatIndex}-${endBeatIndex}`, 80_000);
  assert.equal(sections.length, 5);
  assert.deepEqual(sections.map(s => s.id),
    original.map(o => `${o.startBeatIndex}-${o.endBeatIndex}`));
  assert.deepEqual(sections.filter(s => ["verse", "chorus"].includes(s.label)).map(s => s.label),
    ["verse", "chorus", "verse", "chorus"]);
  assert.equal(sections.at(-1)!.endMs, 80_000);
  assert.equal(sections.at(-1)!.label, "section");
  assert.match(displaySourceSectionLabel(sections.find(s => s.label === "chorus")!), /^Inferred chorus/);
  assert.equal(applyFormPredictions([{ ...original[0]!, endBeatIndex: 48 }], predictions)[0]!.label,
    "section", "mixed-role structural windows must not be guessed");
});
