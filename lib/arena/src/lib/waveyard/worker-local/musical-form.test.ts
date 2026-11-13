import assert from "node:assert/strict";
import test from "node:test";
import { applyFormPredictions, inferFormFromWindows, measureFormWindows, type FormWindow } from "./musical-form";
import { displaySourceSectionLabel, normalizeSourceSections } from "../types/source-sections";

const window = (startBar: number, role: "a" | "b" | "c", energyDb = -20): FormWindow => ({
  startBar,
  vocal: role === "a" ? [1, 0, 0] : role === "b" ? [0, 1, 0] : [0, 0, 1],
  backing: [1, 0, 0], vocalCoverage: 0.9, energyDb,
});
const arrangement = () => [
  window(0, "a"), window(8, "b", -15), window(16, "a"), window(24, "b", -15),
  // More windows provide full-track coverage, not extra evidence for either family.
  ...[4, 12, 20, 28].map(bar => ({ ...window(bar, "c", -30), vocalCoverage: 0 })),
];

test("infers both recurrent vocal roles from an alternating arrangement and measured lift", () => {
  const predictions = inferFormFromWindows(arrangement());
  assert.deepEqual(predictions.map(p => [p.startBar, p.label]), [
    [0, "verse"], [8, "chorus"], [16, "verse"], [24, "chorus"],
  ]);
  assert.ok(predictions.every(p => p.strength <= 0.7));
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
});

test("invalid/insufficient audio cannot produce form observations", () => {
  assert.deepEqual(measureFormWindows(new Float32Array(), new Float32Array(), []), []);
  assert.deepEqual(measureFormWindows(new Float32Array(100), new Float32Array(100), [0, 500, 400]), []);
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
    { analysisEngine: "arena-js-structure", analysisEngineVersion: "1.8.0", sourceChecksumSha256: "a".repeat(64) },
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
