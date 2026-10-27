/**
 * Standard MIDI File (format 0) writer — serialises MidiNoteEvents into a
 * downloadable .mid byte stream.
 *
 * Clean-room implementation against the published SMF specification (MThd
 * header chunk, MTrk track chunk, variable-length delta times, tempo meta
 * event, note on/off, end-of-track). The feature parity target is
 * SoundCraft's "Audio-to-MIDI" export; the note segmentation itself lives
 * in types/midi.ts (vocal/drum/harmony converters over Waveyard's own
 * analyses).
 */

import { millisecondsToMidiTicks, type MidiNoteEvent } from "./types/midi";

const MAX_TICK = 0x0fffffff; // largest value a 4-byte MIDI VLQ can hold
const DEFAULT_BPM = 120;

function vlq(value: number): number[] {
  let v = Math.max(0, Math.min(MAX_TICK, Math.round(value)));
  const buffer = [v & 0x7f];
  v >>>= 7;
  while (v > 0) {
    buffer.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return buffer;
}

type TrackEvent = { tick: number; order: number; bytes: number[] };

/**
 * Build a format-0 SMF from note events. Notes are converted to PPQ ticks
 * at `bpm` (clamped to the converter's 20..300 range); simultaneous events
 * order note-offs before note-ons so a retriggered pitch never sticks.
 * Returns the complete file as bytes.
 */
export function buildStandardMidiFile(
  notes: readonly MidiNoteEvent[],
  bpm = DEFAULT_BPM,
  ppq = 480,
): Uint8Array {
  const tempo =
    Number.isFinite(bpm) && bpm >= 20 && bpm <= 300 ? bpm : DEFAULT_BPM;
  const microsecondsPerQuarter = Math.min(0xffffff, Math.max(1, Math.round(60_000_000 / tempo)));

  const events: TrackEvent[] = [];
  // Tempo meta event at tick 0: FF 51 03 <24-bit microseconds per quarter>.
  events.push({
    tick: 0,
    order: -1,
    bytes: [0xff, 0x51, 0x03, (microsecondsPerQuarter >> 16) & 0xff, (microsecondsPerQuarter >> 8) & 0xff, microsecondsPerQuarter & 0xff],
  });
  for (const note of notes) {
    const startTick = millisecondsToMidiTicks(note.startMs, tempo, ppq) ?? 0;
    const endTick = millisecondsToMidiTicks(note.startMs + note.durationMs, tempo, ppq) ?? startTick;
    const channel = Math.max(0, Math.min(15, note.channel | 0));
    const midiNote = Math.max(0, Math.min(127, note.midiNote | 0));
    const velocity = Math.max(1, Math.min(127, note.velocity | 0));
    events.push({ tick: startTick, order: 1, bytes: [0x90 | channel, midiNote, velocity] });
    // Note-offs sort before note-ons at the same tick (order 0 < 1).
    events.push({ tick: Math.max(startTick + 1, endTick), order: 0, bytes: [0x80 | channel, midiNote, 0x00] });
  }
  events.sort((left, right) => left.tick - right.tick || left.order - right.order);

  const track: number[] = [];
  let lastTick = 0;
  for (const event of events) {
    track.push(...vlq(event.tick - lastTick), ...event.bytes);
    lastTick = event.tick;
  }
  // End of track: delta 0, FF 2F 00.
  track.push(0x00, 0xff, 0x2f, 0x00);

  const bytes: number[] = [
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // header length 6
    0x00, 0x00, // format 0
    0x00, 0x01, // one track
    (ppq >> 8) & 0xff, ppq & 0xff, // division: ticks per quarter note
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff, (track.length >>> 8) & 0xff, track.length & 0xff,
    ...track,
  ];
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// Reader — the other half of the interchange promise: FL Studio opens our
// SMF natively, and we open FL's exported MIDI (format 0 or 1, running
// status, tempo maps with mid-song changes). Clean-room against the same
// published SMF specification as the writer.
// ---------------------------------------------------------------------------

export type ParsedMidiFile = {
  ppq: number;
  /** The file's tempo map, condensed to the tempo segments actually used. */
  tempoChanges: Array<{ tick: number; bpm: number }>;
  notes: MidiNoteEvent[];
  durationMs: number;
};

type RawNote = { startTick: number; durationTicks: number; midiNote: number; velocity: number; channel: number };
type OpenNote = { channel: number; midiNote: number; velocity: number; startTick: number };

function readVlq(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0;
  let position = offset;
  for (let step = 0; step < 4; step += 1) {
    if (position >= bytes.length) return null;
    const byte = bytes[position];
    position += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: position };
  }
  return null; // VLQ longer than 4 bytes is invalid in SMF
}

/**
 * Parse a Standard MIDI File into millisecond note events. Returns null for
 * structurally invalid files (bad headers, truncated tracks, SMPTE timing,
 * running-status misuse) — callers surface an honest import error rather
 * than guessing. Note-ons still open at end-of-track are closed there;
 * a retriggered pitch closes its previous instance first.
 */
export function parseStandardMidiFile(bytes: Uint8Array): ParsedMidiFile | null {
  if (bytes.length < 14) return null;
  if (!(bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64)) return null; // MThd
  const headerLength = (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  if (headerLength < 6 || 8 + headerLength > bytes.length) return null;
  const format = (bytes[8] << 8) | bytes[9];
  const trackCount = (bytes[10] << 8) | bytes[11];
  const division = (bytes[12] << 8) | bytes[13];
  if (format !== 0 && format !== 1) return null; // format 2 (asynchronous) is not a song
  if (trackCount < 1) return null;
  if ((division & 0x8000) !== 0) return null; // SMPTE timing — no PPQ grid to convert against
  const ppq = division;
  if (ppq < 1) return null;

  let position = 8 + headerLength;
  const tracks: Array<{ tempo: Array<{ tick: number; usPerQuarter: number }>; rawNotes: RawNote[]; endTick: number }> = [];
  let tracksSeen = 0;

  while (position + 8 <= bytes.length && tracksSeen < trackCount) {
    if (!(bytes[position] === 0x4d && bytes[position + 1] === 0x54 && bytes[position + 2] === 0x72 && bytes[position + 3] === 0x6b)) {
      return null; // expected MTrk
    }
    const trackLength = (bytes[position + 4] << 24) | (bytes[position + 5] << 16) | (bytes[position + 6] << 8) | bytes[position + 7];
    const trackStart = position + 8;
    const trackEnd = trackStart + trackLength;
    if (trackEnd > bytes.length) return null;

    const tempo: Array<{ tick: number; usPerQuarter: number }> = [];
    const open = new Map<string, OpenNote>();
    const rawNotes: RawNote[] = [];
    let tick = 0;
    let cursor = trackStart;
    let status = -1; // running status

    while (cursor < trackEnd) {
      const delta = readVlq(bytes, cursor);
      if (delta === null) return null;
      cursor = delta.next;
      tick += delta.value;

      let opcode = bytes[cursor];
      if (opcode === undefined) return null;
      if (opcode < 0x80) {
        if (status < 0x80) return null; // data byte with no running status
        opcode = status;
      } else {
        cursor += 1;
        if (opcode < 0xf0) status = opcode;
        else status = -1; // system/meta events clear running status
      }

      if (opcode === 0xff) {
        const metaType = bytes[cursor];
        const metaLength = readVlq(bytes, cursor + 1);
        if (metaType === undefined || metaLength === null) return null;
        const dataStart = metaLength.next;
        if (dataStart + metaLength.value > trackEnd) return null;
        if (metaType === 0x51 && metaLength.value === 3) {
          const usPerQuarter = (bytes[dataStart] << 16) | (bytes[dataStart + 1] << 8) | bytes[dataStart + 2];
          if (usPerQuarter > 0) tempo.push({ tick, usPerQuarter });
        }
        cursor = dataStart + metaLength.value;
        continue;
      }
      if (opcode === 0xf0 || opcode === 0xf7) {
        // Sysex: length-prefixed, skipped.
        const sysexLength = readVlq(bytes, cursor);
        if (sysexLength === null || sysexLength.next + sysexLength.value > trackEnd) return null;
        cursor = sysexLength.next + sysexLength.value;
        continue;
      }
      if (opcode >= 0xf1 && opcode <= 0xfe) return null; // system messages have no place in an SMF track

      // Channel voice message: two data bytes (the roll is a note editor —
      // CC/program/aftertouch/bend are parsed over and skipped).
      const data1 = bytes[cursor];
      const data2 = bytes[cursor + 1];
      if (data1 === undefined || data2 === undefined) return null;
      cursor += 2;
      const channel = opcode & 0x0f;
      const kind = opcode & 0xf0;
      if (kind === 0x90 && data2 > 0) {
        const key = `${channel}:${data1}`;
        const existing = open.get(key);
        if (existing !== undefined) {
          rawNotes.push({ startTick: existing.startTick, durationTicks: Math.max(1, tick - existing.startTick), midiNote: existing.midiNote, velocity: existing.velocity, channel: existing.channel });
        }
        open.set(key, { channel, midiNote: data1, velocity: data2, startTick: tick });
      } else if (kind === 0x80 || (kind === 0x90 && data2 === 0)) {
        const key = `${channel}:${data1}`;
        const existing = open.get(key);
        if (existing !== undefined) {
          open.delete(key);
          rawNotes.push({ startTick: existing.startTick, durationTicks: Math.max(1, tick - existing.startTick), midiNote: existing.midiNote, velocity: existing.velocity, channel: existing.channel });
        }
      }
    }

    // Still-open notes close at the track's end (FL's own export behavior).
    for (const existing of open.values()) {
      rawNotes.push({ startTick: existing.startTick, durationTicks: Math.max(1, tick - existing.startTick), midiNote: existing.midiNote, velocity: existing.velocity, channel: existing.channel });
    }
    tracks.push({ tempo, rawNotes, endTick: tick });
    tracksSeen += 1;
    position = trackEnd;
  }

  if (tracksSeen !== trackCount) return null;

  // Merge tempo maps across tracks (format 1 convention: tempo lives in
  // track 0, but any track may legally carry it; earliest tempo wins a tick).
  const tempoByTick = new Map<number, number>();
  for (const track of tracks) {
    for (const change of track.tempo) {
      const existing = tempoByTick.get(change.tick);
      if (existing === undefined || change.usPerQuarter < existing) tempoByTick.set(change.tick, change.usPerQuarter);
    }
  }
  const segments = [...tempoByTick.entries()].sort((left, right) => left[0] - right[0]).map(([tick, usPerQuarter]) => ({ tick, usPerQuarter }));
  if (segments.length === 0 || segments[0].tick > 0) segments.unshift({ tick: 0, usPerQuarter: 500_000 }); // 120 bpm default

  // Precompute the ms at each tempo-change tick (piecewise integration).
  const segmentStartMs: number[] = [0];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const deltaTicks = segments[index].tick - previous.tick;
    segmentStartMs[index] = segmentStartMs[index - 1] + (deltaTicks * previous.usPerQuarter) / (1000 * ppq);
  }
  const tickToMs = (targetTick: number): number => {
    if (targetTick <= 0) return 0;
    let index = 0;
    while (index + 1 < segments.length && segments[index + 1].tick <= targetTick) index += 1;
    const segment = segments[index];
    return segmentStartMs[index] + ((targetTick - segment.tick) * segment.usPerQuarter) / (1000 * ppq);
  };

  const notes: MidiNoteEvent[] = [];
  let endTick = 0;
  for (const track of tracks) {
    endTick = Math.max(endTick, track.endTick);
    for (const raw of track.rawNotes) {
      const startMs = Math.round(tickToMs(raw.startTick));
      const endMs = Math.round(tickToMs(raw.startTick + raw.durationTicks));
      notes.push({
        startMs,
        durationMs: Math.max(1, endMs - startMs),
        midiNote: Math.max(0, Math.min(127, raw.midiNote)),
        velocity: Math.max(1, Math.min(127, raw.velocity)),
        channel: raw.channel,
      });
    }
  }
  notes.sort((left, right) => left.startMs - right.startMs || left.channel - right.channel || left.midiNote - right.midiNote);
  if (notes.length > 100_000) return null;

  const tempoChanges = segments.map((segment) => ({ tick: segment.tick, bpm: Math.round((60_000_000 / segment.usPerQuarter) * 10) / 10 }));
  return { ppq, tempoChanges, notes, durationMs: Math.round(tickToMs(endTick)) };
}
