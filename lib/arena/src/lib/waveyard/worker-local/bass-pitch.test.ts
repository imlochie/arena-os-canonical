import assert from "node:assert/strict";
import test from "node:test";

import { detectBassPitchSegments, detectVocalPitchFrames } from "./analysis-engine";

const RATE = 22_050;
const tone = (hz: number, seconds: number, amp = 0.5) => {
  const mono = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < mono.length; i += 1) {
    mono[i] = amp * (Math.sin((2 * Math.PI * hz * i) / RATE) + 0.25 * Math.sin((4 * Math.PI * hz * i) / RATE));
  }
  return mono;
};
const silence = (seconds: number) => new Float32Array(Math.round(RATE * seconds));
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const nearestMidi = (hz: number) => Math.round(69 + 12 * Math.log2(hz / 440));

test("bass pitch segments are tracked across the real electric bass range", () => {
  // E1 is a four-string bass low E; a five-string low B is 30.87 Hz.
  const cases: Array<[number, string]> = [
    [41.2, "E1"], [55, "A1"], [61.74, "B1"],
    [82.41, "E2"], [98, "G2"], [110, "A2"],
  ];
  for (const [hz, name] of cases) {
    const segments = detectBassPitchSegments(tone(hz, 1.2));
    assert.ok(segments.length >= 1, `${name} (${hz}Hz) should be tracked, saw none`);
    const first = segments[0]!;
    assert.equal(first.midiNote, nearestMidi(hz), `${name} should map to midi ${nearestMidi(hz)}`);
    assert.ok(Math.abs(first.frequencyHz - hz) / hz < 0.01,
      `${name} measured ${first.frequencyHz}Hz should be within 1% of ${hz}Hz`);
    assert.ok(first.confidence >= 0.6);
  }
});

test("a low bass note is not reported an octave up", () => {
  // Octave/subharmonic errors are the classic YIN failure. The first-valley rule
  // in the shared detector is what prevents them; assert it holds down here.
  const segments = detectBassPitchSegments(tone(41.2, 1.2));
  assert.ok(segments.length >= 1);
  assert.equal(segments[0]!.midiNote, 28, "E1 must be midi 28, not E2 (40) or E0 (16)");
});

test("silence produces no bass pitch segments", () => {
  assert.equal(detectBassPitchSegments(silence(1)).length, 0);
});

test("an unpitched gap stays a gap rather than a bridged note", () => {
  // A1, silence, then E2. Bridging would produce one impossible glide.
  const segments = detectBassPitchSegments(concat(tone(55, 0.6), silence(0.5), tone(82.41, 0.6)));
  assert.equal(segments.length, 2, `expected two separate notes, saw ${segments.length}`);
  assert.deepEqual(segments.map((segment) => segment.midiNote), [33, 40]);
  assert.ok(segments[1]!.startMs >= 1_000, "the second note starts after the gap");
});

test("the vocal detector keeps its previous range and behaviour", () => {
  // The bass work generalized the same detector; vocal defaults must not drift.
  const vocal = detectVocalPitchFrames(tone(440, 0.6));
  assert.ok(vocal.some((frame) => frame.voiced));
  assert.equal(vocal.find((frame) => frame.nearestMidiNote)?.nearestMidiNote, 69);
  // 41 Hz is below the vocal floor of 50 Hz and must stay unvoiced there.
  assert.equal(detectVocalPitchFrames(tone(41.2, 0.6)).filter((frame) => frame.voiced).length, 0);
});

test("bass pitch stays inside the persisted contract", () => {
  const segments = detectBassPitchSegments(concat(tone(55, 0.8), tone(73.42, 0.8)));
  assert.ok(segments.length >= 2);
  for (const segment of segments) {
    assert.ok(segment.startMs >= 0 && segment.endMs > segment.startMs);
    assert.ok(segment.midiNote >= 12 && segment.midiNote <= 84);
    assert.ok(segment.frequencyHz >= 30 && segment.frequencyHz <= 400);
    assert.ok(segment.confidence > 0 && segment.confidence <= 1);
  }
});
