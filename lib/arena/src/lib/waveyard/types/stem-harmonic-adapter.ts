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
import type { BassLineNote } from "./bass-harmony-fit";

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

/**
 * Turn tracked bass pitch frames into sustained notes.
 *
 * A separated bass stem is monophonic in practice, so frames of the same pitch
 * that are adjacent in time are one note. Frames below the confidence floor are
 * dropped rather than bridged: an unattributed gap must stay a gap, because the
 * bass assessment judges what it can see and reports the rest as unjudged.
 */
export function sustainBassNotes(input: {
  frames: ReadonlyArray<{ timestampMs: number; nearestMidiNote: number | null; confidence: number }>;
  /** Confidence floor; below this a frame is not a reliable pitch. */
  minimumConfidence: number;
  /** Maximum gap between frames that still belongs to one note. */
  maximumGapMs?: number;
  /** Frame hop, used to extend the final note of a run. */
  frameStepMs?: number;
}): BassLineNote[] {
  const { frames, minimumConfidence } = input;
  const maximumGapMs = input.maximumGapMs ?? 120;
  const frameStepMs = input.frameStepMs ?? 30;
  if (!frames.length || !Number.isFinite(minimumConfidence)) return [];
  const ordered = [...frames]
    .filter((frame) => frame.nearestMidiNote !== null
      && Number.isFinite(frame.confidence)
      && frame.confidence >= minimumConfidence)
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const notes: BassLineNote[] = [];
  let run: { midiNote: number; startMs: number; lastMs: number; confidenceSum: number; count: number } | null = null;
  const finish = () => {
    if (!run) return;
    notes.push({
      startMs: run.startMs,
      endMs: run.lastMs + frameStepMs,
      midiNote: run.midiNote,
      confidence: run.count > 0 ? run.confidenceSum / run.count : 0,
    });
    run = null;
  };
  for (const frame of ordered) {
    const midiNote = frame.nearestMidiNote!;
    if (run && run.midiNote === midiNote && frame.timestampMs - run.lastMs <= maximumGapMs) {
      run.lastMs = frame.timestampMs;
      run.confidenceSum += frame.confidence;
      run.count += 1;
      continue;
    }
    finish();
    run = { midiNote, startMs: frame.timestampMs, lastMs: frame.timestampMs, confidenceSum: frame.confidence, count: 1 };
  }
  finish();
  return notes;
}

/**
 * Place bass notes onto the anchor timeline. `targetStartMs` anchors the
 * section; the stretch ratio matches the arrangement's own tempo handling.
 */
export function placeBassNotes(input: {
  notes: readonly BassLineNote[];
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  stretchRatio: number;
  pitchShiftSemitones: number;
}): BassLineNote[] {
  const { notes, sourceStartMs, sourceEndMs, targetStartMs, stretchRatio, pitchShiftSemitones } = input;
  if (!Number.isFinite(stretchRatio) || stretchRatio <= 0 || !Number.isInteger(pitchShiftSemitones)) return [];
  return notes
    .filter((note) => note.startMs < sourceEndMs && note.endMs > sourceStartMs)
    .map((note) => {
      const from = Math.max(note.startMs, sourceStartMs);
      const to = Math.min(note.endMs, sourceEndMs);
      return {
        startMs: Math.round(targetStartMs + (from - sourceStartMs) * stretchRatio),
        endMs: Math.round(targetStartMs + (to - sourceStartMs) * stretchRatio),
        midiNote: note.midiNote + pitchShiftSemitones,
        confidence: note.confidence,
      };
    })
    .filter((note) => note.endMs > note.startMs)
    .sort((left, right) => left.startMs - right.startMs);
}
