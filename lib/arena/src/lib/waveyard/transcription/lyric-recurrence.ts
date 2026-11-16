/**
 * Extract repeated lyric phrases from locally generated timestamped
 * transcription. Recurrence is evidence for a hook, not a semantic chorus
 * label; the same lyric can recur in a pre-chorus, bridge, or outro.
 */

export type TimedLyricWord = {
  text: string;
  start: number;
  end: number;
};

export type TimedLyricSegment = TimedLyricWord & {
  words?: TimedLyricWord[];
};

export type RepeatedLyricPhrase = {
  text: string;
  occurrences: Array<{ start: number; end: number }>;
  timingResolution: "word" | "segment";
};

type Token = TimedLyricWord & { normalized: string; resolution: "word" | "segment" };

function validRange(start: number, end: number) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
}

function normalizeToken(text: string) {
  return text.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function tokensForSegment(segment: TimedLyricSegment): Token[] {
  if (!validRange(segment.start, segment.end) || !segment.text.trim()) return [];
  const words = segment.words?.filter((word) =>
    validRange(word.start, word.end)
    && word.start >= segment.start - 0.5
    && word.end <= segment.end + 0.5
    && word.text.trim(),
  );
  if (words?.length) {
    return words.flatMap((word) => word.text.trim().split(/\s+/).map((text) => ({
      text,
      start: word.start,
      end: word.end,
      normalized: normalizeToken(text),
      resolution: "word" as const,
    }))).filter((token) => token.normalized);
  }

  // Some ASR engines return only chunk timestamps. Keep their evidence useful,
  // but mark the inferred per-word timing as coarse rather than pretending it
  // was measured at word resolution.
  const text = segment.text.trim().split(/\s+/).filter(Boolean);
  const duration = segment.end - segment.start;
  return text.flatMap((word, index) => {
    const normalized = normalizeToken(word);
    if (!normalized) return [];
    return [{
      text: word,
      start: segment.start + duration * index / text.length,
      end: segment.start + duration * (index + 1) / text.length,
      normalized,
      resolution: "segment" as const,
    }];
  });
}

/**
 * Find exact recurring 3–8 word n-grams, collapsing repeated occurrences
 * within a short span into one cue. Longer, distinct matches are preferred
 * over their overlapping sub-phrases.
 */
export function findRepeatedLyricPhrases(
  segments: readonly TimedLyricSegment[],
  options: { minWords?: number; maxWords?: number; minimumRepeatGapSeconds?: number; limit?: number } = {},
): RepeatedLyricPhrase[] {
  const minWords = Math.max(2, Math.floor(options.minWords ?? 3));
  const maxWords = Math.max(minWords, Math.min(12, Math.floor(options.maxWords ?? 8)));
  const minimumRepeatGapSeconds = Math.max(0, options.minimumRepeatGapSeconds ?? 8);
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 8)));
  const tokens = segments.flatMap(tokensForSegment).sort((a, b) => a.start - b.start || a.end - b.end);
  const candidates = new Map<string, Array<{ start: number; end: number; words: Token[] }>>();

  for (let start = 0; start < tokens.length; start += 1) {
    for (let length = minWords; length <= maxWords && start + length <= tokens.length; length += 1) {
      const words = tokens.slice(start, start + length);
      if (words.slice(1).some((word, index) => word.start - words[index]!.end > 2)) break;
      const key = words.map((word) => word.normalized).join(" ");
      const occurrence = { start: words[0]!.start, end: words.at(-1)!.end, words };
      const group = candidates.get(key) ?? [];
      group.push(occurrence);
      candidates.set(key, group);
    }
  }

  const ranked = [...candidates.entries()].flatMap(([key, rawOccurrences]) => {
    const occurrences: typeof rawOccurrences = [];
    for (const occurrence of rawOccurrences.sort((a, b) => a.start - b.start)) {
      const previous = occurrences.at(-1);
      if (!previous || occurrence.start - previous.start >= minimumRepeatGapSeconds) {
        occurrences.push(occurrence);
      }
    }
    if (occurrences.length < 2) return [];
    const words = occurrences[0]!.words;
    const resolution = occurrences.every((occurrence) =>
      occurrence.words.every((word) => word.resolution === "word"),
    ) ? "word" as const : "segment" as const;
    return [{
      key,
      length: words.length,
      phrase: {
        text: words.map((word) => word.text.replace(/[.,!?;:]+$/u, "")).join(" "),
        occurrences: occurrences.map(({ start, end }) => ({ start, end })),
        timingResolution: resolution,
      } satisfies RepeatedLyricPhrase,
    }];
  }).sort((a, b) => b.length - a.length
    || b.phrase.occurrences.length - a.phrase.occurrences.length
    || a.phrase.occurrences[0]!.start - b.phrase.occurrences[0]!.start);

  const selected: typeof ranked = [];
  for (const candidate of ranked) {
    const isCovered = selected.some((longer) => {
      if (!longer.key.includes(candidate.key)) return false;
      return candidate.phrase.occurrences.every((occurrence) =>
        longer.phrase.occurrences.some((match) =>
          Math.abs(match.start - occurrence.start) <= 1.5
          && Math.abs(match.end - occurrence.end) <= 2.5,
        ),
      );
    });
    if (!isCovered) selected.push(candidate);
    if (selected.length >= limit) break;
  }

  return selected.map(({ phrase }) => phrase)
    .sort((a, b) => a.occurrences[0]!.start - b.occurrences[0]!.start);
}
