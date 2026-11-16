import assert from "node:assert/strict";
import test from "node:test";
import { findRepeatedLyricPhrases } from "./lyric-recurrence";

function words(text: string, start: number) {
  const tokens = text.trim().split(/\s+/);
  return {
    start,
    end: start + tokens.length * 0.3,
    text,
    words: tokens.map((token, index) => ({
      text: `${index ? " " : ""}${token}`,
      start: start + index * 0.3,
      end: start + (index + 1) * 0.3,
    })),
  };
}

test("finds repeated lyric phrases by their word timing and suppresses overlapping n-grams", () => {
  const phrases = findRepeatedLyricPhrases([
    words("We keep on dancing through the night", 14),
    words("A different verse with new words", 32),
    words("We keep on dancing through the night", 76),
  ]);

  assert.deepEqual(phrases, [{
    text: "We keep on dancing through the night",
    occurrences: [
      { start: 14, end: 16.1 },
      { start: 76, end: 78.1 },
    ],
    timingResolution: "word",
  }]);
});

test("labels chunk-interpolated phrase timing as coarse", () => {
  const phrases = findRepeatedLyricPhrases([
    { start: 5, end: 8, text: "Open up the morning light" },
    { start: 40, end: 43, text: "Open up the morning light" },
  ]);

  assert.equal(phrases[0]?.text, "Open up the morning light");
  assert.equal(phrases[0]?.timingResolution, "segment");
  assert.equal(phrases[0]?.occurrences[1]?.start, 40);
});

test("does not treat adjacent lyric repetition or a repeated backing as a vocal hook", () => {
  assert.deepEqual(findRepeatedLyricPhrases([
    words("Keep on moving all night", 0),
    words("Keep on moving all night", 3),
    words("Different words happen later", 30),
  ]), []);
  assert.deepEqual(findRepeatedLyricPhrases([]), []);
});
