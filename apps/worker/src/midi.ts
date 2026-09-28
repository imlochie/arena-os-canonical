import { writeFile } from "node:fs/promises";
import { millisecondsToMidiTicks, normaliseMidiNoteEvents, MIDI_PPQ, type MidiNoteEvent } from "@waveyard/types";

function variableLength(value: number) {
  const bytes = [value & 0x7f];
  let remainder = value >>> 7;
  while (remainder > 0) { bytes.unshift((remainder & 0x7f) | 0x80); remainder >>>= 7; }
  return bytes;
}

/** Deterministic standard-MIDI-file encoder. It receives source/remix ms only. */
export function encodeMidiFile(notesInput: readonly MidiNoteEvent[], bpm: number, ppq = MIDI_PPQ) {
  const notes = normaliseMidiNoteEvents(notesInput);
  if (!notes || !Number.isFinite(bpm) || bpm < 20 || bpm > 300 || ppq !== MIDI_PPQ) throw new Error("Invalid deterministic MIDI export input.");
  const events: Array<{ tick: number; order: number; data: number[] }> = [];
  const microsecondsPerQuarter = Math.round(60_000_000 / bpm);
  events.push({ tick: 0, order: -1, data: [0xff, 0x51, 0x03, (microsecondsPerQuarter >>> 16) & 0xff, (microsecondsPerQuarter >>> 8) & 0xff, microsecondsPerQuarter & 0xff] });
  for (const note of notes) {
    const startTick = millisecondsToMidiTicks(note.startMs, bpm, ppq);
    const endTick = millisecondsToMidiTicks(note.startMs + note.durationMs, bpm, ppq);
    if (startTick === null || endTick === null) throw new Error("MIDI timing conversion failed.");
    events.push({ tick: startTick, order: 1, data: [0x90 | note.channel, note.midiNote, note.velocity] });
    events.push({ tick: Math.max(startTick + 1, endTick), order: 0, data: [0x80 | note.channel, note.midiNote, 0] });
  }
  events.sort((left, right) => left.tick - right.tick || left.order - right.order || left.data[1] - right.data[1] || left.data[0] - right.data[0]);
  let previousTick = 0;
  const track = events.flatMap((event) => {
    const delta = variableLength(event.tick - previousTick); previousTick = event.tick;
    return [...delta, ...event.data];
  });
  track.push(0x00, 0xff, 0x2f, 0x00);
  const header = Buffer.alloc(14);
  header.write("MThd", 0, "ascii"); header.writeUInt32BE(6, 4); header.writeUInt16BE(0, 8); header.writeUInt16BE(1, 10); header.writeUInt16BE(ppq, 12);
  const trackHeader = Buffer.alloc(8);
  trackHeader.write("MTrk", 0, "ascii"); trackHeader.writeUInt32BE(track.length, 4);
  return Buffer.concat([header, trackHeader, Buffer.from(track)]);
}

export async function writeMidiFile(path: string, notes: readonly MidiNoteEvent[], bpm: number) {
  await writeFile(path, encodeMidiFile(notes, bpm));
}
