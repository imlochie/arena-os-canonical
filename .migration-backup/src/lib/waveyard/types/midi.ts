import { normaliseMusicalKey } from "./musical-key";
import type { DrumEvent } from "./drum-analysis";
import type { HarmonyEvent } from "./harmony-analysis";
import type { VocalPitchFrame } from "./vocal-analysis";

/** Fixed SMF resolution. Milliseconds remain Waveyard's authoritative timing. */
export const MIDI_PPQ = 480;
export const MIDI_CONVERSION_VERSION = "1.0.0";
export type MidiExportKind = "vocal" | "drums" | "harmony";
export type MidiNoteEvent = {
  startMs: number;
  durationMs: number;
  midiNote: number;
  velocity: number;
  channel: number;
};

export function normaliseMidiNoteEvents(input: unknown): MidiNoteEvent[] | null {
  if (!Array.isArray(input) || input.length > 100_000) return null;
  const notes: MidiNoteEvent[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const note = raw as Partial<MidiNoteEvent>;
    const startMs = note.startMs; const durationMs = note.durationMs; const midiNote = note.midiNote; const velocity = note.velocity; const channel = note.channel;
    if (typeof startMs !== "number" || typeof durationMs !== "number" || typeof midiNote !== "number" || typeof velocity !== "number" || typeof channel !== "number"
      || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(durationMs) || !Number.isInteger(midiNote) || !Number.isInteger(velocity) || !Number.isInteger(channel)
      || startMs < 0 || durationMs < 1 || midiNote < 0 || midiNote > 127 || velocity < 1 || velocity > 127 || channel < 0 || channel > 15) return null;
    notes.push({ startMs, durationMs, midiNote, velocity, channel });
  }
  notes.sort((left, right) => left.startMs - right.startMs || left.channel - right.channel || left.midiNote - right.midiNote || left.durationMs - right.durationMs);
  return notes;
}

export function millisecondsToMidiTicks(milliseconds: number, bpm: number, ppq = MIDI_PPQ) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || !Number.isFinite(bpm) || bpm < 20 || bpm > 300 || !Number.isSafeInteger(ppq) || ppq < 24 || ppq > 9_600) return null;
  return Math.round(milliseconds * bpm * ppq / 60_000);
}

export function quantizeMillisecondsToBeatGrid(milliseconds: number, beatGridMs: readonly number[] | null | undefined) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || !Array.isArray(beatGridMs) || !beatGridMs.length || beatGridMs.some((beat) => !Number.isSafeInteger(beat) || beat < 0)) return null;
  return beatGridMs.reduce((nearest, beat) => Math.abs(beat - milliseconds) < Math.abs(nearest - milliseconds) ? beat : nearest, beatGridMs[0]);
}

const drumNotes: Record<string, number> = { kick: 36, snare: 38, hat: 42 };
export function drumEventsToMidiNotes(events: readonly DrumEvent[], minimumConfidence = 0.6): MidiNoteEvent[] {
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) return [];
  return normaliseMidiNoteEvents(events.flatMap((event) => {
    const midiNote = event.rhythmicClass ? drumNotes[event.rhythmicClass] : undefined;
    if (midiNote === undefined || event.confidence < minimumConfidence) return [];
    return [{ startMs: event.timestampMs, durationMs: 60, midiNote, velocity: Math.max(1, Math.min(127, Math.round(event.strength * 127))), channel: 9 }];
  })) ?? [];
}

/** Segment only confident, stable voiced regions; detected pitch is never corrected. */
export function vocalFramesToMidiNotes(frames: readonly VocalPitchFrame[], options: { minimumDurationMs?: number; minimumConfidence?: number; maximumPitchJump?: number } = {}): MidiNoteEvent[] {
  const minimumDurationMs = options.minimumDurationMs ?? 120;
  const minimumConfidence = options.minimumConfidence ?? 0.6;
  const maximumPitchJump = options.maximumPitchJump ?? 1;
  if (!Number.isSafeInteger(minimumDurationMs) || minimumDurationMs < 1 || !Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1 || !Number.isSafeInteger(maximumPitchJump) || maximumPitchJump < 0) return [];
  const ordered = [...frames].sort((left, right) => left.timestampMs - right.timestampMs);
  const notes: MidiNoteEvent[] = [];
  let segment: VocalPitchFrame[] = [];
  const finish = () => {
    if (!segment.length) return;
    const startMs = segment[0].timestampMs;
    const frameStep = segment.length > 1 ? Math.max(1, Math.round((segment.at(-1)!.timestampMs - startMs) / (segment.length - 1))) : 46;
    const durationMs = segment.at(-1)!.timestampMs + frameStep - startMs;
    const confidence = segment.reduce((total, frame) => total + frame.confidence, 0) / segment.length;
    const pitches = segment.map((frame) => frame.nearestMidiNote!).sort((left, right) => left - right);
    const midiNote = pitches[Math.floor(pitches.length / 2)];
    if (durationMs >= minimumDurationMs && confidence >= minimumConfidence)
      notes.push({ startMs, durationMs, midiNote, velocity: Math.max(1, Math.min(127, Math.round(confidence * 127))), channel: 0 });
    segment = [];
  };
  for (const frame of ordered) {
    const usable = frame.voiced && frame.nearestMidiNote !== null && frame.confidence >= minimumConfidence;
    const prior = segment.at(-1);
    if (!usable || (prior && (frame.timestampMs - prior.timestampMs > 260 || Math.abs(frame.nearestMidiNote! - prior.nearestMidiNote!) > maximumPitchJump))) finish();
    if (usable) segment.push(frame);
  }
  finish();
  return normaliseMidiNoteEvents(notes) ?? [];
}

const chordIntervals: Record<Exclude<HarmonyEvent["quality"], "unknown">, number[]> = {
  major: [0, 4, 7], minor: [0, 3, 7], dominant7: [0, 4, 7, 10], minor7: [0, 3, 7, 10], major7: [0, 4, 7, 11], diminished: [0, 3, 6], augmented: [0, 4, 8],
};
export function harmonyEventsToMidiNotes(events: readonly HarmonyEvent[], minimumConfidence = 0.6): MidiNoteEvent[] {
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) return [];
  const notes = events.flatMap((event) => {
    if (!event.root || event.quality === "unknown" || event.confidence < minimumConfidence) return [];
    const key = normaliseMusicalKey(`${event.root} major`);
    const root = key ? ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].indexOf(key.replace(" major", "")) : -1;
    if (root < 0) return [];
    const velocity = Math.max(1, Math.min(127, Math.round(event.confidence * 127)));
    return chordIntervals[event.quality].map((interval) => ({ startMs: event.startMs, durationMs: event.endMs - event.startMs, midiNote: 48 + root + interval, velocity, channel: 1 }));
  });
  return normaliseMidiNoteEvents(notes) ?? [];
}
