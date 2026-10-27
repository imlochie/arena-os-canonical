/**
 * Piano roll domain model — the pure, render-free core of the native MIDI
 * editor (vision §V4). Everything here is a pure function over immutable
 * note arrays: the React editor is a thin skin, and every behavior
 * (snap, drag, resize, quantize, transpose, duplicate) is unit-tested
 * without a DOM.
 *
 * Conventions (deliberate):
 *  - Velocity is stored in the SMF domain (integers 1–127) — the piano roll
 *    is the interchange surface; `toSynthEvents` converts for the renderer.
 *  - Milliseconds remain Waveyard's authoritative timing (types/midi.ts),
 *    snapped against a beat grid derived from the project's real BPM.
 *  - Notes carry stable string ids for React keys and selection sets.
 */

// (No node: imports here — this module is loaded by the browser editor too.)

export type PianoNote = {
  id: string;
  startMs: number;
  durationMs: number;
  midi: number;
  /** 1–127, the SMF domain. */
  velocity: number;
};

export const MIDI_LOW = 0;
export const MIDI_HIGH = 127;
export const MIN_NOTE_MS = 10;
export const VELOCITY_MIN = 1;
export const VELOCITY_MAX = 127;

let idCounter = 0;

/** Browser- and Node-safe unique id (Web Crypto when present, counter
 *  otherwise — ids only need uniqueness within one editing session). */
export function newNoteId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  idCounter += 1;
  return `note-${Date.now().toString(36)}-${idCounter}`;
}

export function clampMidi(midi: number): number {
  return Math.max(MIDI_LOW, Math.min(MIDI_HIGH, Math.round(midi)));
}

export function clampVelocity(velocity: number): number {
  return Math.max(VELOCITY_MIN, Math.min(VELOCITY_MAX, Math.round(velocity)));
}

// ---------------------------------------------------------------- grid + snap

export type SnapSetting = "bar" | "beat" | "1/2" | "1/4" | "1/8" | "1/16" | "off";

export const SNAP_SETTINGS: readonly SnapSetting[] = ["bar", "beat", "1/2", "1/4", "1/8", "1/16", "off"];

/** Snap step in ms for a subdivision at the given tempo. Null = off. */
export function snapStepMs(setting: SnapSetting, bpm: number, beatsPerBar = 4): number | null {
  if (setting === "off") return null;
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300 || !Number.isSafeInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 16) return null;
  const beatMs = 60_000 / bpm;
  switch (setting) {
    case "bar":
      return beatMs * beatsPerBar;
    case "beat":
      return beatMs;
    case "1/2":
      return beatMs / 2;
    case "1/4":
      return beatMs / 4;
    case "1/8":
      return beatMs / 8;
    case "1/16":
      return beatMs / 16;
  }
}

export function snapMs(milliseconds: number, stepMs: number | null): number {
  if (stepMs === null || stepMs <= 0) return Math.max(0, Math.round(milliseconds));
  return Math.max(0, Math.round(Math.round(milliseconds / stepMs) * stepMs));
}

/** Note names with octave (C4 = MIDI 60, the convention FL Studio follows). */
export function midiToNoteName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const clamped = clampMidi(midi);
  return `${names[clamped % 12]}${Math.floor(clamped / 12) - 1}`;
}

/** True for the black keys — the grid draws them shaded. */
export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

// ------------------------------------------------------------------ geometry

export type PianoRollGeometry = {
  pixelsPerSecond: number;
  rowHeight: number;
  /** Lowest visible MIDI row (bottom of the grid). */
  midiLow: number;
  /** Highest visible MIDI row (top of the grid). */
  midiHigh: number;
};

export function msToX(milliseconds: number, geometry: PianoRollGeometry): number {
  return (milliseconds / 1000) * geometry.pixelsPerSecond;
}

export function xToMs(x: number, geometry: PianoRollGeometry): number {
  return Math.max(0, (x / geometry.pixelsPerSecond) * 1000);
}

export function midiToY(midi: number, geometry: PianoRollGeometry): number {
  return (geometry.midiHigh - midi) * geometry.rowHeight;
}

export function yToMidi(y: number, geometry: PianoRollGeometry): number {
  return clampMidi(geometry.midiHigh - Math.floor(y / geometry.rowHeight));
}

/** Grid height in px for the current pitch span. */
export function gridHeight(geometry: PianoRollGeometry): number {
  return (geometry.midiHigh - geometry.midiLow + 1) * geometry.rowHeight;
}

/** Pitch window that shows every note with `paddingRows` of headroom. */
export function fitPitchRange(notes: readonly PianoNote[], paddingRows = 4): { midiLow: number; midiHigh: number } {
  if (!notes.length) return { midiLow: 48, midiHigh: 72 };
  let low = MIDI_HIGH;
  let high = MIDI_LOW;
  for (const note of notes) {
    if (note.midi < low) low = note.midi;
    if (note.midi > high) high = note.midi;
  }
  return {
    midiLow: Math.max(MIDI_LOW, low - paddingRows),
    midiHigh: Math.min(MIDI_HIGH, high + paddingRows),
  };
}

// ------------------------------------------------------------------ hit tests

export const RESIZE_ZONE_PX = 8;

export type NoteHit =
  | { kind: "resize"; noteId: string }
  | { kind: "body"; noteId: string }
  | null;

/** Hit test at grid coordinates. The right edge of a note is the resize
 *  handle; everything else is a move grip. Topmost (later) notes win. */
export function hitTest(
  notes: readonly PianoNote[],
  position: { ms: number; y: number },
  geometry: PianoRollGeometry,
): NoteHit {
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const note = notes[index];
    const startX = msToX(note.startMs, geometry);
    const endX = msToX(note.startMs + note.durationMs, geometry);
    const topY = midiToY(note.midi, geometry);
    const x = msToX(position.ms, geometry);
    if (x < startX || x > endX || position.y < topY || position.y >= topY + geometry.rowHeight) continue;
    if (endX - x <= RESIZE_ZONE_PX) return { kind: "resize", noteId: note.id };
    return { kind: "body", noteId: note.id };
  }
  return null;
}

// -------------------------------------------------------------- note editing

/** Strict validation for editor input (API payloads and imports). Returns
 *  normalised, sorted notes or null — never partially-trusted data. */
export function validatePianoNotes(input: unknown): PianoNote[] | null {
  if (!Array.isArray(input) || input.length > 100_000) return null;
  const notes: PianoNote[] = [];
  for (const raw of input) {
    if (raw === null || typeof raw !== "object") return null;
    const note = raw as Partial<PianoNote>;
    if (
      typeof note.id !== "string" || note.id.length < 1 || note.id.length > 64 ||
      typeof note.startMs !== "number" || typeof note.durationMs !== "number" ||
      typeof note.midi !== "number" || typeof note.velocity !== "number"
    ) {
      return null;
    }
    if (
      !Number.isSafeInteger(note.startMs) || !Number.isSafeInteger(note.durationMs) ||
      note.startMs < 0 || note.durationMs < MIN_NOTE_MS ||
      !Number.isInteger(note.midi) || note.midi < MIDI_LOW || note.midi > MIDI_HIGH ||
      !Number.isInteger(note.velocity) || note.velocity < VELOCITY_MIN || note.velocity > VELOCITY_MAX
    ) {
      return null;
    }
    notes.push({ id: note.id, startMs: note.startMs, durationMs: note.durationMs, midi: note.midi, velocity: note.velocity });
  }
  notes.sort((left, right) => left.startMs - right.startMs || left.midi - right.midi);
  return notes;
}

export function addNote(
  notes: readonly PianoNote[],
  draft: { startMs: number; durationMs: number; midi: number; velocity?: number },
  stepMs: number | null,
): PianoNote[] {
  const startMs = snapMs(draft.startMs, stepMs);
  const durationMs = Math.max(MIN_NOTE_MS, Math.round(draft.durationMs));
  const note: PianoNote = {
    id: newNoteId(),
    startMs,
    durationMs,
    midi: clampMidi(draft.midi),
    velocity: clampVelocity(draft.velocity ?? 100),
  };
  return [...notes, note];
}

export function deleteNotes(notes: readonly PianoNote[], ids: ReadonlySet<string>): PianoNote[] {
  return notes.filter((note) => !ids.has(note.id));
}

/**
 * Move the selected notes by (deltaMs, deltaSemitones). The edit snaps the
 * PRIMARY note (first selected) and applies the resulting rounded delta to
 * the rest, so relative positions survive and the grid still feels magnetic.
 * Bounds: nothing moves below 0 ms or outside 0–127; notes clamp as a block.
 */
export function moveNotes(
  notes: readonly PianoNote[],
  ids: ReadonlySet<string>,
  deltaMs: number,
  deltaSemitones: number,
  stepMs: number | null,
): PianoNote[] {
  if (ids.size === 0 || (deltaMs === 0 && deltaSemitones === 0)) return [...notes];
  const selected = notes.filter((note) => ids.has(note.id));
  if (!selected.length) return [...notes];
  const minStart = Math.min(...selected.map((note) => note.startMs));
  const minMidi = Math.min(...selected.map((note) => note.midi));
  const maxMidi = Math.max(...selected.map((note) => note.midi));

  let appliedMs = Math.round(deltaMs);
  let appliedSemitones = Math.round(deltaSemitones);
  if (stepMs !== null && stepMs > 0 && appliedMs !== 0) {
    const primaryTarget = snapMs(minStart + appliedMs, stepMs);
    appliedMs = primaryTarget - minStart;
  }
  // Block clamping: keep the selection intact at the timeline/pitch edges.
  if (minStart + appliedMs < 0) appliedMs = -minStart;
  if (minMidi + appliedSemitones < MIDI_LOW || maxMidi + appliedSemitones > MIDI_HIGH) {
    appliedSemitones = Math.max(MIDI_LOW - minMidi, Math.min(MIDI_HIGH - maxMidi, appliedSemitones));
  }

  return notes.map((note) =>
    ids.has(note.id)
      ? { ...note, startMs: note.startMs + appliedMs, midi: clampMidi(note.midi + appliedSemitones) }
      : note,
  );
}

/** Resize one note by dragging its end. Start stays fixed; the end snaps. */
export function resizeNote(
  notes: readonly PianoNote[],
  noteId: string,
  endMs: number,
  stepMs: number | null,
): PianoNote[] {
  return notes.map((note) => {
    if (note.id !== noteId) return note;
    const snappedEnd = snapMs(endMs, stepMs);
    const durationMs = Math.max(MIN_NOTE_MS, snappedEnd - note.startMs);
    return { ...note, durationMs };
  });
}

export function setVelocity(notes: readonly PianoNote[], ids: ReadonlySet<string>, velocity: number): PianoNote[] {
  const next = clampVelocity(velocity);
  return notes.map((note) => (ids.has(note.id) ? { ...note, velocity: next } : note));
}

export function transposeNotes(notes: readonly PianoNote[], ids: ReadonlySet<string>, semitones: number): PianoNote[] {
  if (!Number.isSafeInteger(semitones) || semitones === 0) return [...notes];
  return notes.map((note) => {
    if (!ids.has(note.id)) return note;
    const midi = note.midi + semitones;
    if (midi < MIDI_LOW || midi > MIDI_HIGH) return note; // out-of-range notes stay put
    return { ...note, midi };
  });
}

export function quantizeNotes(notes: readonly PianoNote[], ids: ReadonlySet<string>, stepMs: number): PianoNote[] {
  if (!Number.isFinite(stepMs) || stepMs <= 0) return [...notes];
  return notes.map((note) => (ids.has(note.id) ? { ...note, startMs: snapMs(note.startMs, stepMs) } : note));
}

/** Duplicate the selection, shifted by the selection's own time span (or
 *  one step when the span is zero) — the "repeat this figure" gesture. */
export function duplicateNotes(
  notes: readonly PianoNote[],
  ids: ReadonlySet<string>,
  stepMs: number | null,
): { notes: PianoNote[]; newIds: string[] } {
  const selected = notes.filter((note) => ids.has(note.id));
  if (!selected.length) return { notes: [...notes], newIds: [] };
  const minStart = Math.min(...selected.map((note) => note.startMs));
  const maxEnd = Math.max(...selected.map((note) => note.startMs + note.durationMs));
  let shift = maxEnd - minStart;
  if (shift <= 0) shift = stepMs ?? 500;
  const newIds: string[] = [];
  const copies = selected.map((note) => {
    const id = newNoteId();
    newIds.push(id);
    return { ...note, id, startMs: note.startMs + shift };
  });
  return { notes: [...notes, ...copies], newIds };
}

/** Merge same-pitch overlaps (imports and sloppy edits) into spanning notes. */
export function normalizeOverlaps(notes: readonly PianoNote[]): PianoNote[] {
  const byPitch = new Map<number, PianoNote[]>();
  for (const note of notes) {
    const bucket = byPitch.get(note.midi) ?? [];
    bucket.push(note);
    byPitch.set(note.midi, bucket);
  }
  const result: PianoNote[] = [];
  for (const bucket of byPitch.values()) {
    const ordered = [...bucket].sort((left, right) => left.startMs - right.startMs);
    let current = ordered[0];
    for (let index = 1; index < ordered.length; index += 1) {
      const next = ordered[index];
      const currentEnd = current.startMs + current.durationMs;
      if (next.startMs <= currentEnd) {
        const end = Math.max(currentEnd, next.startMs + next.durationMs);
        current = { ...current, durationMs: end - current.startMs, velocity: Math.max(current.velocity, next.velocity) };
      } else {
        result.push(current);
        current = next;
      }
    }
    result.push(current);
  }
  return result.sort((left, right) => left.startMs - right.startMs || left.midi - right.midi);
}

export function selectionBounds(notes: readonly PianoNote[], ids: ReadonlySet<string>): { startMs: number; endMs: number; midiLow: number; midiHigh: number } | null {
  const selected = notes.filter((note) => ids.has(note.id));
  if (!selected.length) return null;
  return {
    startMs: Math.min(...selected.map((note) => note.startMs)),
    endMs: Math.max(...selected.map((note) => note.startMs + note.durationMs)),
    midiLow: Math.min(...selected.map((note) => note.midi)),
    midiHigh: Math.max(...selected.map((note) => note.midi)),
  };
}

// ------------------------------------------------------- renderer interchange

export type SynthNoteEvent = { startMs: number; durationMs: number; midi: number; velocity: number };

/** Piano roll → synth renderer (velocity 1–127 → 0–1). */
export function toSynthEvents(notes: readonly PianoNote[]): SynthNoteEvent[] {
  return notes.map((note) => ({
    startMs: note.startMs,
    durationMs: note.durationMs,
    midi: note.midi,
    velocity: note.velocity / VELOCITY_MAX,
  }));
}

/** Synth/renderer events → piano roll (velocity 0–1 → 1–127, ids assigned). */
export function fromSynthEvents(events: readonly SynthNoteEvent[]): PianoNote[] {
  return events.map((event) => ({
    id: newNoteId(),
    startMs: Math.max(0, Math.round(event.startMs)),
    durationMs: Math.max(MIN_NOTE_MS, Math.round(event.durationMs)),
    midi: clampMidi(event.midi),
    velocity: clampVelocity(Math.round(event.velocity * VELOCITY_MAX)),
  }));
}

/** Piano roll → SMF interchange events (channel 0 — the roll is one track). */
export function toMidiNoteEvents(notes: readonly PianoNote[], channel = 0): Array<{ startMs: number; durationMs: number; midiNote: number; velocity: number; channel: number }> {
  return notes.map((note) => ({
    startMs: note.startMs,
    durationMs: note.durationMs,
    midiNote: note.midi,
    velocity: note.velocity,
    channel,
  }));
}
