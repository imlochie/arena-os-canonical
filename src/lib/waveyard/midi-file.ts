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
