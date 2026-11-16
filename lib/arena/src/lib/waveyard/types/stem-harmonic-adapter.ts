/**
 * Bridges persisted harmony/vocal evidence into the stem-aware harmonic
 * assessment. Kept separate from the assessment itself so the musical model can
 * be tested without database shapes, and so the conversion stays auditable.
 */
import { CANONICAL_PITCH_CLASSES } from "./musical-key";
import { harmonyPitchClasses, type HarmonyEvent } from "./harmony-analysis";
import { stableVocalNotes } from "../studio/note-harmony";
import type { VocalPitchFrame } from "./vocal-analysis";
import type { StemHarmonyChord, StemHarmonyNote } from "./stem-harmonic-fit";

function rootPitchClass(event: HarmonyEvent): number | null {
  if (!event.root) return null;
  const index = CANONICAL_PITCH_CLASSES.indexOf(
    event.root as (typeof CANONICAL_PITCH_CLASSES)[number],
  );
  return index >= 0 ? index : null;
}

/**
 * A bed chord is usable only when the analyser both named it and crossed its
 * own margin. An `unknown` chord is not "no chord there"; it is material the
 * pipeline declined to name, and must not be treated as agreement.
 */
export function bedChordsFromHarmonyEvents(events: readonly HarmonyEvent[]): StemHarmonyChord[] {
  const chords: StemHarmonyChord[] = [];
  for (const event of events) {
    if (!Number.isFinite(event.startMs) || !Number.isFinite(event.endMs)) continue;
    if (event.endMs <= event.startMs) continue;
    const named = event.quality !== "unknown" && rootPitchClass(event) !== null;
    const pitchClasses = named ? harmonyPitchClasses(event) ?? [] : [];
    chords.push({
      startMs: event.startMs,
      endMs: event.endMs,
      root: named ? rootPitchClass(event) : null,
      pitchClasses,
    });
  }
  return chords.sort((left, right) => left.startMs - right.startMs);
}

/**
 * Map donor vocal notes into the anchor bed's timeline.
 *
 * `targetStartMs + (noteStart - sourceStartMs) * stretchRatio` is the same
 * mapping the renderer uses, so the assessment judges the arrangement the
 * listener will actually hear rather than the donor's original alignment.
 */
export function placedVocalNotes(input: {
  vocalFrames: readonly VocalPitchFrame[] | undefined;
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  stretchRatio: number;
  pitchShiftSemitones: number;
}): StemHarmonyNote[] | null {
  const { vocalFrames, sourceStartMs, sourceEndMs, targetStartMs, stretchRatio, pitchShiftSemitones } = input;
  if (!vocalFrames?.length) return null;
  if (!Number.isFinite(sourceStartMs) || !Number.isFinite(sourceEndMs) || sourceEndMs <= sourceStartMs) return null;
  if (!Number.isFinite(targetStartMs) || !Number.isFinite(stretchRatio) || stretchRatio <= 0) return null;
  if (!Number.isInteger(pitchShiftSemitones)) return null;
  const notes = stableVocalNotes(vocalFrames)
    .filter((note) => note.startMs < sourceEndMs && note.startMs + note.durationMs > sourceStartMs)
    .map((note) => {
      const from = Math.max(note.startMs, sourceStartMs);
      const to = Math.min(note.startMs + note.durationMs, sourceEndMs);
      return {
        startMs: Math.round(targetStartMs + (from - sourceStartMs) * stretchRatio),
        endMs: Math.round(targetStartMs + (to - sourceStartMs) * stretchRatio),
        midiNote: note.midiNote + pitchShiftSemitones,
        velocity: note.velocity,
      };
    })
    .filter((note) => note.endMs > note.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.midiNote - right.midiNote);
  return notes.length ? notes : null;
}
