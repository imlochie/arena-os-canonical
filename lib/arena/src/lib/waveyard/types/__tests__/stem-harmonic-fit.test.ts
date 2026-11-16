import assert from "node:assert/strict";
import test from "node:test";

import {
  assessStemHarmonicFit,
  harmonicConformance,
  MIN_JUDGED_MS,
  type StemHarmonyChord,
  type StemHarmonyNote,
} from "../stem-harmonic-fit";
import { bedChordsFromHarmonyEvents, placedVocalNotes } from "../stem-harmonic-adapter";
import type { HarmonyEvent } from "../harmony-analysis";

const chord = (root: number, startMs: number, endMs: number, kind: "major" | "minor" = "major"): StemHarmonyChord => ({
  startMs,
  endMs,
  root,
  pitchClasses: kind === "major" ? [root, (root + 4) % 12, (root + 7) % 12]
    : [root, (root + 3) % 12, (root + 7) % 12],
});
const note = (midiNote: number, startMs: number, durationMs: number): StemHarmonyNote =>
  ({ startMs, endMs: startMs + durationMs, midiNote, velocity: 100 });

// --- the classification the old membership check could not make --------------

test("a chord tone is a chord tone", () => {
  // C major (C=0, E=4, G=7) under an E and a G.
  const result = assessStemHarmonicFit({
    notes: [note(64, 0, 600), note(67, 600, 600), note(64, 1200, 600)],
    bedChords: [chord(0, 0, 2000)],
    fromMs: 0, toMs: 2000,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.equal(result.chordToneShare, 1);
  assert.equal(result.clashShare, 0);
  assert.equal(result.resolvedShare, 0);
});

test("a non-chord tone that steps into the next chord tone is passing, not a clash", () => {
  // D (62) over C major is a non-member; it steps to E (64), a member.
  const result = assessStemHarmonicFit({
    notes: [note(62, 0, 300), note(64, 300, 900), note(67, 1200, 600)],
    bedChords: [chord(0, 0, 1800)],
    fromMs: 0, toMs: 1800,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.equal(result.clashShare, 0, "a stepwise resolution must not be scored as a clash");
  assert.ok(result.resolvedShare > 0, "the passing tone contributes resolved time");
  const passing = result.relations.find((relation) => relation.kind === "passing");
  assert.ok(passing, `expected a passing relation, saw ${result.relations.map((r) => r.kind).join(",")}`);
  assert.equal(passing.distanceSemitones, 2);
});

test("a held non-chord tone that steps out is a suspension, not a passing tone", () => {
  // F (65) held across most of a C chord, then resolving by step to E (64).
  const result = assessStemHarmonicFit({
    notes: [note(65, 0, 600), note(64, 600, 600), note(60, 1200, 600)],
    bedChords: [chord(0, 0, 1800)],
    fromMs: 0, toMs: 1800,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  const kinds = result.relations.map((relation) => relation.kind);
  assert.ok(kinds.includes("suspension"), `expected a suspension, saw ${kinds.join(",")}`);
  assert.equal(result.clashShare, 0);
});

test("a non-chord tone that leaps away or never resolves is a clash", () => {
  // C# (61) over C major, then leaping a fourth to F# (66): no resolution.
  const result = assessStemHarmonicFit({
    notes: [note(61, 0, 600), note(66, 600, 600), note(60, 1200, 600)],
    bedChords: [chord(0, 0, 1800)],
    fromMs: 0, toMs: 1800,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.ok(result.clashShare > 0, "an unresolved semitone must register as tension");
  const clash = result.relations.find((relation) => relation.kind === "clash");
  assert.ok(clash);
  assert.equal(clash.distanceSemitones, 1);
});

test("harmonic movement is visible, not collapsed into one global key", () => {
  // C major for two notes, then F major for two: the same pitches (C, E, G, A)
  // are consonant against the first and A is a non-member against the second.
  const result = assessStemHarmonicFit({
    notes: [note(60, 0, 450), note(64, 450, 450), note(65, 900, 450), note(69, 1350, 450)],
    bedChords: [chord(0, 0, 900), chord(5, 900, 1800)],
    fromMs: 0, toMs: 1800,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.equal(result.bedChordChanges, 1);
  // F major = F(5), A(9), C(0). F and A are members; nothing here clashes.
  assert.equal(result.clashShare, 0);
  assert.ok(result.chordToneShare > 0.9);
});

// --- refusing to answer -----------------------------------------------------

test("no named bed chord means unavailable, never agreement", () => {
  const result = assessStemHarmonicFit({
    notes: [note(64, 0, 600), note(67, 600, 600)],
    bedChords: [],
    fromMs: 0, toMs: 1200,
  });
  assert.equal(result.status, "unavailable");
});

test("an unnamed chord region is excluded from the share, not counted as agreement", () => {
  const result = assessStemHarmonicFit({
    notes: [
      note(64, 0, 600), note(67, 600, 600),           // under the named chord
      note(61, 1200, 600), note(66, 1800, 600),       // under an unnamed region
    ],
    bedChords: [chord(0, 0, 1200), { startMs: 1200, endMs: 2400, root: null, pitchClasses: [] }],
    fromMs: 0, toMs: 2400,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.equal(result.chordToneShare, 1, "only the judged half is in the share");
  assert.ok(result.unjudgedShare > 0.4);
  assert.equal(result.judgedMs, 1200);
  assert.equal(result.examinedMs, 2400);
});

test("too little judged time is unavailable rather than a confident number", () => {
  const result = assessStemHarmonicFit({
    notes: [note(64, 0, 200)],
    bedChords: [chord(0, 0, 200)],
    fromMs: 0, toMs: 200,
  });
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.ok(result.reason.includes(String(MIN_JUDGED_MS)));
});

test("no donor notes is unavailable", () => {
  assert.equal(assessStemHarmonicFit({
    notes: [], bedChords: [chord(0, 0, 2000)], fromMs: 0, toMs: 2000,
  }).status, "unavailable");
});

// --- the regression this work exists for -----------------------------------

test("source mixes can agree while the retained stems do not", () => {
  // Two songs whose complete mixes are both centred on C: a source-mix
  // progression comparison sees agreement. A hybrid keeps the anchor bed and
  // the donor vocal, so the only harmony that will be heard is this bed.
  const sourceMixBothInC: HarmonyEvent[][] = [
    [{ startMs: 0, endMs: 4000, root: "C", quality: "major", confidence: 0.6 }],
    [{ startMs: 0, endMs: 4000, root: "C", quality: "major", confidence: 0.6 }],
  ];
  const anchorBed = bedChordsFromHarmonyEvents(sourceMixBothInC[0]!);
  const anchorMix = bedChordsFromHarmonyEvents(sourceMixBothInC[1]!);
  assert.deepEqual(anchorBed, anchorMix, "the mixes are indistinguishable in C");

  // The donor vocal that actually survives is written a semitone above the bed:
  // every sustained note is a non-member that does not resolve.
  const donorVocal = [note(61, 0, 900), note(65, 900, 900), note(68, 1800, 900)];
  const result = assessStemHarmonicFit({
    notes: donorVocal, bedChords: anchorBed, fromMs: 0, toMs: 2700,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.ok(result.clashShare > 0.9,
    `the retained vocal must register as clashing even though the mixes agree (${result.clashShare})`);
  assert.ok(harmonicConformance(result) < 0.1);

  // The same vocal against a bed a semitone higher conforms.
  const shifted = [chord(1, 0, 2700)];
  const moved = assessStemHarmonicFit({ notes: donorVocal, bedChords: shifted, fromMs: 0, toMs: 2700 });
  assert.equal(moved.status, "measured");
  if (moved.status !== "measured") return;
  assert.ok(harmonicConformance(moved) > 0.9);
  assert.ok(harmonicConformance(moved) > harmonicConformance(result),
    "the assessment must separate the two placements the mixes could not");
});

// --- adapter honesty -------------------------------------------------------

test("unknown-quality chords are not converted into named chords", () => {
  const chords = bedChordsFromHarmonyEvents([
    { startMs: 0, endMs: 1000, root: null, quality: "unknown", confidence: 0 },
    { startMs: 1000, endMs: 2000, root: "C", quality: "major", confidence: 0.6 },
  ]);
  assert.deepEqual(chords[0]!.pitchClasses, []);
  assert.equal(chords[0]!.root, null);
  assert.deepEqual(chords[1]!.pitchClasses, [0, 4, 7]);
});

test("placed notes are mapped into the bed timeline with the arrangement's stretch", () => {
  const frames = Array.from({ length: 20 }, (_, index) => ({
    timestampMs: 1000 + index * 100,
    frequencyHz: 261.63,
    midiFloat: 60,
    nearestMidiNote: 60,
    confidence: 0.95,
    voiced: true,
  }));
  const notes = placedVocalNotes({
    vocalFrames: frames, sourceStartMs: 1000, sourceEndMs: 3000,
    targetStartMs: 8000, stretchRatio: 1.5, pitchShiftSemitones: -3,
  });
  assert.ok(notes?.length);
  assert.ok(notes!.every((placed) => placed.midiNote === 57), "the arrangement's shift is applied");
  assert.ok(notes![0]!.startMs >= 8000, "notes land in the bed timeline");
  assert.ok(notes!.at(-1)!.endMs > 8000);
});
