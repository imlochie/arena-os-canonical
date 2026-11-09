import assert from "node:assert/strict";
import test from "node:test";

import { ANALYSIS_PCM_RATE } from "./analysis-engine";
import { labelRepeatedRhythmSections, labelSectionEnergyChanges, sectionEnergyChangeDb } from "./section-rhythm";

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

function chordTrack() {
  const pcm = new Float32Array(ANALYSIS_PCM_RATE * 12);
  const progressions = [
    [[261.63, 329.63, 392], [174.61, 220, 261.63], [196, 246.94, 293.66], [261.63, 329.63, 392]],
    [[185, 233.08, 277.18], [246.94, 311.13, 370], [277.18, 349.23, 415.3], [185, 233.08, 277.18]],
    [[261.63, 329.63, 392], [174.61, 220, 261.63], [196, 246.94, 293.66], [261.63, 329.63, 392]],
  ];
  const samplesPerBin = ANALYSIS_PCM_RATE;
  progressions.forEach((progression, binIndex) => {
    progression.forEach((frequencies, chordIndex) => {
      const sectionIndex = binIndex;
      const start = (sectionIndex * 4 + chordIndex) * samplesPerBin;
      const end = Math.min(pcm.length, start + samplesPerBin);
      for (let sample = start; sample < end; sample += 1) {
        const seconds = sample / ANALYSIS_PCM_RATE;
        pcm[sample] = frequencies.reduce(
          (sum, frequency) => sum + Math.sin(2 * Math.PI * frequency * seconds),
          0,
        ) * 0.035;
      }
    });
  });
  return pcm;
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

test("combined rhythm and harmonic evidence labels a repeated audio pattern, not a verse or chorus", () => {
  const envelope = new Float32Array(1_700);
  for (const startBeat of [0, 8, 16]) {
    for (let beat = 0; beat < 8; beat += 1) addPulse(envelope, startBeat + beat, beat % 2 === 0 ? 0 : 2);
  }

  const result = labelRepeatedRhythmSections(candidates(), beatGridMs, envelope, frameMs, chordTrack());

  assert.equal(result[0].label, "pattern-repeat-a");
  assert.equal(result[2].label, "pattern-repeat-a");
  assert.equal(result[1].label, "section");
  assert.ok(result[0].labelConfidence >= 0.92);
  assert.doesNotMatch(result[0].label, /verse|chorus/i);
});

test("same rhythm with a different harmonic sequence is not promoted to a repeated audio pattern", () => {
  const envelope = new Float32Array(1_700);
  for (const startBeat of [0, 8]) {
    for (let beat = 0; beat < 8; beat += 1) addPulse(envelope, startBeat + beat, beat % 2 === 0 ? 0 : 2);
  }

  const result = labelRepeatedRhythmSections(
    candidates().slice(0, 2),
    beatGridMs,
    envelope,
    frameMs,
    chordTrack(),
  );

  assert.ok(result.every((section) => section.label === "rhythm-repeat-a"));
  assert.ok(result.every((section) => !section.label.startsWith("pattern-repeat-")));
});

test("large sustained section-energy shifts are labeled as dynamics, never semantic roles", () => {
  const pcm = new Float32Array(ANALYSIS_PCM_RATE * 12);
  for (let sample = 0; sample < pcm.length; sample += 1) {
    const amplitude = sample < ANALYSIS_PCM_RATE * 4 ? 0.05 : 0.2;
    pcm[sample] = amplitude * Math.sin((2 * Math.PI * 220 * sample) / ANALYSIS_PCM_RATE);
  }

  const rise = labelSectionEnergyChanges(candidates(), beatGridMs, pcm);
  assert.equal(rise[0].label, "section");
  assert.equal(rise[1].label, "energy-rise");
  assert.equal(rise[1].labelConfidence, 1);
  assert.equal(rise[2].label, "section");
  assert.ok((sectionEnergyChangeDb(candidates()[0], candidates()[1], beatGridMs, pcm) ?? 0) >= 11);

  const fallingPcm = Float32Array.from(pcm, (_value, index) =>
    (index < ANALYSIS_PCM_RATE * 4 ? 0.2 : 0.05) * Math.sin((2 * Math.PI * 220 * index) / ANALYSIS_PCM_RATE),
  );
  assert.equal(labelSectionEnergyChanges(candidates(), beatGridMs, fallingPcm)[1].label, "energy-drop");
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
  assert.ok(labelSectionEnergyChanges(candidates(), beatGridMs, new Float32Array(ANALYSIS_PCM_RATE * 12))
    .every((section) => section.label === "section"));
});
