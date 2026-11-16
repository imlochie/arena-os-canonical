import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnnotatedTimingNotes,
  buildAnnotatedTranscriptText,
  formatAnnotatedTime,
} from "./timed-notes";

const words = (start: number, items: string[]) => items.map((text, index) => ({
  text,
  start: start + index * 0.25,
  end: start + index * 0.25 + 0.2,
}));

const sections = [
  {
    sectionIndex: 0, startMs: 0, endMs: 20_000, startBar: 1, endBar: 11,
    label: "section", labelConfidence: 0,
  },
  {
    sectionIndex: 1, startMs: 20_000, endMs: 45_000, startBar: 11, endBar: 24,
    label: "chorus", labelConfidence: 0.8,
  },
];

const transcript = [
  { start: 10, end: 11.2, text: "we sing all night", words: words(10, ["we", "sing", "all", "night"]) },
  { start: 30, end: 31.2, text: "we sing all night", words: words(30, ["we", "sing", "all", "night"]) },
];

test("interleaves section boundaries, voiced phrase estimates, repeated lyrics, and word timestamps", () => {
  const notes = buildAnnotatedTimingNotes({
    durationMs: 45_000,
    transcript,
    sections,
    vocalPhrases: [{ startMs: 9_500, endMs: 11_000, confidence: 0.8 }],
    analysisStatus: "complete",
    beatConfidence: 0.9,
    beatGridMs: Array.from({ length: 91 }, (_, index) => index * 500),
  });

  assert.ok(notes.every((note, index) => index === 0 || notes[index - 1]!.atMs <= note.atMs));
  assert.ok(notes.some((note) => note.kind === "structure"
    && note.text.includes("Unverified form candidate: chorus")
    && note.text.includes("Not human-verified")));
  assert.ok(notes.some((note) => note.kind === "vocal-phrase"
    && note.label === "Voiced phrase estimate begins"
    && note.text.includes("not a word boundary")));
  assert.ok(notes.some((note) => note.kind === "lyric-recurrence"
    && note.text.includes("we sing all night")
    && note.text.includes("does not prove a chorus")));
  const lyric = notes.find((note) => note.kind === "lyric" && note.text === "we");
  assert.equal(lyric?.timingResolution, "word");
  assert.equal(lyric?.atMs, 10_000);
  assert.match(lyric?.beatContext ?? "", /bar 6, beat 1; \+0 ms/);

  const exported = buildAnnotatedTranscriptText(notes, {
    sourceName: "September.wav",
    sourceChecksumSha256: "a".repeat(64),
    stemChecksumSha256: "b".repeat(64),
  });
  assert.match(exported, /0:20\.000 \| Detected structure boundary/);
  assert.match(exported, /Unverified form candidate: chorus/);
  assert.match(exported, /0:10\.000–0:10\.200 \| Unverified lyric · word-timed draft/);
});

test("does not invent bar and beat references from incomplete or weak analysis", () => {
  const note = buildAnnotatedTimingNotes({
    durationMs: 45_000,
    transcript: [{ start: 1, end: 2, text: "hello" }],
    sections: [],
    vocalPhrases: [],
    analysisStatus: "complete",
    beatGridMs: Array.from({ length: 91 }, (_, index) => index * 500),
    beatConfidence: null,
  }).find((entry) => entry.kind === "lyric");

  assert.equal(note?.beatContext, undefined);
});

test("segment-only transcripts retain honest coarse timing labels", () => {
  const note = buildAnnotatedTimingNotes({
    durationMs: 10_000,
    transcript: [{ start: 1.234, end: 2.345, text: "a whole lyric phrase" }],
    sections: [],
    vocalPhrases: [],
  }).find((entry) => entry.kind === "lyric");

  assert.equal(note?.timingResolution, "segment");
  assert.equal(note?.atMs, 1_234);
  assert.equal(note?.endMs, 2_345);
  assert.match(buildAnnotatedTranscriptText([note!], {
    sourceName: "sample",
    sourceChecksumSha256: "a".repeat(64),
    stemChecksumSha256: "b".repeat(64),
  }), /\[coarse segment timing\]/);
});

test("formats timestamps with milliseconds and hour rollover", () => {
  assert.equal(formatAnnotatedTime(61_234), "1:01.234");
  assert.equal(formatAnnotatedTime(3_661_007), "1:01:01.007");
});
