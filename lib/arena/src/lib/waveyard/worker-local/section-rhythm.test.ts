import assert from "node:assert/strict";
import test from "node:test";

import { ANALYSIS_PCM_RATE } from "./analysis-engine";
import {
  applyRepeatedPhraseMatches,
  detectRepeatedPhraseMatches,
  labelRepeatedRhythmSections,
  labelSectionEnergyChanges,
  buildPassageFingerprint,
  buildStemActivityProfile,
  detectStemActivityBoundaryChanges,
  detectVocalActivityBoundaryChanges,
  desktopSectionCandidates,
  sectionEnergyChangeDb,
} from "./section-rhythm";
import type { StemActivityProfile } from "./section-rhythm";
import { parsePassageFingerprint } from "../types/passage-compatibility";

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

test("repeated vocal activity strengthens an audio-pattern label without claiming repeated lyrics or chorus", () => {
  const envelope = new Float32Array(1_700);
  for (const startBeat of [0, 8, 16]) {
    for (let beat = 0; beat < 8; beat += 1) addPulse(envelope, startBeat + beat, beat % 2 === 0 ? 0 : 2);
  }
  const repeatedContour = [
    { startMs: 100, endMs: 480, confidence: 0.9 },
    { startMs: 2_100, endMs: 2_480, confidence: 0.9 },
    { startMs: 8_100, endMs: 8_480, confidence: 0.9 },
    { startMs: 10_100, endMs: 10_480, confidence: 0.9 },
  ];

  const result = labelRepeatedRhythmSections(
    candidates(),
    beatGridMs,
    envelope,
    frameMs,
    chordTrack(),
    repeatedContour,
  );

  assert.equal(result[0].label, "vocal-pattern-repeat-a");
  assert.equal(result[2].label, "vocal-pattern-repeat-a");
  assert.equal(result[1].label, "section");
  assert.doesNotMatch(result[0].label, /lyrics|verse|chorus/i);
});

test("different vocal activity keeps the measured rhythm-and-chroma pattern label", () => {
  const envelope = new Float32Array(1_700);
  for (const startBeat of [0, 8, 16]) {
    for (let beat = 0; beat < 8; beat += 1) addPulse(envelope, startBeat + beat, beat % 2 === 0 ? 0 : 2);
  }
  const result = labelRepeatedRhythmSections(
    candidates(),
    beatGridMs,
    envelope,
    frameMs,
    chordTrack(),
    [
      { startMs: 100, endMs: 480, confidence: 0.9 },
      { startMs: 2_100, endMs: 2_480, confidence: 0.9 },
      { startMs: 8_100, endMs: 8_480, confidence: 0.9 },
      { startMs: 10_100, endMs: 10_480, confidence: 0.9 },
      { startMs: 8_600, endMs: 9_000, confidence: 0.9 },
      { startMs: 9_100, endMs: 9_480, confidence: 0.9 },
      { startMs: 10_600, endMs: 11_000, confidence: 0.9 },
      { startMs: 11_100, endMs: 11_480, confidence: 0.9 },
    ],
  );

  assert.equal(result[0].label, "pattern-repeat-a");
  assert.equal(result[2].label, "pattern-repeat-a");
});

test("passage fingerprint persists measured source features and marks unsupported claims unavailable", () => {
  const envelope = new Float32Array(1_700);
  for (let beat = 0; beat < 16; beat += 1) addPulse(envelope, beat, beat % 2 === 0 ? 0 : 2);
  const fingerprint = buildPassageFingerprint({
    sourceChecksumSha256: "a".repeat(64),
    startBeatIndex: 0,
    endBeatIndex: 16,
    beatGridMs: Array.from({ length: 33 }, (_, index) => index * 500),
    beatConfidence: 0.83,
    envelope,
    frameMs,
    pcm: chordTrack(),
  });
  assert.equal(fingerprint.rhythm.status, "measured");
  assert.equal(fingerprint.chroma.status, "measured");
  assert.equal(fingerprint.beatPhase.status, "measured");
  assert.equal(fingerprint.energy.status, "measured");
  assert.equal(fingerprint.downbeatConfidence.status, "unavailable");
  assert.equal(fingerprint.vocalActivity.status, "unavailable");
  assert.equal(fingerprint.instrumentalDensity.status, "unavailable");
  assert.equal(fingerprint.rollingWindows?.status, "measured");
  if (fingerprint.rollingWindows?.status === "measured") {
    assert.deepEqual(fingerprint.rollingWindows.value.map((window) => window.startBeatIndex), [0, 4, 8]);
    assert.ok(fingerprint.rollingWindows.value.every((window) =>
      window.endBeatIndex - window.startBeatIndex === 8
      && window.rhythm.status === "measured"
      && window.chroma.status === "measured",
    ));
  }
  assert.deepEqual(parsePassageFingerprint(fingerprint, {
    sourceChecksumSha256: "a".repeat(64),
    startBeatIndex: 0,
    endBeatIndex: 16,
  }), fingerprint);
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

test("fixed phrase search finds recurrence hidden inside variable novelty sections", () => {
  const envelope = new Float32Array(1_700);
  for (const startBeat of [0, 16]) {
    for (let beat = 0; beat < 8; beat += 1) addPulse(envelope, startBeat + beat, beat % 2 === 0 ? 0 : 2);
  }

  const matches = detectRepeatedPhraseMatches(beatGridMs, envelope, frameMs);
  const recurring = matches.filter((match) => match.label === "rhythm-repeat-a");

  assert.deepEqual(
    recurring.map(({ startBeatIndex, endBeatIndex }) => [startBeatIndex, endBeatIndex]),
    [[0, 16], [16, 32]],
  );
  assert.ok(recurring.every((match) => match.labelConfidence >= 0.92));
});

test("longer eight-bar recurrences take precedence over smaller overlapping loops", () => {
  const longBeatGridMs = Array.from({ length: 65 }, (_, index) => index * 500);
  const envelope = new Float32Array(3_300);
  for (const phraseStart of [0, 32]) {
    for (let beat = 0; beat < 32; beat += 1) {
      const subdivisions = beat % 4 === 0 ? [0] : beat % 4 === 2 ? [2] : beat % 8 === 6 ? [1, 3] : [];
      for (const subdivision of subdivisions) {
        const timeMs = longBeatGridMs[phraseStart + beat]! + subdivision * 125 + 25;
        envelope[Math.floor(timeMs / frameMs)] = 1;
      }
    }
  }

  const matches = detectRepeatedPhraseMatches(longBeatGridMs, envelope, frameMs);

  assert.deepEqual(
    matches.filter((match) => match.label === "rhythm-repeat-a")
      .map(({ startBeatIndex, endBeatIndex }) => [startBeatIndex, endBeatIndex]),
    [[0, 32], [32, 64]],
  );
});

test("fixed phrase search requires chroma agreement before using a pattern label", () => {
  const envelope = new Float32Array(1_700);
  for (const startBeat of [0, 8]) {
    for (let beat = 0; beat < 8; beat += 1) addPulse(envelope, startBeat + beat, beat % 2 === 0 ? 0 : 2);
  }

  const matches = detectRepeatedPhraseMatches(beatGridMs, envelope, frameMs, chordTrack());

  assert.ok(matches.length >= 2);
  assert.ok(matches.every((match) => match.label.startsWith("rhythm-repeat-")));
});

test("phrase matches split existing sections without overlapping or inventing semantic roles", () => {
  const splitCandidates = [
    { startBeatIndex: 0, endBeatIndex: 4, label: "section", labelConfidence: 0, structuralConfidence: 0.8 },
    { startBeatIndex: 4, endBeatIndex: 8, label: "section", labelConfidence: 0, structuralConfidence: 0.7 },
    { startBeatIndex: 8, endBeatIndex: 16, label: "section", labelConfidence: 0, structuralConfidence: 0.9 },
    { startBeatIndex: 16, endBeatIndex: 20, label: "section", labelConfidence: 0, structuralConfidence: 0.85 },
    { startBeatIndex: 20, endBeatIndex: 24, label: "section", labelConfidence: 0, structuralConfidence: 0.75 },
  ];
  const result = applyRepeatedPhraseMatches(splitCandidates, [
    { startBeatIndex: 0, endBeatIndex: 8, label: "pattern-repeat-a", labelConfidence: 0.96 },
    { startBeatIndex: 16, endBeatIndex: 24, label: "pattern-repeat-a", labelConfidence: 0.95 },
  ]);

  assert.deepEqual(
    result.map(({ startBeatIndex, endBeatIndex, label }) => [startBeatIndex, endBeatIndex, label]),
    [
      [0, 8, "pattern-repeat-a"],
      [8, 16, "section"],
      [16, 24, "pattern-repeat-a"],
    ],
  );
  assert.equal(result[0]?.structuralConfidence, 0.7);
  assert.equal(result[0]?.labelConfidence, 0.96);
  assert.ok(result.every((section, index) =>
    index === 0 || section.startBeatIndex >= result[index - 1]!.endBeatIndex,
  ));
  assert.ok(result.every((section) => !/verse|chorus/i.test(section.label)));
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

test("per-stem PCM adds a boundary only for a sustained activity change, not a one-bar fill", () => {
  const longGrid = Array.from({ length: 65 }, (_, index) => index * 500);
  const pcm = new Float32Array(ANALYSIS_PCM_RATE * 32);
  for (let sample = 0; sample < pcm.length; sample += 1) {
    const bar = Math.floor(sample / (ANALYSIS_PCM_RATE * 2));
    const amplitude = bar < 4 ? 0.02 : 0.16;
    pcm[sample] = amplitude * Math.sin((2 * Math.PI * 110 * sample) / ANALYSIS_PCM_RATE);
  }
  const profile = buildStemActivityProfile(pcm, longGrid, {
    stemType: "bass",
    stemAssetId: "stem-bass",
    separationJobId: "separation-current",
    stemChecksumSha256: "b".repeat(64),
  });
  assert.ok(profile);
  const changes = detectStemActivityBoundaryChanges([profile]);
  assert.deepEqual(changes.map((change) => change.beatIndex), [16]);
  assert.ok(Math.abs(changes[0]!.deltaDb) >= 6);
  const simultaneous = detectStemActivityBoundaryChanges([
    profile,
    { ...profile, stemType: "drums", stemAssetId: "stem-drums" },
  ]);
  assert.deepEqual(simultaneous.map((change) => change.stemType), ["bass", "drums"]);

  const envelope = new Float32Array(3_300);
  const sourcePcm = new Float32Array(ANALYSIS_PCM_RATE * 32);
  const candidatesWithStemEvidence = desktopSectionCandidates(longGrid, envelope, frameMs, sourcePcm, [], changes);
  assert.equal(candidatesWithStemEvidence?.find((candidate) => candidate.startBeatIndex === 16)?.label, "stem-change");
  assert.ok(candidatesWithStemEvidence?.some((candidate) => candidate.startBeatIndex === 0));
  const overlappingRepeat = desktopSectionCandidates(longGrid, envelope, frameMs, sourcePcm, [{
    startBeatIndex: 12,
    endBeatIndex: 20,
    label: "pattern-repeat-test",
    labelConfidence: 0.97,
  }], changes);
  assert.equal(overlappingRepeat?.find((candidate) => candidate.startBeatIndex === 16)?.label, "stem-change");
  assert.ok(overlappingRepeat?.some((candidate) => candidate.endBeatIndex === 16));

  const transient = new Float32Array(ANALYSIS_PCM_RATE * 32);
  for (let sample = 0; sample < transient.length; sample += 1) {
    const bar = Math.floor(sample / (ANALYSIS_PCM_RATE * 2));
    const amplitude = bar === 4 ? 0.16 : 0.02;
    transient[sample] = amplitude * Math.sin((2 * Math.PI * 110 * sample) / ANALYSIS_PCM_RATE);
  }
  const transientProfile = buildStemActivityProfile(transient, longGrid, {
    stemType: "drums",
    stemAssetId: "stem-drums",
    separationJobId: "separation-current",
    stemChecksumSha256: "c".repeat(64),
  });
  assert.ok(transientProfile);
  assert.deepEqual(detectStemActivityBoundaryChanges([transientProfile]), []);
});

test("sustained vocal entrances and dropouts add explicit event boundaries without semantic section labels", () => {
  const longGrid = Array.from({ length: 65 }, (_, index) => index * 500);
  const intervals = [{ startMs: 8_000, endMs: 20_000, confidence: 0.8 }];
  const changes = detectVocalActivityBoundaryChanges(intervals, longGrid);
  assert.deepEqual(changes.map((change) => change.beatIndex), [16, 40]);
  assert.ok(changes.every((change) => Math.abs(change.deltaCoverage) >= 0.65));

  const candidates = desktopSectionCandidates(
    longGrid,
    new Float32Array(3_300),
    frameMs,
    new Float32Array(ANALYSIS_PCM_RATE * 32),
    [],
    [],
    intervals,
  );
  assert.equal(candidates?.find((candidate) => candidate.startBeatIndex === 16)?.label, "vocal-change");
  assert.equal(candidates?.find((candidate) => candidate.startBeatIndex === 40)?.label, "vocal-change");
  assert.ok(candidates?.every((candidate) => !/verse|chorus|bridge|breakdown/i.test(candidate.label)));
});

test("vocal event coverage sorts intervals once and closes the final full bar when the beat endpoint is exclusive", () => {
  const grid = Array.from({ length: 20 }, (_, index) => index * 500);
  const changes = detectVocalActivityBoundaryChanges([
    { startMs: 7_000, endMs: 8_000, confidence: 0.8 },
    { startMs: 4_000, endMs: 7_000, confidence: 0.7 },
    { startMs: Number.NaN, endMs: 12_000, confidence: 1 },
  ], grid);
  assert.deepEqual(changes.map((change) => change.beatIndex), [8]);
  assert.equal(changes[0]?.deltaCoverage, 1);
});

test("stem activity is persisted as source-linked signal evidence, not a semantic label", () => {
  const longGrid = Array.from({ length: 65 }, (_, index) => index * 500);
  const pcm = new Float32Array(ANALYSIS_PCM_RATE * 32).fill(0.1);
  const profile = buildStemActivityProfile(pcm, longGrid, {
    stemType: "vocals",
    stemAssetId: "stem-vocals",
    separationJobId: "separation-current",
    stemChecksumSha256: "d".repeat(64),
  }) as StemActivityProfile;
  const envelope = new Float32Array(3_300);
  const fingerprint = buildPassageFingerprint({
    sourceChecksumSha256: "a".repeat(64),
    startBeatIndex: 0,
    endBeatIndex: 16,
    beatGridMs: longGrid,
    beatConfidence: 0.8,
    envelope,
    frameMs,
    pcm,
    stemActivityProfiles: [profile],
    stemActivityBoundaryChanges: [{
      beatIndex: 4,
      stemType: "vocals",
      deltaDb: -9.2,
      evidenceStrength: 0.511,
    }],
  });
  assert.equal(fingerprint.stemActivity.status, "measured");
  if (fingerprint.stemActivity.status === "measured") {
    assert.equal(fingerprint.stemActivity.value[0]?.stemType, "vocals");
    assert.equal(fingerprint.stemActivity.value[0]?.stemAssetId, "stem-vocals");
    assert.equal(fingerprint.stemActivity.value[0]?.separationJobId, "separation-current");
    assert.deepEqual(fingerprint.stemActivity.value[0]?.boundaryChanges, [{ beatIndex: 4, deltaDb: -9.2 }]);
  }
  assert.doesNotMatch(JSON.stringify(fingerprint), /chorus|verse/i);
});
