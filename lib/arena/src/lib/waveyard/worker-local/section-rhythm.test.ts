import assert from "node:assert/strict";
import test from "node:test";

import { labelRepeatedRhythmSections } from "./section-rhythm";

const beatGridMs = Array.from({ length: 33 }, (_, index) => index * 500);
const frameMs = 10;

function addPulse(envelope: Float32Array, beatIndex: number, subdivision: number, strength = 1) {
  const timeMs = beatGridMs[beatIndex] + subdivision * 125 + 25;
  envelope[Math.floor(timeMs / frameMs)] = strength;
}

function candidates() {
  return [
    { startBeatIndex: 0, endBeatIndex: 8, label: "section", labelConfidence: 0, structuralConfidence: 0.8 },
    { startBeatIndex: 8, endBeatIndex: 16, label: "section", labelConfidence: 0, structuralConfidence: 0.8 },
    { startBeatIndex: 16, endBeatIndex: 24, label: "section", labelConfidence: 0, structuralConfidence: 0.8 },
  ];
}

test("local structure analysis groups repeated rhythmic phrases without calling them verse or chorus", () => {
  const envelope = new Float32Array(1_700);
  for (const startBeat of [0, 16]) {
    for (let beat = 0; beat < 8; beat += 1) {
      addPulse(envelope, startBeat + beat, beat % 2 === 0 ? 0 : 2);
    }
  }
  for (let beat = 8; beat < 16; beat += 1) addPulse(envelope, beat, 1);

  const result = labelRepeatedRhythmSections(candidates(), beatGridMs, envelope, frameMs);

  assert.equal(result[0].label, "rhythm-repeat-a");
  assert.equal(result[2].label, "rhythm-repeat-a");
  assert.equal(result[1].label, "section");
  assert.ok(result[0].labelConfidence >= 0.92);
  assert.equal(result[0].structuralConfidence, 0.8);
});

test("flat or too-short audio evidence never creates a repeated-rhythm claim", () => {
  const uniformEnvelope = new Float32Array(1_700).fill(0.2);
  const noVariation = labelRepeatedRhythmSections(candidates(), beatGridMs, uniformEnvelope, frameMs);
  assert.ok(noVariation.every((section) => section.label === "section"));

  const short = labelRepeatedRhythmSections(
    [{ startBeatIndex: 0, endBeatIndex: 4, label: "section", labelConfidence: 0, structuralConfidence: 0.8 }],
    beatGridMs,
    new Float32Array(1_700),
    frameMs,
  );
  assert.equal(short[0].label, "section");
});
