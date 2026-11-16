import assert from "node:assert/strict";
import test from "node:test";

import {
  assessBassLine,
  bassContradictsHarmony,
  MIN_BASS_JUDGED_MS,
  type BassHarmonyChord,
  type BassLineNote,
} from "../bass-harmony-fit";
import { placeBassNotes, sustainBassNotes } from "../stem-harmonic-adapter";

const chord = (root: number, startMs: number, endMs: number, kind: "major" | "minor" = "major"): BassHarmonyChord => ({
  startMs,
  endMs,
  root,
  pitchClasses: kind === "major" ? [root, (root + 4) % 12, (root + 7) % 12]
    : [root, (root + 3) % 12, (root + 7) % 12],
});
const note = (midiNote: number, startMs: number, durationMs: number): BassLineNote =>
  ({ startMs, endMs: startMs + durationMs, midiNote, confidence: 0.9 });

// C2 = 36, E2 = 40, G2 = 43, F2 = 41, D2 = 38, B1 = 35.

test("a bass note on the chord root is root support", () => {
  const result = assessBassLine({
    notes: [note(36, 0, 900), note(36, 900, 900)],
    bedChords: [chord(0, 0, 2000)],
    fromMs: 0, toMs: 2000,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.equal(result.supportShare, 1);
  assert.equal(result.contradictionShare, 0);
  assert.ok(result.relations.every((relation) => relation.kind === "root"));
});

test("an inversion is chord-tone support, not a contradiction", () => {
  // E in the bass under C major is a first inversion: legitimate.
  const result = assessBassLine({
    notes: [note(40, 0, 2000)],
    bedChords: [chord(0, 0, 2000)],
    fromMs: 0, toMs: 2000,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.ok(result.relations.every((relation) => relation.kind === "chordTone"));
  assert.equal(result.contradictionShare, 0);
  assert.equal(bassContradictsHarmony(result).contradicts, false);
});

test("a sustained pedal under a chord change is named a pedal, not two contradictions", () => {
  // C held in the bass while the harmony moves C major -> F major -> G major.
  // C suits the first, is the fifth of F, but is foreign to G.
  const result = assessBassLine({
    notes: [note(36, 0, 2400)],
    bedChords: [chord(0, 0, 800), chord(5, 800, 1600), chord(7, 1600, 2400)],
    fromMs: 0, toMs: 2400,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  const pedals = result.relations.filter((relation) => relation.kind === "pedal");
  assert.ok(pedals.length > 0, `expected a pedal, saw ${result.relations.map((r) => r.kind).join(",")}`);
  assert.equal(result.contradictionShare, 0, "a deliberate pedal must not be scored as contradiction");
  assert.equal(bassContradictsHarmony(result).contradicts, false);
});

test("a passing bass note that steps to a chord tone is motion, not contradiction", () => {
  // D (38) is not in C major, but it steps to E (40), a chord tone.
  const result = assessBassLine({
    notes: [note(38, 0, 400), note(40, 400, 1600)],
    bedChords: [chord(0, 0, 2000)],
    fromMs: 0, toMs: 2000,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  const passing = result.relations.find((relation) => relation.kind === "passing");
  assert.ok(passing, `expected passing, saw ${result.relations.map((r) => r.kind).join(",")}`);
  assert.equal(result.contradictionShare, 0);
});

test("a chromatic approach into the next chord root is approach motion", () => {
  // D# (39) approaches E (40), the root of the next chord.
  const result = assessBassLine({
    notes: [note(39, 0, 500), note(40, 500, 1000)],
    bedChords: [chord(0, 0, 500), chord(4, 500, 1500)],
    fromMs: 0, toMs: 1500,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  const approach = result.relations.find((relation) => relation.kind === "approach");
  assert.ok(approach, `expected approach, saw ${result.relations.map((r) => r.kind).join(",")}`);
  assert.equal(result.contradictionShare, 0);
});

test("a sustained foreign pitch that does not resolve is a contradiction", () => {
  // F# (42) held under C major, then leaping away: no stepwise resolution.
  const result = assessBassLine({
    notes: [note(42, 0, 900), note(45, 900, 900)],
    bedChords: [chord(0, 0, 2000)],
    fromMs: 0, toMs: 2000,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.ok(result.contradictionShare > 0.9);
  assert.equal(bassContradictsHarmony(result).contradicts, true);
});

test("a mostly supportive line with one dissonance is not rejected", () => {
  const result = assessBassLine({
    notes: [note(36, 0, 1200), note(42, 1200, 400), note(36, 1600, 1200)],
    bedChords: [chord(0, 0, 3000)],
    fromMs: 0, toMs: 3000,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.ok(result.contradictionShare < 0.5);
  assert.equal(bassContradictsHarmony(result).contradicts, false);
});

test("bass under an unnamed chord region is unjudged, never counted as support", () => {
  const result = assessBassLine({
    notes: [note(36, 0, 1600), note(42, 1600, 1600)],
    bedChords: [chord(0, 0, 1600), { startMs: 1600, endMs: 3200, root: null, pitchClasses: [] }],
    fromMs: 0, toMs: 3200,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.equal(result.supportShare, 1, "only judged time is in the share");
  assert.ok(result.unjudgedMs > 0);
  assert.ok(result.relations.some((relation) => relation.kind === "unjudged"));
});

test("too little judged bass is unavailable rather than a confident claim", () => {
  const result = assessBassLine({
    notes: [note(36, 0, 400)],
    bedChords: [chord(0, 0, 400)],
    fromMs: 0, toMs: 400,
  });
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.ok(result.reason.includes(String(MIN_BASS_JUDGED_MS)));
});

test("no bed chords means the bass cannot be related to any harmony", () => {
  const result = assessBassLine({
    notes: [note(36, 0, 2000)], bedChords: [], fromMs: 0, toMs: 2000,
  });
  assert.equal(result.status, "unavailable");
});

test("attack-only evidence produces no bass assessment", () => {
  // The persisted bass analysis records onsets with no pitch. Nothing here may
  // be turned into a note.
  const notes = sustainBassNotes({
    frames: [
      { timestampMs: 0, nearestMidiNote: null, confidence: 0 },
      { timestampMs: 30, nearestMidiNote: null, confidence: 0 },
    ],
    minimumConfidence: 0.6,
  });
  assert.equal(notes.length, 0);
  assert.equal(assessBassLine({
    notes, bedChords: [chord(0, 0, 2000)], fromMs: 0, toMs: 2000,
  }).status, "unavailable");
});

test("low-confidence frames are dropped rather than bridged into a note", () => {
  const notes = sustainBassNotes({
    frames: [
      { timestampMs: 0, nearestMidiNote: 36, confidence: 0.9 },
      { timestampMs: 30, nearestMidiNote: 36, confidence: 0.9 },
      { timestampMs: 60, nearestMidiNote: 36, confidence: 0.2 },
      { timestampMs: 90, nearestMidiNote: 36, confidence: 0.2 },
    ],
    minimumConfidence: 0.6,
  });
  assert.equal(notes.length, 1);
  assert.ok(notes[0]!.endMs <= 90, "the low-confidence tail is not attached to the note");
});

test("adjacent frames of one pitch become a single sustained note", () => {
  const frames = Array.from({ length: 10 }, (_, index) => ({
    timestampMs: index * 30, nearestMidiNote: 36, confidence: 0.9,
  }));
  const notes = sustainBassNotes({ frames, minimumConfidence: 0.6 });
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.startMs, 0);
  assert.ok(notes[0]!.endMs > 240);
});

test("bass notes are mapped into the anchor timeline with the arrangement's own stretch", () => {
  const placed = placeBassNotes({
    notes: [note(36, 0, 1000)], sourceStartMs: 0, sourceEndMs: 2000,
    targetStartMs: 8000, stretchRatio: 1.5, pitchShiftSemitones: -2,
  });
  assert.equal(placed.length, 1);
  assert.equal(placed[0]!.midiNote, 34);
  assert.equal(placed[0]!.startMs, 8000);
  assert.equal(placed[0]!.endMs, 9500);
});

// --- the discriminating case this work exists for ---------------------------

test("two bass lines over the same harmony separate at the arrangement decision", () => {
  // The bed is C major throughout. One candidate's retained bass supports it;
  // the other sustains a foreign pitch that never resolves. Both are
  // structurally identical otherwise, so only the bass evidence separates them.
  const bedChords = [chord(0, 0, 4000)];
  const supporting: BassLineNote[] = [note(36, 0, 1000), note(43, 1000, 1000), note(40, 2000, 1000), note(36, 3000, 1000)];
  const contradicting: BassLineNote[] = [note(42, 0, 1000), note(45, 1000, 1000), note(44, 2000, 1000), note(42, 3000, 1000)];
  const good = assessBassLine({ notes: supporting, bedChords, fromMs: 0, toMs: 4000 });
  const bad = assessBassLine({ notes: contradicting, bedChords, fromMs: 0, toMs: 4000 });
  assert.equal(good.status, "measured");
  assert.equal(bad.status, "measured");
  if (good.status !== "measured" || bad.status !== "measured") return;
  assert.equal(bassContradictsHarmony(good).contradicts, false);
  assert.equal(bassContradictsHarmony(bad).contradicts, true);
  assert.ok(bad.contradictionShare > good.contradictionShare);
});

test("a walking line that changes pitch before the chord does is motion, not a pedal", () => {
  // C over C, then B (a step below) under the SAME C major chord, resolving to A
  // when the harmony moves to F. Nothing here is sustained, so the pedal branch
  // must not swallow it: B is a passing tone and A is the root of F.
  const result = assessBassLine({
    notes: [note(36, 0, 400), note(35, 400, 400), note(33, 800, 800)],
    bedChords: [chord(0, 0, 800), chord(5, 800, 1600)],
    fromMs: 0, toMs: 1600,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.equal(result.relations.filter((relation) => relation.kind === "pedal").length, 0,
    "a changing bass line is never a pedal");
});

test("a pedal is only recognised when the note is genuinely sustained", () => {
  // Same foreign pitch repeated with gaps: not sustained, so it is judged on
  // its own merits rather than excused as a pedal.
  const restruck = Array.from({ length: 8 }, (_, index) => note(42, index * 400, 300));
  const result = assessBassLine({
    notes: restruck,
    bedChords: [chord(0, 0, 1600), chord(7, 1600, 3200)],
    fromMs: 0, toMs: 3200,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.equal(result.relations.filter((relation) => relation.kind === "pedal").length, 0);
  assert.ok(result.contradictionShare > 0.9, "restruck foreign notes stay contradictions");
});

test("a foreign note held across a repeated chord is not excused as a pedal", () => {
  // Production writes one chord event per window, so the SAME harmony arrives as
  // several rows. A sustained F# over four C-major events has spanned no chord
  // change at all, and must stay a contradiction rather than become a pedal.
  const repeated = [0, 1, 2, 3].map((index) => chord(0, index * 1000, index * 1000 + 1000));
  const result = assessBassLine({
    notes: [note(42, 0, 4000)],
    bedChords: repeated,
    fromMs: 0, toMs: 4000,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.equal(result.relations.filter((relation) => relation.kind === "pedal").length, 0,
    "a repeated harmony is not a chord change");
  assert.ok(result.contradictionShare > 0.9);
  assert.equal(bassContradictsHarmony(result).contradicts, true);
});

test("a pedal is still recognised when the harmony genuinely changes", () => {
  // Same shape as the pedal test above, but the chord really moves.
  const result = assessBassLine({
    notes: [note(36, 0, 2400)],
    bedChords: [chord(0, 0, 800), chord(5, 800, 1600), chord(7, 1600, 2400)],
    fromMs: 0, toMs: 2400,
  });
  assert.equal(result.status, "measured");
  if (result.status !== "measured") return;
  assert.ok(result.relations.some((relation) => relation.kind === "pedal"));
});
