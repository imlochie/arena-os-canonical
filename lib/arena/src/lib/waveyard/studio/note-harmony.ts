import { vocalFramesToMidiNotes, type MidiNoteEvent } from "../types/midi";
import { HARMONY_TEMPLATE_MIN_MARGIN, harmonyPitchClasses, type HarmonyEvent } from "../types/harmony-analysis";
import type { VocalPitchFrame } from "../types/vocal-analysis";

const notesByFrames = new WeakMap<readonly VocalPitchFrame[], MidiNoteEvent[]>();

/** Reuse the MIDI converter, but do not merge adjacent semitones into one note. */
export function stableVocalNotes(frames: readonly VocalPitchFrame[]): MidiNoteEvent[] {
  let notes = notesByFrames.get(frames);
  if (!notes) {
    notes = [];
    let run: VocalPitchFrame[] = [];
    const finish = () => {
      notes!.push(...vocalFramesToMidiNotes(run, { minimumConfidence: 0.75, minimumDurationMs: 120, maximumPitchJump: 0 }));
      run = [];
    };
    for (const frame of [...frames].sort((a, b) => a.timestampMs - b.timestampMs)) {
      if (run.length && frame.timestampMs - run.at(-1)!.timestampMs > 100) finish();
      run.push(frame);
    }
    finish();
    notesByFrames.set(frames, notes);
  }
  return notes;
}

/**
 * Duration-weighted overlap with changing measured chords. This describes
 * chord-tone membership, not whether passing tones/tensions sound good.
 */
export function scoreStableNoteHarmony(input: {
  frames: readonly VocalPitchFrame[];
  chords: readonly HarmonyEvent[];
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
  stretchRatio: number;
  pitchShiftSemitones: number;
  voicedDurationMs: number;
}): { similarity: number; coverage: number; stableNoteCount: number; coveredDurationMs: number } | null {
  if (![input.sourceStartMs, input.sourceEndMs, input.targetStartMs, input.targetEndMs,
    input.stretchRatio, input.pitchShiftSemitones, input.voicedDurationMs].every(Number.isFinite)
    || input.sourceStartMs < 0 || input.sourceEndMs <= input.sourceStartMs
    || input.targetEndMs <= input.targetStartMs || input.stretchRatio <= 0
    || input.voicedDurationMs <= 0 || !Number.isInteger(input.pitchShiftSemitones)) return null;
  if (input.chords.some((chord, index) => !Number.isFinite(chord.startMs) || !Number.isFinite(chord.endMs)
    || chord.startMs < 0 || chord.endMs <= chord.startMs
    || index > 0 && chord.startMs < input.chords[index - 1]!.endMs)) return null;
  const notes = stableVocalNotes(input.frames);
  let stableDuration = 0, coveredDuration = 0, eligibleWeight = 0, chordWeight = 0, stableNoteCount = 0;
  for (const note of notes) {
    const from = Math.max(input.sourceStartMs, note.startMs);
    const to = Math.min(input.sourceEndMs, note.startMs + note.durationMs);
    if (to <= from) continue;
    const targetFrom = input.targetStartMs + (from - input.sourceStartMs) * input.stretchRatio;
    const targetTo = Math.min(input.targetEndMs, input.targetStartMs + (to - input.sourceStartMs) * input.stretchRatio);
    if (targetTo <= targetFrom) continue;
    stableNoteCount++;
    stableDuration += (targetTo - targetFrom) / input.stretchRatio;
    const pitchClass = ((note.midiNote + input.pitchShiftSemitones) % 12 + 12) % 12;
    let low = 0, high = input.chords.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (input.chords[mid]!.endMs <= targetFrom) low = mid + 1; else high = mid;
    }
    for (let index = low; index < input.chords.length && input.chords[index]!.startMs < targetTo; index++) {
      const chord = input.chords[index]!;
      const span = Math.min(targetTo, chord.endMs) - Math.max(targetFrom, chord.startMs);
      const pitchClasses = chord.confidence >= HARMONY_TEMPLATE_MIN_MARGIN && chord.confidence <= 1
        ? harmonyPitchClasses(chord) : null;
      if (span <= 0 || !pitchClasses) continue;
      const sourceSpan = span / input.stretchRatio;
      const weight = sourceSpan * note.velocity / 127;
      coveredDuration += sourceSpan;
      eligibleWeight += weight;
      if (pitchClasses.includes(pitchClass)) chordWeight += weight;
    }
  }
  // Do not let a single stable fragment stand in for an otherwise noisy phrase.
  if (stableNoteCount < 2 || stableDuration < input.voicedDurationMs * 0.5
    || coveredDuration < stableDuration * 0.5 || eligibleWeight <= 0) return null;
  return { similarity: chordWeight / eligibleWeight, coverage: Math.min(1, coveredDuration / input.voicedDurationMs),
    stableNoteCount, coveredDurationMs: coveredDuration };
}
