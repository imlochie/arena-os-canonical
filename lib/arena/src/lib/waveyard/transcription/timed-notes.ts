import { displaySourceSectionLabel, type SourceSection } from "../types/source-sections";
import { usableBeatGrid } from "../types/beat-grid";
import { findRepeatedLyricPhrases, type TimedLyricSegment } from "./lyric-recurrence";

export type TimedVocalPhrase = {
  startMs: number;
  endMs: number;
  confidence: number;
};

export type AnnotatedTimingKind = "structure" | "vocal-phrase" | "lyric-recurrence" | "lyric";

export type AnnotatedTimingNote = {
  id: string;
  atMs: number;
  endMs?: number;
  kind: AnnotatedTimingKind;
  label: string;
  text: string;
  timingResolution?: "word" | "segment";
  beatContext?: string;
};

export type AnnotatedTranscriptInput = {
  durationMs: number;
  transcript: readonly TimedLyricSegment[];
  sections: readonly Pick<SourceSection,
    "sectionIndex" | "startMs" | "endMs" | "startBar" | "endBar" | "label" | "labelConfidence">[];
  vocalPhrases: readonly TimedVocalPhrase[];
  analysisStatus?: unknown;
  beatGridMs?: unknown;
  beatConfidence?: unknown;
};

const VOCAL_PHRASE_MIN_CONFIDENCE = 0.6;
const BEAT_REFERENCE_MIN_CONFIDENCE = 0.5;

function validRange(startMs: number, endMs: number, durationMs: number) {
  return Number.isSafeInteger(startMs)
    && Number.isSafeInteger(endMs)
    && startMs >= 0
    && endMs > startMs
    && endMs <= durationMs;
}

function nearestBeatIndex(timeMs: number, beats: readonly number[]): number | null {
  if (!beats.length || timeMs < beats[0]! || timeMs > beats.at(-1)!) return null;
  let low = 0;
  let high = beats.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (beats[middle]! <= timeMs) low = middle;
    else high = middle;
  }
  if (timeMs <= beats[low]!) return low;
  if (timeMs >= beats[high]!) return high;
  return timeMs - beats[low]! <= beats[high]! - timeMs ? low : high;
}

function beatContextAt(timeMs: number, beats: readonly number[] | null) {
  if (!beats) return undefined;
  const index = nearestBeatIndex(timeMs, beats);
  if (index === null) return undefined;
  const offset = timeMs - beats[index]!;
  const bar = Math.floor(index / 4) + 1;
  const beat = index % 4 + 1;
  const signedOffset = `${offset >= 0 ? "+" : ""}${offset}`;
  return `Nearest estimated beat: ${index + 1} (bar ${bar}, beat ${beat}; ${signedOffset} ms). Bar numbers assume 4/4.`;
}

function semanticStructureLabel(section: AnnotatedTranscriptInput["sections"][number]) {
  if (section.label === "verse" || section.label === "chorus") {
    return `Unverified form candidate: ${section.label}`;
  }
  return displaySourceSectionLabel(section);
}

function notePriority(kind: AnnotatedTimingKind) {
  switch (kind) {
    case "structure": return 0;
    case "vocal-phrase": return 1;
    case "lyric-recurrence": return 2;
    case "lyric": return 3;
  }
}

/**
 * Merge timestamped words, voiced phrase estimates, repeated lyric candidates,
 * and detector boundaries into a source-time transcript. Musical-form labels
 * remain explicitly unverified and are never inferred from transcript text.
 */
export function buildAnnotatedTimingNotes(input: AnnotatedTranscriptInput): AnnotatedTimingNote[] {
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) return [];

  const rawBeats = usableBeatGrid(input.beatGridMs);
  let beats: number[] | null = null;
  if (input.analysisStatus === "complete"
    && typeof input.beatConfidence === "number"
    && Number.isFinite(input.beatConfidence)
    && input.beatConfidence >= BEAT_REFERENCE_MIN_CONFIDENCE
    && rawBeats
    && rawBeats.length >= 2
    && rawBeats.every((beat, index) => index === 0 || beat > rawBeats[index - 1]!)) {
    beats = rawBeats;
  }
  const notes: AnnotatedTimingNote[] = [];
  const add = (note: AnnotatedTimingNote) => notes.push(note);

  const orderedSections = [...input.sections].sort((left, right) => left.startMs - right.startMs);
  orderedSections.forEach((section, index) => {
    if (!Number.isSafeInteger(section.startMs)
      || section.startMs < 0
      || section.startMs >= input.durationMs
      || !validRange(section.startMs, section.endMs, input.durationMs)) return;
    const formLabel = semanticStructureLabel(section);
    const isSemanticCandidate = section.label === "verse" || section.label === "chorus";
    add({
      id: `section-${section.sectionIndex}-${section.startMs}`,
      atMs: section.startMs,
      kind: "structure",
      label: `Detected structure boundary · section ${section.sectionIndex + 1}`,
      text: `${formLabel}. Analysis bars ${section.startBar}–${section.endBar}; bar numbering assumes 4/4.${isSemanticCandidate ? " Not human-verified." : " This is a detector cue, not a semantic form label."}`,
      beatContext: beatContextAt(section.startMs, beats),
    });
    const previous = input.sections[index - 1];
    if (previous && section.startMs > previous.endMs) {
      add({
        id: `uncovered-gap-${previous.sectionIndex}-${section.sectionIndex}`,
        atMs: previous.endMs,
        kind: "structure",
        label: "Uncovered structural interval",
        text: `No section boundary was recorded between section ${previous.sectionIndex + 1} and section ${section.sectionIndex + 1}. This does not prove silence or a new musical section.`,
        beatContext: beatContextAt(previous.endMs, beats),
      });
    }
  });

  input.vocalPhrases.forEach((phrase, index) => {
    if (!Number.isFinite(phrase.confidence)
      || phrase.confidence < VOCAL_PHRASE_MIN_CONFIDENCE
      || !validRange(phrase.startMs, phrase.endMs, input.durationMs)) return;
    add({
      id: `vocal-start-${index}-${phrase.startMs}`,
      atMs: phrase.startMs,
      endMs: phrase.endMs,
      kind: "vocal-phrase",
      label: "Voiced phrase estimate begins",
      text: "Pitch-continuity evidence; this is not a word boundary or lyric transcription.",
      beatContext: beatContextAt(phrase.startMs, beats),
    });
    add({
      id: `vocal-end-${index}-${phrase.endMs}`,
      atMs: phrase.endMs,
      kind: "vocal-phrase",
      label: "Voiced phrase estimate ends",
      text: "Pitch-continuity evidence; unvoiced syllables may be missing.",
      beatContext: beatContextAt(phrase.endMs, beats),
    });
  });

  const repeatedPhrases = findRepeatedLyricPhrases(input.transcript);
  repeatedPhrases.forEach((phrase) => {
    phrase.occurrences.forEach((occurrence, index) => {
      const atMs = Math.round(occurrence.start * 1000);
      const endMs = Math.round(occurrence.end * 1000);
      if (!validRange(atMs, endMs, input.durationMs)) return;
      add({
        id: `lyric-repeat-${phrase.text}-${index}-${atMs}`,
        atMs,
        endMs,
        kind: "lyric-recurrence",
        label: `Unreviewed lyric recurrence · ${index + 1} of ${phrase.occurrences.length}`,
        text: `“${phrase.text}” repeats in the transcript draft; recurrence alone does not prove a chorus.`,
        timingResolution: phrase.timingResolution,
        beatContext: beatContextAt(atMs, beats),
      });
    });
  });

  input.transcript.forEach((segment, segmentIndex) => {
    if (typeof segment.text !== "string" || !segment.text.trim()) return;
    const words = segment.words?.filter((word) =>
      Number.isFinite(word.start)
      && Number.isFinite(word.end)
      && word.start >= segment.start - 0.5
      && word.end <= segment.end + 0.5
      && word.end > word.start
      && typeof word.text === "string"
      && word.text.trim(),
    );
    if (words?.length) {
      words.forEach((word, wordIndex) => {
        const atMs = Math.round(word.start * 1000);
        const endMs = Math.round(word.end * 1000);
        if (!validRange(atMs, endMs, input.durationMs)) return;
        add({
          id: `lyric-word-${segmentIndex}-${wordIndex}-${atMs}`,
          atMs,
          endMs,
          kind: "lyric",
          label: "Unverified lyric · word-timed draft",
          text: word.text,
          timingResolution: "word",
          beatContext: beatContextAt(atMs, beats),
        });
      });
      return;
    }
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)) return;
    const atMs = Math.round(segment.start * 1000);
    const endMs = Math.round(segment.end * 1000);
    if (!validRange(atMs, endMs, input.durationMs)) return;
    add({
      id: `lyric-segment-${segmentIndex}-${atMs}`,
      atMs,
      endMs,
      kind: "lyric",
      label: "Unverified lyric · segment-timed draft",
      text: segment.text.trim(),
      timingResolution: "segment",
      beatContext: beatContextAt(atMs, beats),
    });
  });

  return notes.sort((left, right) =>
    left.atMs - right.atMs
    || notePriority(left.kind) - notePriority(right.kind)
    || left.id.localeCompare(right.id),
  );
}

export function buildAnnotatedTranscriptText(
  notes: readonly AnnotatedTimingNote[],
  options: { sourceName: string; sourceChecksumSha256: string; stemChecksumSha256: string },
) {
  const sourceName = options.sourceName.replace(/[\r\n]+/g, " ").trim() || "Unknown source";
  const header = [
    "Waveyard — timestamped transcript and song-structure notes",
    `Source: ${sourceName}`,
    `Source SHA-256: ${options.sourceChecksumSha256}`,
    `Vocal stem SHA-256: ${options.stemChecksumSha256}`,
    "All times are source-relative. Lyrics are unverified transcription drafts.",
    "Form candidates and phrase boundaries are detector evidence, not human-confirmed labels.",
    "Bar numbers assume 4/4; nearest-beat references are shown only for a completed analysis with a usable beat grid.",
    "",
  ];
  const lines = notes.map((note) => {
    const start = formatAnnotatedTime(note.atMs);
    const range = note.endMs !== undefined && note.endMs > note.atMs
      ? `–${formatAnnotatedTime(note.endMs)}`
      : "";
    const timing = note.timingResolution === "segment"
      ? " [coarse segment timing]"
      : note.timingResolution === "word" ? " [word timing]" : "";
    const beat = note.beatContext ? ` · ${note.beatContext}` : "";
    return `${start}${range} | ${note.label}${timing}\n  ${note.text}${beat}`;
  });
  return [...header, ...lines].join("\n");
}

export function formatAnnotatedTime(timeMs: number) {
  const safe = Number.isFinite(timeMs) ? Math.max(0, Math.round(timeMs)) : 0;
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const milliseconds = safe % 1000;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const millis = String(milliseconds).padStart(3, "0");
  return hours > 0
    ? `${hours}:${mm}:${ss}.${millis}`
    : `${minutes}:${ss}.${millis}`;
}
