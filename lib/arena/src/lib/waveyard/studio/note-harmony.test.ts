import assert from "node:assert/strict";
import test from "node:test";
import { stableVocalNotes, scoreStableNoteHarmony } from "./note-harmony";
import { scoreVocalChordToneFit } from "./mashup";
import type { VocalPitchFrame } from "../types/vocal-analysis";
import type { HarmonyEvent } from "../types/harmony-analysis";
import { HARMONY_CHORD_TEMPLATES, HARMONY_TEMPLATE_MIN_MARGIN, matchHarmonyChroma, LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION } from "../types/harmony-analysis";
import { LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION } from "../types/stem-harmony-analysis";

function frames(notes: number[]): VocalPitchFrame[] {
  return notes.map((note, index) => ({
    timestampMs: index * 30, frequencyHz: 440 * 2 ** ((note - 69) / 12),
    midiFloat: note, nearestMidiNote: note, confidence: 0.95, voiced: true,
  }));
}
const pitches = frames([...Array(30).fill(64), ...Array(10).fill(67)]);
const chords: HarmonyEvent[] = [
  { startMs: 0, endMs: 700, root: "C", quality: "major", confidence: 0.1 },
  { startMs: 700, endMs: 1200, root: "G", quality: "major", confidence: 0.1 },
];
const input = { frames: pitches, chords, sourceStartMs: 0, sourceEndMs: 1200,
  targetStartMs: 0, targetEndMs: 1200, stretchRatio: 1, pitchShiftSemitones: 0, voicedDurationMs: 1200 };

test("chord templates penalise absent added tones instead of tying every triad to supersets", () => {
  for (const template of HARMONY_CHORD_TEMPLATES) {
    for (let root = 0; root < 12; root++) {
      const chroma = Array.from({ length: 12 }, (_, pitch) =>
        template.intervals.includes((pitch - root + 12) % 12) ? 1 : 0);
      const match = matchHarmonyChroma(chroma);
      if (template.quality === "augmented") {
        assert.equal(match.quality, "unknown", "symmetric augmented triads do not establish one root");
      } else {
        assert.equal(match.root, root, template.quality);
        assert.equal(match.quality, template.quality);
        assert.ok(match.confidence >= HARMONY_TEMPLATE_MIN_MARGIN);
      }
      assert.deepEqual(matchHarmonyChroma(chroma.map((value) => value * 1e100)), match,
        "amplitude scaling must not manufacture stronger evidence");
    }
  }
  assert.equal(matchHarmonyChroma(Array(12).fill(1)).quality, "unknown");
  assert.equal(matchHarmonyChroma(Array(12).fill(0)).confidence, 0);
  assert.equal(matchHarmonyChroma([Number.NaN, ...Array(11).fill(0)]).quality, "unknown");
  assert.notEqual(LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION, "1.0.0", "old local chord results must be stale");
  assert.equal(LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION, LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION);
});

test("stable estimated notes retain semitone changes and never bridge missing pitch evidence", () => {
  const semitones = frames([...Array(6).fill(60), ...Array(6).fill(61), ...Array(6).fill(62)]);
  assert.deepEqual(stableVocalNotes(semitones).map((note) => note.midiNote), [60, 61, 62]);
  const sparse = frames(Array(5).fill(60));
  sparse.push(...frames(Array(5).fill(60)).map((frame) => ({ ...frame, timestampMs: frame.timestampMs + 1000 })));
  assert.equal(stableVocalNotes(sparse).length, 2);
  assert.ok(stableVocalNotes(sparse).every((note) => note.durationMs === 150));
});

test("sustained note durations are split against the actual chord progression", () => {
  const result = scoreStableNoteHarmony(input);
  assert.ok(result);
  assert.equal(result.stableNoteCount, 2);
  assert.equal(result.coveredDurationMs, 1200);
  assert.ok(Math.abs(result.similarity - 1000 / 1200) < 1e-9,
    "E sustains through 200ms of the G chord; do not assign the whole note to its starting chord");
  const transformed = scoreStableNoteHarmony({ ...input,
    targetStartMs: 500, targetEndMs: 2300, stretchRatio: 1.5, pitchShiftSemitones: 2,
    chords: chords.map((chord) => ({ ...chord, startMs: 500 + chord.startMs * 1.5,
      endMs: 500 + chord.endMs * 1.5, root: chord.root === "C" ? "D" : "A" })),
  });
  assert.ok(transformed);
  assert.ok(Math.abs(transformed.similarity - result.similarity) < 1e-9);
});

test("weak, fragmented, partial or malformed harmonic evidence cannot manufacture a stable-note score", () => {
  assert.equal(scoreStableNoteHarmony({ ...input, chords: chords.map((chord) => ({ ...chord, quality: "unknown" })) }), null);
  assert.equal(scoreStableNoteHarmony({ ...input, chords: [{ ...chords[0]!, endMs: 100 }] }), null);
  assert.equal(scoreStableNoteHarmony({ ...input, chords: [...chords].reverse() }), null);
  assert.equal(scoreStableNoteHarmony({ ...input, frames: frames(Array.from({ length: 40 }, (_, index) => 60 + index % 3)) }), null);
  assert.equal(scoreStableNoteHarmony({ ...input, frames: pitches.map((frame) => ({ ...frame, confidence: 0.4 })) }), null);
});

test("production passage and arrangement scoring uses note duration and retains the frame fallback", () => {
  const fit = scoreVocalChordToneFit({ vocalFrames: pitches, bedChords: chords,
    donorStartMs: 0, donorEndMs: 1200, bedStartMs: 0, bedEndMs: 1200, stretchRatio: 1, pitchShiftSemitones: 0 });
  assert.equal(fit?.basis, "stable-note-duration");
  assert.ok(Math.abs(fit!.similarity - 1000 / 1200) < 1e-9);
  const fallback = scoreVocalChordToneFit({
    vocalFrames: frames(Array.from({ length: 40 }, (_, index) => [60, 64, 67][index % 3]!)),
    bedChords: [{ ...chords[0]!, endMs: 1200 }],
    donorStartMs: 0, donorEndMs: 1200, bedStartMs: 0, bedEndMs: 1200, stretchRatio: 1, pitchShiftSemitones: 0,
  });
  assert.equal(fallback?.basis, "pitch-frames");
  assert.equal(fallback.similarity, 1);
});
