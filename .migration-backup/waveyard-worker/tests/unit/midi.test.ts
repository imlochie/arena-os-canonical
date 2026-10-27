import { describe, expect, it } from "vitest";
import {
  drumEventsToMidiNotes,
  harmonyEventsToMidiNotes,
  millisecondsToMidiTicks,
  normaliseMidiNoteEvents,
  quantizeMillisecondsToBeatGrid,
  vocalFramesToMidiNotes,
  MIDI_PPQ,
} from "@waveyard/types";
import { encodeMidiFile } from "../../apps/worker/src/midi";

describe("deterministic audio-analysis MIDI foundation", () => {
  it("keeps milliseconds authoritative while converting to fixed PPQ ticks", () => {
    expect(MIDI_PPQ).toBe(480);
    expect(millisecondsToMidiTicks(500, 120)).toBe(480);
    expect(millisecondsToMidiTicks(1_000, 120)).toBe(960);
    expect(millisecondsToMidiTicks(-1, 120)).toBeNull();
    expect(quantizeMillisecondsToBeatGrid(490, [0, 500, 1_000])).toBe(500);
  });

  it("normalizes note bounds and derives stable vocal note candidates without correction", () => {
    expect(normaliseMidiNoteEvents([{ startMs: 0, durationMs: 100, midiNote: 60, velocity: 90, channel: 0 }])).toHaveLength(1);
    expect(normaliseMidiNoteEvents([{ startMs: 0, durationMs: 0, midiNote: 60, velocity: 90, channel: 0 }])).toBeNull();
    const frames = [
      { timestampMs: 0, frequencyHz: 440, midiFloat: 69, nearestMidiNote: 69, confidence: 0.9, voiced: true },
      { timestampMs: 50, frequencyHz: 440, midiFloat: 69, nearestMidiNote: 69, confidence: 0.8, voiced: true },
      { timestampMs: 100, frequencyHz: 440, midiFloat: 69, nearestMidiNote: 69, confidence: 0.9, voiced: true },
      { timestampMs: 150, frequencyHz: null, midiFloat: null, nearestMidiNote: null, confidence: 0, voiced: false },
    ];
    expect(vocalFramesToMidiNotes(frames, { minimumDurationMs: 100 })).toEqual([{ startMs: 0, durationMs: 150, midiNote: 69, velocity: 110, channel: 0 }]);
  });

  it("maps only confident known drums and canonical source chord voicings", () => {
    expect(drumEventsToMidiNotes([
      { timestampMs: 100, strength: 0.9, confidence: 0.8, rhythmicClass: "kick", nearestBeatIndex: null, beatOffsetMs: null },
      { timestampMs: 200, strength: 1, confidence: 1, rhythmicClass: null, nearestBeatIndex: null, beatOffsetMs: null },
    ])).toEqual([{ startMs: 100, durationMs: 60, midiNote: 36, velocity: 114, channel: 9 }]);
    expect(harmonyEventsToMidiNotes([{ startMs: 0, endMs: 1_000, root: "A", quality: "minor", confidence: 0.8 }]).map((note) => note.midiNote)).toEqual([57, 60, 64]);
  });

  it("encodes deterministic standard MIDI bytes with a valid header", () => {
    const notes = [{ startMs: 0, durationMs: 500, midiNote: 60, velocity: 100, channel: 0 }];
    const first = encodeMidiFile(notes, 120);
    expect(first.subarray(0, 4).toString("ascii")).toBe("MThd");
    expect(first.subarray(14, 18).toString("ascii")).toBe("MTrk");
    expect(first.equals(encodeMidiFile(notes, 120))).toBe(true);
  });
});
