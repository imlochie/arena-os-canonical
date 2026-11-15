/**
 * Mashup brain tests — the reassurance pass for song × song and extension.
 * Signals are synthetic with KNOWN tempo/key/sections, so sync is verified
 * arithmetically: after the render, a 140 BPM vocal's onsets must land on
 * the 100 BPM bed's beat grid, key moves must be musically correct, and the
 * extension must be longer with crossfaded, non-clipping loops.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  compareMashupAlignmentCandidates,
  pitchMoveForKeys,
  planMashup,
  planSongExtension,
  renderMashup,
  renderMashupWithBus,
  renderSongExtension,
  scoreVocalChordToneFit,
  warpRatioForTempos,
  warpRatioForTempoCandidates,
  type MashupSourceProfile,
  type MashupSection,
} from "./mashup";
import {
  PASSAGE_FINGERPRINT_ENGINE,
  PASSAGE_FINGERPRINT_ENGINE_VERSION,
  unavailablePassageEvidence,
  type PassageRollingWindow,
  type PassageFingerprint,
} from "../types/passage-compatibility";

const RATE = 44_100;

function section(label: string, startMs: number, endMs: number): MashupSection {
  return { label, startMs, endMs };
}

function profile(overrides: Partial<MashupSourceProfile>): MashupSourceProfile {
  return {
    role: "instrumental",
    bpm: 120,
    bpmConfidence: 0.9,
    musicalKey: null,
    keyConfidence: overrides.musicalKey ? 0.9 : null,
    durationMs: 60_000,
    sections: [],
    ...overrides,
  };
}

function passageFingerprint(
  sourceChecksumSha256: string,
  startBeatIndex: number,
  endBeatIndex: number,
  kind: "compatible" | "different" | "near" = "compatible",
  beatPeriodMs = 500,
  rollingWindows?: PassageRollingWindow[],
): PassageFingerprint {
  const compatible = kind === "compatible";
  const measure = <T>(value: T) => ({ status: "measured" as const, value, method: "fixture", confidence: 0.95 });
  return {
    schemaVersion: 3,
    engine: PASSAGE_FINGERPRINT_ENGINE,
    engineVersion: PASSAGE_FINGERPRINT_ENGINE_VERSION,
    sourceChecksumSha256,
    startBeatIndex,
    endBeatIndex,
    rhythm: measure(Array.from({ length: (endBeatIndex - startBeatIndex) * 4 }, (_, index) =>
      kind === "near" && index % 4 === 1 ? 0.5 : Number(index % 4 === (compatible ? 0 : 1)))),
    chroma: measure(Array.from({ length: 48 }, (_, index) => {
      const pitch = index % 12;
      return pitch === 0 ? 1 : pitch === 4 ? 0.75 : pitch === 7 ? 0.5 : 0.02;
    })),
    beatPhase: measure({
      subdivisionProfile: compatible ? [0.9, 0.05, 0.03, 0.02]
        : kind === "near" ? [0.7, 0.65, 0.03, 0.02] : [0.03, 0.9, 0.05, 0.02],
      beatPeriodMs,
    }),
    energy: measure({ rmsDb: -12 }),
    downbeatConfidence: measure(0.95),
    vocalActivity: unavailablePassageEvidence("not available in this fixture"),
    instrumentalDensity: unavailablePassageEvidence("not available in this fixture"),
    stemActivity: unavailablePassageEvidence("not available in this fixture"),
    ...(rollingWindows
      ? { rollingWindows: measure(rollingWindows) }
      : {}),
  };
}

function rollingWindow(startBeatIndex: number, endBeatIndex: number, kind: "compatible" | "different" = "compatible"): PassageRollingWindow {
  const fingerprint = passageFingerprint("r".repeat(64), startBeatIndex, endBeatIndex, kind);
  return {
    startBeatIndex,
    endBeatIndex,
    rhythm: fingerprint.rhythm,
    chroma: fingerprint.chroma,
    beatPhase: fingerprint.beatPhase,
  };
}

// --- tempo warping ---------------------------------------------------------

test("warp ratio: near-equal tempos stretch lightly", () => {
  assert.ok(Math.abs(warpRatioForTempos(102, 100) - 1.02) < 1e-9, "2% off is NOT a lock — it stretches");
});

test("warp ratio: half/double locks snap to the nearest-to-1 lock", () => {
  assert.equal(warpRatioForTempos(140, 70), 1, "140 over 70 is a double lock — stay at 1.0 (half-time feel)");
  assert.equal(warpRatioForTempos(71, 141), 1, "71 over 141 is a half lock — stay at 1.0");
  assert.equal(warpRatioForTempos(70, 140), 1, "70 over 140 = exact half relationship → natural speed (half-time feel)");
  assert.equal(warpRatioForTempos(200, 100), 1, "200 over 100 = exact double relationship → natural speed (double-time feel)");
  assert.ok(Math.abs(warpRatioForTempos(140.5, 70) - 1) < 1e-9, "140.5 over 70 is within 1% of 2:1 → natural speed");
});

test("warp ratio: clamps extreme mismatches to 0.5–2", () => {
  assert.equal(warpRatioForTempos(300, 100), 2);
  assert.equal(warpRatioForTempos(40, 100), 0.5);
});

// --- key moves -------------------------------------------------------------

test("key moves: same key stays, fifth shifts by tonic distance, relative stays", () => {
  assert.deepEqual(pitchMoveForKeys("C major", "C major"), { semitones: 0, relationship: "same" });
  // G major vocals over C major bed: shift +7 wraps to -5 (fifth down).
  const fifth = pitchMoveForKeys("G major", "C major");
  assert.equal(fifth.relationship, "fifth");
  assert.ok(Math.abs(fifth.semitones) === 5, `fifth shift should be ±5, got ${fifth.semitones}`);
  // C major over A minor: relative — same scale, no shift.
  assert.deepEqual(pitchMoveForKeys("C major", "A minor"), { semitones: 0, relationship: "relative" });
  // Unknown key: honest.
  assert.deepEqual(pitchMoveForKeys(null, "A minor"), { semitones: 0, relationship: "unknown" });
});

// --- planning --------------------------------------------------------------

test("plan: bed owns the tempo, vocal stretch + entry are explained", () => {
  const result = planMashup(
    profile({ role: "vocals", bpm: 140, musicalKey: "C major", durationMs: 30_000, sections: [section("verse", 4000, 20_000)] }),
    profile({ role: "instrumental", bpm: 100, musicalKey: "C major", durationMs: 60_000, sections: [section("intro", 0, 8000), section("verse", 8000, 30_000)] }),
  );
  assert.ok(result.ok);
  const { plan } = result;
  assert.equal(plan.masterBpm, 100);
  assert.ok(Math.abs(plan.vocalsStretchRatio - 1.4) < 1e-9, "140→100 BPM = stretch ×1.4");
  assert.equal(plan.vocalsPitchSemitones, 0);
  // Entry at the bed's first body section, not the intro.
  assert.equal(plan.segments[0].mashupStartMs, 8000);
  // Vocal body 4–20s stretched ×1.4 = 22.4s from 8s.
  assert.ok(Math.abs(plan.segments[0].mashupEndMs - 8000 - 16_000 * 1.4) < 1, `${plan.segments[0].mashupEndMs}`);
  assert.equal(plan.durationMs, 60_000);
  assert.ok(plan.rationale.length >= 4, "every decision is explained");
  assert.ok(plan.rationale.some((line) => line.includes("master tempo")));
});

test("alignment lab keeps continuous timing separate and requires real downbeat evidence", () => {
  const vocals = profile({
    role: "vocals",
    bpm: 120,
    bpmConfidence: 0.9,
    beatConfidence: 0.9,
    beatGridMs: Array.from({ length: 41 }, (_, index) => index * 500),
    durationMs: 20_000,
    sections: [section("verse", 0, 15_000)],
  });
  const bed = profile({
    role: "instrumental",
    bpm: 120,
    bpmConfidence: 0.9,
    beatConfidence: 0.9,
    beatGridMs: Array.from({ length: 61 }, (_, index) => index * 500),
    durationMs: 30_000,
    sections: [section("intro", 0, 4_400), section("chorus", 4_400, 30_000)],
  });

  const continuous = planMashup(vocals, bed, { strategy: "continuous" });
  assert.ok(continuous.ok);
  assert.equal(continuous.plan.segments[0].mashupStartMs, 4_500);
  assert.equal(continuous.plan.segments[0].localTempoMap, undefined);
  assert.ok(continuous.plan.rationale.some((line) => line.includes("continuous baseline")));

  const unavailableDownbeat = planMashup(vocals, bed, { strategy: "downbeat" });
  assert.equal(unavailableDownbeat.ok, false);
  if (!unavailableDownbeat.ok) assert.match(unavailableDownbeat.reason, /will not infer bar starts/i);

  const measuredDownbeat = planMashup(vocals, {
    ...bed,
    downbeatGridMs: Array.from({ length: 16 }, (_, index) => index * 2_000),
    downbeatConfidence: 0.9,
  }, { strategy: "downbeat" });
  assert.ok(measuredDownbeat.ok);
  assert.equal(measuredDownbeat.plan.segments[0].mashupStartMs, 6_000);
  assert.ok(measuredDownbeat.plan.rationale.some((line) => line.includes("measured bed downbeat")));

  const candidates = compareMashupAlignmentCandidates(vocals, bed);
  assert.equal(candidates.find((candidate) => candidate.id === "continuous")?.available, true);
  assert.equal(candidates.find((candidate) => candidate.id === "downbeat")?.available, false);
  assert.match(candidates.find((candidate) => candidate.id === "downbeat")?.unavailableReason ?? "", /confidence of at least 0.65/i);
});

test("plan labels source-mix harmony fallback instead of implying isolated-bed analysis", () => {
  const result = planMashup(
    profile({ role: "vocals", bpm: 120, musicalKey: "C major" }),
    profile({ role: "instrumental", bpm: 120, musicalKey: "C major", harmonyEvidenceSource: "source-mix" }),
  );
  assert.ok(result.plan.warnings.some((warning) => warning.includes("full source mix")
    && warning.includes("separated bed-stem chord analysis")));
});

test("plan discloses when chord fit comes from one isolated layer rather than a summed bed", () => {
  const result = planMashup(
    profile({ role: "vocals", bpm: 120 }),
    profile({
      role: "instrumental",
      bpm: 120,
      harmonyEvidenceSource: "separated-stem",
      harmonyEvidenceStemType: "other",
    }),
  );
  assert.ok(result.plan.warnings.some((warning) => warning.includes("separated other stem")
    && warning.includes("complete summed instrumental bed")));
});

test("plan: voiced-run timing keeps safety padding and aligns the entrance to a measured bed beat", () => {
  const result = planMashup(
    profile({
      role: "vocals",
      durationMs: 60_000,
      vocalPhrases: [
        { startMs: 2_500, endMs: 5_000, confidence: 0.92 },
        { startMs: 7_000, endMs: 10_000, confidence: 0.88 },
      ],
    }),
    profile({
      role: "instrumental",
      bpm: 120,
      bpmConfidence: 0.9,
      beatConfidence: 0.9,
      beatGridMs: Array.from({ length: 121 }, (_, index) => 100 + index * 500),
      durationMs: 60_000,
      sections: [section("intro", 0, 8_500), section("chorus", 8_500, 60_000)],
    }),
  );

  assert.ok(result.ok);
  const [segment] = result.plan.segments;
  assert.equal(segment.vocalsFromMs, 2_250);
  assert.equal(segment.vocalsToMs, 10_250);
  assert.equal(segment.mashupStartMs, 8_600);
  assert.ok(result.plan.rationale.some((line) => line.includes("measured voiced activity")));
  assert.ok(result.plan.rationale.some((line) => line.includes("measured bed beat")));
  assert.ok(result.plan.rationale.some((line) => line.includes("word, syllable, and lyrical-meaning timing are not analyzed")));
  assert.ok(!result.plan.warnings.some((line) => line.includes("No current isolated-vocal voicing intervals")));
});

test("plan: isolated transient coincidence cannot move the entry without a compatible passage match", () => {
  const attacks = [750, 1_750, 2_750].map((timestampMs) => ({
    timestampMs,
    strength: 0.8,
    confidence: 0.9,
  }));
  const result = planMashup(
    profile({
      role: "vocals",
      durationMs: 30_000,
      vocalPhrases: [
        { startMs: 5_000, endMs: 5_500, confidence: 0.9 },
        { startMs: 6_000, endMs: 6_500, confidence: 0.9 },
        { startMs: 7_000, endMs: 7_500, confidence: 0.9 },
      ],
    }),
    profile({
      bpm: 120,
      bpmConfidence: 0.9,
      beatConfidence: 0.9,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [section("verse", 0, 60_000)],
      drumEvents: attacks,
      bassEvents: attacks,
    }),
  );

  assert.ok(result.ok);
  assert.equal(result.plan.segments[0]!.mashupStartMs, 0,
    "without checksum-current cross-song passage fingerprints, keep the measured structural entry instead of chasing attack coincidence");
  assert.ok(result.plan.rationale.some((line) =>
    line.includes("0/3 pitch-continuity run starts overlap measured drum transients")
    && line.includes("0/3 overlap low-band bass attacks")
    && line.includes("transient coincidences alone do not shift this passage-entry fallback"),
  ));
  assert.ok(result.plan.warnings.some((line) =>
    line.includes("measured-beat fallback"),
  ));
});

test("plan: different complete whole-bar lengths are ranked as contextual layering candidates", () => {
  const checksumDonor = "d".repeat(64);
  const checksumBed = "b".repeat(64);
  const attacks = [9_050, 10_050, 11_050].map((timestampMs) => ({
    timestampMs,
    strength: 0.8,
    confidence: 0.9,
  }));
  const result = planMashup(
    profile({
      role: "vocals",
      sourceChecksumSha256: checksumDonor,
      bpm: 120,
      bpmConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [{
        id: "donor-16-beats",
        label: "section",
        startMs: 0,
        endMs: 8_000,
        startBeatIndex: 0,
        endBeatIndex: 16,
        passageFingerprint: passageFingerprint(checksumDonor, 0, 16),
      }],
      vocalPhrases: [
        { startMs: 1_000, endMs: 1_500, confidence: 0.95 },
        { startMs: 2_000, endMs: 2_500, confidence: 0.95 },
        { startMs: 3_000, endMs: 3_500, confidence: 0.95 },
      ],
    }),
    profile({
      role: "instrumental",
      sourceChecksumSha256: checksumBed,
      bpm: 120,
      bpmConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [{
        id: "bed-12-beats",
        label: "section",
        startMs: 8_000,
        endMs: 14_000,
        startBeatIndex: 16,
        endBeatIndex: 28,
        passageFingerprint: passageFingerprint(checksumBed, 16, 28),
      }],
      bassEvents: attacks,
    }),
  );

  assert.ok(result.ok);
  const evaluation = result.plan.passageSearch?.evaluations[0];
  assert.equal(evaluation?.status, "ranked");
  assert.equal(evaluation?.bestBedSectionId, "bed-12-beats");
  assert.ok((evaluation?.relativeScore ?? 0) > 0);
  assert.ok(result.plan.rationale.some((line) =>
    line.includes("duration similarity") && line.includes("0.750"),
  ));
  assert.ok(result.plan.warnings.some((line) =>
    line.includes("relative evidence ranking")
    && line.includes("not calibrated or listener-validated"),
  ));
});

test("plan: a strong cross-song passage match chooses the bed section; bass attacks only break a musical-score tie", () => {
  const checksumDonor = "d".repeat(64);
  const checksumBed = "b".repeat(64);
  const donorFingerprint = passageFingerprint(checksumDonor, 0, 16, "compatible", 600);
  const vocalSection: MashupSection = {
    id: "donor-vocal-section",
    label: "section",
    startMs: 0,
    endMs: 9_600,
    startBeatIndex: 0,
    endBeatIndex: 16,
    passageFingerprint: donorFingerprint,
  };
  const bedSections: MashupSection[] = [
    {
      id: "bed-conflict",
      label: "section",
      startMs: 0,
      endMs: 8_000,
      startBeatIndex: 0,
      endBeatIndex: 16,
      passageFingerprint: passageFingerprint(checksumBed, 0, 16, "different"),
    },
    {
      id: "bed-compatible-quiet",
      label: "section",
      startMs: 8_000,
      endMs: 16_000,
      startBeatIndex: 16,
      endBeatIndex: 32,
      passageFingerprint: passageFingerprint(checksumBed, 16, 32),
    },
    {
      id: "bed-compatible-groove",
      label: "section",
      startMs: 16_000,
      endMs: 24_000,
      startBeatIndex: 32,
      endBeatIndex: 48,
      passageFingerprint: passageFingerprint(checksumBed, 32, 48),
    },
  ];
  const attacks = [16_250, 17_250, 18_250].map((timestampMs) => ({
    timestampMs, strength: 0.8, confidence: 0.9,
  }));
  const result = planMashup(
    profile({
      role: "vocals",
      sourceAssetId: "donor-source",
      sourceChecksumSha256: checksumDonor,
      bpm: 100,
      bpmConfidence: 0.95,
      musicalKey: "C major",
      keyConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 101 }, (_, index) => index * 600),
      durationMs: 60_000,
      sections: [vocalSection],
      vocalPhrases: [
        { startMs: 1_000, endMs: 1_500, confidence: 0.95 },
        { startMs: 2_000, endMs: 2_500, confidence: 0.95 },
        { startMs: 3_000, endMs: 3_500, confidence: 0.95 },
      ],
    }),
    profile({
      role: "instrumental",
      sourceAssetId: "bed-source",
      sourceChecksumSha256: checksumBed,
      bpm: 120,
      bpmConfidence: 0.95,
      musicalKey: "C major",
      keyConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: bedSections,
      bassEvents: attacks,
    }),
  );
  assert.ok(result.ok);
  assert.ok(Math.abs(result.plan.vocalsStretchRatio - (100 / 120)) < 1e-9,
    "trusted different tempos are adapted rather than rejected when passage-level rhythm, chroma, and phase match");
  assert.equal(result.plan.segments[0]!.mashupStartMs, 8_625,
    "the whole donor passage offset maps the section start while retaining the vocal safety pad");
  assert.ok(result.plan.rationale.some((line) =>
    line.includes("aligned voice-bearing donor section donor-vocal-section")
    && line.includes("Onset-pattern cosine")
    && line.includes("transient alignment only breaks near-ties"),
  ), JSON.stringify({ rationale: result.plan.rationale, warnings: result.plan.warnings }));
  assert.ok(result.plan.warnings.some((line) =>
    line.includes("relative evidence ranking")
    && line.includes("does not establish a good-sounding arrangement"),
  ));
});

test("plan: weak measured passage candidates are ranked rather than treated as a mashup gate", () => {
  const checksumDonor = "d".repeat(64);
  const checksumBed = "b".repeat(64);
  const result = planMashup(
    profile({
      role: "vocals",
      sourceAssetId: "weak-donor",
      sourceChecksumSha256: checksumDonor,
      bpm: 120,
      bpmConfidence: 0.95,
      musicalKey: "C major",
      keyConfidence: 0.95,
      beatConfidence: 0.95,
      durationMs: 60_000,
      sections: [{
        id: "weak-donor-section",
        label: "section",
        startMs: 0,
        endMs: 8_000,
        startBeatIndex: 0,
        endBeatIndex: 16,
        passageFingerprint: passageFingerprint(checksumDonor, 0, 16),
      }],
      vocalPhrases: [
        { startMs: 1_000, endMs: 1_500, confidence: 0.95 },
        { startMs: 2_000, endMs: 2_500, confidence: 0.95 },
        { startMs: 3_000, endMs: 3_500, confidence: 0.95 },
      ],
    }),
    profile({
      role: "instrumental",
      sourceAssetId: "weak-bed",
      sourceChecksumSha256: checksumBed,
      bpm: 120,
      bpmConfidence: 0.95,
      musicalKey: "C major",
      keyConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [
        {
          id: "weak-bed-lower-ranked",
          label: "section",
          startMs: 0,
          endMs: 8_000,
          startBeatIndex: 0,
          endBeatIndex: 16,
          passageFingerprint: passageFingerprint(checksumBed, 0, 16, "different"),
        },
        {
          id: "weak-bed-best-available",
          label: "section",
          startMs: 8_000,
          endMs: 16_000,
          startBeatIndex: 16,
          endBeatIndex: 32,
          passageFingerprint: passageFingerprint(checksumBed, 16, 32, "near"),
        },
      ],
    }),
  );
  assert.ok(result.ok, "an imperfect measured passage comparison must not block mashup creation");
  assert.equal(result.plan.segments[0]!.mashupStartMs, 8_750,
    "the selected bed section is aligned to the donor passage while retaining the vocal safety pad");
  assert.ok(result.plan.rationale.some((line) =>
    line.includes("aligned voice-bearing donor section weak-donor-section")
    && line.includes("Onset-pattern cosine")
    && line.includes("required ≥ 0.92"),
  ));
  assert.ok(result.plan.warnings.some((line) =>
    line.includes("relative evidence ranking")
    && line.includes("not calibrated or listener-validated"),
  ));
});

test("plan: time-normalized shape evidence can rank a 4-bar vocal passage against a different-length bed section", () => {
  const checksumDonor = "e".repeat(64);
  const checksumBed = "f".repeat(64);
  const rhythmShape = (beats: number) => Array.from({ length: beats * 4 }, (_, index) => {
    const position = index / (beats * 4);
    return Math.sin(position * Math.PI * 8) + Math.cos(position * Math.PI * 4) * 0.4;
  });
  const donorFingerprint = passageFingerprint(checksumDonor, 0, 16);
  const bedFingerprint = passageFingerprint(checksumBed, 16, 36);
  donorFingerprint.rhythm = {
    status: "measured",
    value: rhythmShape(16),
    method: "normalized fixture shape",
    confidence: 0.95,
  };
  bedFingerprint.rhythm = {
    status: "measured",
    value: rhythmShape(20),
    method: "normalized fixture shape",
    confidence: 0.95,
  };

  const result = planMashup(
    profile({
      role: "vocals",
      sourceAssetId: "variable-donor",
      sourceChecksumSha256: checksumDonor,
      bpm: 120,
      bpmConfidence: 0.95,
      musicalKey: "C major",
      keyConfidence: 0.95,
      beatConfidence: 0.95,
      durationMs: 60_000,
      sections: [{
        id: "donor-four-bars",
        label: "section",
        startMs: 0,
        endMs: 8_000,
        startBeatIndex: 0,
        endBeatIndex: 16,
        passageFingerprint: donorFingerprint,
      }],
      vocalPhrases: [
        { startMs: 1_000, endMs: 1_500, confidence: 0.95 },
        { startMs: 3_000, endMs: 3_500, confidence: 0.95 },
        { startMs: 5_000, endMs: 5_500, confidence: 0.95 },
      ],
    }),
    profile({
      role: "instrumental",
      sourceAssetId: "variable-bed",
      sourceChecksumSha256: checksumBed,
      bpm: 120,
      bpmConfidence: 0.95,
      musicalKey: "C major",
      keyConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [{
        id: "bed-five-bars",
        label: "section",
        startMs: 8_000,
        endMs: 18_000,
        startBeatIndex: 16,
        endBeatIndex: 36,
        passageFingerprint: bedFingerprint,
      }],
    }),
  );

  assert.ok(result.ok);
  assert.equal(result.plan.passageSearch?.selectedDonorSectionId, "donor-four-bars");
  assert.equal(result.plan.passageSearch?.selectedBedSectionId, "bed-five-bars");
  assert.ok(result.plan.passageSearch?.evaluations[0]?.rankedBedCandidates[0]?.relativeScore,
    "a non-identical but measured window should receive a relative score");
  assert.ok(result.plan.rationale.some((line) =>
    line.includes("duration similarity") && line.includes("0.800"),
  ));
});

test("plan: evaluates every full-track vocal passage and can select a later repeated hook without trimming earlier vocals", () => {
  const checksumDonor = "d".repeat(64);
  const checksumBed = "b".repeat(64);
  const result = planMashup(
    profile({
      role: "vocals",
      sourceAssetId: "whole-track-donor",
      sourceChecksumSha256: checksumDonor,
      bpm: 120,
      bpmConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [
        {
          id: "donor-verse",
          label: "section",
          startMs: 0,
          endMs: 8_000,
          startBeatIndex: 0,
          endBeatIndex: 16,
          passageFingerprint: passageFingerprint(checksumDonor, 0, 16, "different"),
        },
        {
          id: "donor-chorus-repeat-1",
          label: "section",
          startMs: 20_000,
          endMs: 28_000,
          startBeatIndex: 40,
          endBeatIndex: 56,
          passageFingerprint: passageFingerprint(checksumDonor, 40, 56),
        },
        {
          id: "donor-chorus-repeat-2",
          label: "section",
          startMs: 40_000,
          endMs: 48_000,
          startBeatIndex: 80,
          endBeatIndex: 96,
          passageFingerprint: passageFingerprint(checksumDonor, 80, 96, "different"),
        },
      ],
      vocalPhrases: [
        { startMs: 1_000, endMs: 1_800, confidence: 0.95 },
        { startMs: 21_000, endMs: 21_800, confidence: 0.95 },
        { startMs: 41_000, endMs: 41_800, confidence: 0.95 },
      ],
    }),
    profile({
      role: "instrumental",
      sourceAssetId: "whole-track-bed",
      sourceChecksumSha256: checksumBed,
      bpm: 120,
      bpmConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [
        {
          id: "bed-verse",
          label: "section",
          startMs: 8_000,
          endMs: 16_000,
          startBeatIndex: 16,
          endBeatIndex: 32,
          passageFingerprint: passageFingerprint(checksumBed, 16, 32),
        },
        {
          id: "bed-hook",
          label: "section",
          startMs: 30_000,
          endMs: 38_000,
          startBeatIndex: 60,
          endBeatIndex: 76,
          passageFingerprint: passageFingerprint(checksumBed, 60, 76),
        },
        {
          id: "bed-later-hook",
          label: "section",
          startMs: 50_000,
          endMs: 58_000,
          startBeatIndex: 100,
          endBeatIndex: 116,
          passageFingerprint: passageFingerprint(checksumBed, 100, 116),
        },
      ],
    }),
  );

  assert.ok(result.ok);
  const search = result.plan.passageSearch!;
  assert.equal(search.evaluatedDonorPassageCount, 3);
  assert.equal(search.rankableDonorPassageCount, 3);
  assert.deepEqual(search.evaluations.map((evaluation) => evaluation.donorSectionId), [
    "donor-verse",
    "donor-chorus-repeat-1",
    "donor-chorus-repeat-2",
  ], "repeated hooks remain separate donor candidates");
  assert.equal(search.selectedDonorSectionId, "donor-chorus-repeat-1");
  assert.equal(search.selectedBedSectionId, "bed-hook");
  const selectedPassage = search.evaluations.find((evaluation) => evaluation.selected)!;
  assert.equal(
    selectedPassage.rankedBedCandidates?.[0]?.bedSectionId,
    selectedPassage.bestBedSectionId,
  );
  assert.equal(selectedPassage.rankedBedCandidates?.[0]?.selected, true);
  assert.equal(
    selectedPassage.rankedBedCandidates?.[0]?.bedSourceSha256,
    checksumBed,
  );
  assert.deepEqual(
    selectedPassage.rankedBedCandidates?.map((candidate) => candidate.rank),
    selectedPassage.rankedBedCandidates?.map((_, index) => index + 1),
  );
  assert.ok(Math.abs(result.plan.segments[0]!.mashupStartMs - 10_750) <= 1);
  assert.equal(result.plan.segments[0]!.vocalsFromMs, 750,
    "selecting a later musical passage does not cut off the earlier verse");
  assert.equal(search.evaluations.filter((evaluation) => evaluation.selected).length, 1);
  assert.ok(result.plan.warnings.some((warning) =>
    warning.includes("not calibrated or listener-validated"),
  ), "a relative structural rank is not presented as proven arrangement quality");
});

test("plan: compares a voiced-activity window with a later beat-window inside a longer bed section", () => {
  const checksumDonor = "d".repeat(64);
  const checksumBed = "b".repeat(64);
  const donorSectionFingerprint = passageFingerprint(checksumDonor, 0, 16, "different", 500, [
    rollingWindow(0, 8, "different"),
    rollingWindow(4, 12, "compatible"),
    rollingWindow(8, 16, "compatible"),
  ]);
  const bedSectionFingerprint = passageFingerprint(checksumBed, 0, 32, "different", 500, [
    rollingWindow(0, 8, "different"),
    rollingWindow(4, 12, "different"),
    rollingWindow(8, 16, "different"),
    rollingWindow(12, 20, "different"),
    rollingWindow(16, 24, "compatible"),
    rollingWindow(20, 28, "different"),
    rollingWindow(24, 32, "different"),
  ]);
  const result = planMashup(
    profile({
      role: "vocals",
      sourceChecksumSha256: checksumDonor,
      bpm: 120,
      bpmConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [{
        id: "donor-long",
        label: "section",
        startMs: 0,
        endMs: 8_000,
        startBeatIndex: 0,
        endBeatIndex: 16,
        passageFingerprint: donorSectionFingerprint,
      }],
      vocalPhrases: [{ startMs: 4_200, endMs: 5_000, confidence: 0.95 }],
    }),
    profile({
      role: "instrumental",
      sourceChecksumSha256: checksumBed,
      bpm: 120,
      bpmConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [{
        id: "bed-long",
        label: "section",
        startMs: 0,
        endMs: 16_000,
        startBeatIndex: 0,
        endBeatIndex: 32,
        passageFingerprint: bedSectionFingerprint,
      }],
    }),
  );

  assert.ok(result.ok);
  const selected = result.plan.passageSearch?.evaluations.find((evaluation) => evaluation.selected);
  assert.equal(selected?.bestBedSectionId, "bed-long");
  assert.equal(selected?.rankedBedCandidates?.[0]?.bedStartMs, 8_000,
    "the later local match must be surfaced even though it sits inside one longer bed section");
  assert.ok(result.plan.rationale.some((line) =>
    line.includes("eight-beat local voiced-activity window")
    && line.includes("not lyric timing"),
  ));
  assert.equal(selected?.rankedBedCandidates?.[0]?.similarities.vocalChordFit, null,
    "without current isolated-vocal pitch and bed chord evidence, the extra ranking cue stays unavailable");
});

test("plan: measured vocal notes rank the chord-fitting local bed window without making evidence a gate", () => {
  const checksumDonor = "d".repeat(64);
  const checksumBed = "b".repeat(64);
  const vocalFrames = Array.from({ length: 32 }, (_, index) => {
    const nearestMidiNote = [60, 64, 67][index % 3]!;
    return {
      timestampMs: 250 + index * 100,
      frequencyHz: 440 * 2 ** ((nearestMidiNote - 69) / 12),
      midiFloat: nearestMidiNote,
      nearestMidiNote,
      confidence: 0.95,
      voiced: true,
    };
  });
  const result = planMashup(
    profile({
      role: "vocals",
      sourceChecksumSha256: checksumDonor,
      bpm: 120,
      bpmConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [{
        id: "donor-vocal",
        label: "section",
        startMs: 0,
        endMs: 4_000,
        startBeatIndex: 0,
        endBeatIndex: 8,
        passageFingerprint: passageFingerprint(
          checksumDonor,
          0,
          8,
          "compatible",
          500,
          [rollingWindow(0, 8)],
        ),
      }],
      vocalPhrases: [{ startMs: 250, endMs: 3_450, confidence: 0.95 }],
      vocalPitchFrames: vocalFrames,
    }),
    profile({
      role: "instrumental",
      sourceChecksumSha256: checksumBed,
      bpm: 120,
      bpmConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [{
        id: "bed-two-windows",
        label: "section",
        startMs: 0,
        endMs: 8_000,
        startBeatIndex: 0,
        endBeatIndex: 16,
        passageFingerprint: passageFingerprint(
          checksumBed,
          0,
          16,
          "compatible",
          500,
          [rollingWindow(0, 8), rollingWindow(8, 16)],
        ),
      }],
      harmonyEvents: [
        // Current local harmony rows store the accepted top-two template margin;
        // this is deliberately not a calibrated probability.
        { startMs: 0, endMs: 4_000, root: "C", quality: "major", confidence: 0.05 },
        { startMs: 4_000, endMs: 8_000, root: "F#", quality: "major", confidence: 0.05 },
      ],
    }),
  );

  assert.ok(result.ok);
  const selected = result.plan.passageSearch?.evaluations.find((evaluation) => evaluation.selected);
  const ranked = selected?.rankedBedCandidates;
  assert.equal(ranked?.[0]?.bedStartMs, 0,
    "equally rhythmic/chromatic windows prefer the one whose measured chord supports the vocal notes");
  assert.equal(ranked?.[0]?.similarities.vocalChordFit, 1);
  assert.equal(ranked?.[0]?.similarities.vocalChordCoverage, 1);
  assert.equal(ranked?.[1]?.bedStartMs, 4_000);
  assert.equal(ranked?.[1]?.similarities.vocalChordFit, 0);
  assert.ok(result.plan.warnings.some((warning) => warning.includes("not calibrated or listener-validated")),
    "the new relative cue must not be described as verified arrangement quality");
});

for (const rolling of [true, false]) {
  test(`plan: ${rolling ? "rolling" : "section"} discovery scores later vocals, not only the locally fitting opening`, () => {
    const donorHash = "d".repeat(64);
    const bedHash = "b".repeat(64);
    const vocalFrames = Array.from({ length: 72 }, (_, index) => ({
      timestampMs: 250 + index * 100,
      frequencyHz: 261.625565,
      midiFloat: 60,
      nearestMidiNote: 60,
      confidence: 0.95,
      voiced: true,
    }));
    const makeSection = (id: string, startMs: number, hash: string): MashupSection => ({
      id, label: "section", startMs, endMs: startMs + 4_000,
      startBeatIndex: startMs / 500, endBeatIndex: startMs / 500 + 8,
      passageFingerprint: passageFingerprint(
        hash, startMs / 500, startMs / 500 + 8, "compatible", 500,
        rolling ? [rollingWindow(startMs / 500, startMs / 500 + 8)] : [],
      ),
    });
    const vocals = profile({
      role: "vocals", sourceChecksumSha256: donorHash, durationMs: 8_000,
      beatGridMs: Array.from({ length: 17 }, (_, i) => i * 500),
      beatConfidence: 0.95,
      sections: [makeSection("donor-opening", 0, donorHash), section("section", 4_000, 8_000)],
      vocalPhrases: [
        { startMs: 250, endMs: 3_450, confidence: 0.95 },
        { startMs: 4_250, endMs: 7_450, confidence: 0.95 },
      ],
      vocalPitchFrames: vocalFrames,
    });
    const bed = profile({
      sourceChecksumSha256: bedHash, durationMs: 20_000,
      beatGridMs: Array.from({ length: 41 }, (_, i) => i * 500),
      beatConfidence: 0.95,
      sections: [makeSection("misleading-opening", 0, bedHash), makeSection("sustained-support", 8_000, bedHash)],
      harmonyEvents: [
        { startMs: 0, endMs: 4_000, root: "C", quality: "major", confidence: 0.05 },
        { startMs: 4_000, endMs: 8_000, root: "F#", quality: "major", confidence: 0.05 },
        { startMs: 8_000, endMs: 20_000, root: "C", quality: "major", confidence: 0.05 },
      ],
    });
    const result = planMashup(vocals, bed);
    assert.ok(result.ok);
    assert.equal(result.plan.passageSearch?.selectedBedSectionId, "sustained-support");
    const ranking = result.plan.passageSearch?.evaluations.find(item => item.selected)?.rankedBedCandidates;
    assert.equal(ranking?.[0]?.similarities.vocalChordFit, 1);
    assert.ok((ranking?.[1]?.similarities.vocalChordFit ?? 1) < 0.6,
      "later unsupported notes remain visible even though both discovery windows fit perfectly");
    assert.equal(result.plan.segments[0]?.mashupStartMs, 8_000);
    assert.equal(result.plan.segments[0]?.vocalsFromMs, 0);
    // The late reprise is grounded in the donor's own final pitch-continuity run
    // (4250–7450ms), not a replay of the opening material; the primary body
    // segment already carries the full 0–7700ms body, so every run is audible.
    assert.equal(result.plan.segments.at(-1)?.vocalsFromMs, 4_250);
    assert.equal(result.plan.segments.at(-1)?.vocalsToMs, 7_450);
    assert.ok(result.plan.segments.at(-1)?.rationale.includes("closing-vocal echo"),
      "the reprise is labelled a closing echo, not an intelligent reprise of the opening");
    assert.equal(result.plan.segments[0]?.vocalsFromMs, 0);
    assert.equal(result.plan.segments[0]?.vocalsToMs, 7_700, "the complete vocal body is placed exactly once");
    const rendered = renderMashup(result.plan, {
      vocals: new Float32Array(8 * 8_000 * 2).fill(0.2),
      bed: new Float32Array(20 * 8_000 * 2),
      sampleRate: 8_000,
    });
    assert.equal(rendered.subarray(0, 8 * 8_000 * 2).some(value => value !== 0), false,
      "the actual renderer uses the improved placement, not the old opening");
    assert.ok(rendered.subarray(9 * 8_000 * 2, 10 * 8_000 * 2).some(value => value > 0.01));
    const fallback = planMashup({ ...vocals, vocalPitchFrames: undefined }, { ...bed, harmonyEvents: undefined });
    assert.ok(fallback.ok, "missing pitch/chord observations never block generation");
    assert.equal(fallback.plan.passageSearch?.selectedBedSectionId, "misleading-opening",
      "without evidence the earlier deterministic ordering is preserved");
  });
}

test("vocal-to-chord fit applies the planned transposition before comparing pitch classes", () => {
  const vocalFrames = Array.from({ length: 10 }, (_, index) => {
    const nearestMidiNote = [60, 64, 67][index % 3]!;
    return {
      timestampMs: index * 100,
      frequencyHz: 440 * 2 ** ((nearestMidiNote - 69) / 12),
      midiFloat: nearestMidiNote,
      nearestMidiNote,
      confidence: 0.95,
      voiced: true,
    };
  });
  const bedChords = [{ startMs: 0, endMs: 1_000, root: "D", quality: "major" as const, confidence: 0.05 }];
  const base = scoreVocalChordToneFit({
    vocalFrames, bedChords, donorStartMs: 0, donorEndMs: 1_000, bedStartMs: 0, bedEndMs: 1_000,
    stretchRatio: 1, pitchShiftSemitones: 0,
  });
  const transposed = scoreVocalChordToneFit({
    vocalFrames, bedChords, donorStartMs: 0, donorEndMs: 1_000, bedStartMs: 0, bedEndMs: 1_000,
    stretchRatio: 1, pitchShiftSemitones: 2,
  });
  assert.equal(base?.similarity, 0);
  assert.equal(transposed?.similarity, 1);
});

test("plan: missing passage fingerprints and sparse measured features keep the safe fallback", () => {
  const checksumDonor = "d".repeat(64);
  const checksumBed = "b".repeat(64);
  const sparse = passageFingerprint(checksumBed, 16, 32);
  sparse.rhythm = unavailablePassageEvidence("sparse percussion: rhythm could not be measured");
  const result = planMashup(
    profile({
      role: "vocals",
      sourceChecksumSha256: checksumDonor,
      bpm: 120,
      bpmConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [
        {
          id: "missing-fingerprint",
          label: "section",
          startMs: 0,
          endMs: 8_000,
          startBeatIndex: 0,
          endBeatIndex: 16,
        },
        {
          id: "sparse-donor",
          label: "section",
          startMs: 20_000,
          endMs: 28_000,
          startBeatIndex: 40,
          endBeatIndex: 56,
          passageFingerprint: passageFingerprint(checksumDonor, 40, 56),
        },
      ],
      vocalPhrases: [
        { startMs: 1_000, endMs: 1_500, confidence: 0.95 },
        { startMs: 21_000, endMs: 21_500, confidence: 0.95 },
      ],
    }),
    profile({
      role: "instrumental",
      sourceChecksumSha256: checksumBed,
      bpm: 120,
      bpmConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [
        { id: "safe-fallback", label: "section", startMs: 8_000, endMs: 16_000 },
        {
          id: "sparse-bed",
          label: "section",
          startMs: 30_000,
          endMs: 38_000,
          startBeatIndex: 60,
          endBeatIndex: 76,
          passageFingerprint: sparse,
        },
      ],
    }),
  );

  assert.ok(result.ok);
  assert.equal(result.plan.passageSearch?.evaluatedDonorPassageCount, 2);
  assert.equal(result.plan.passageSearch?.rankableDonorPassageCount, 0);
  assert.match(result.plan.passageSearch!.evaluations[0]!.reason, /no current checksum-bound passage fingerprint/);
  assert.match(result.plan.passageSearch!.evaluations[1]!.reason, /measured rhythm, harmony, and beat-phase inputs/);
  assert.equal(result.plan.segments[0]!.mashupStartMs, 8_000,
    "incomplete passage evidence leaves mashup creation on the existing fallback");
});

test("plan: a valid early-bed match is not discarded just because it precedes the fallback entry", () => {
  const checksumDonor = "d".repeat(64);
  const checksumBed = "b".repeat(64);
  const result = planMashup(
    profile({
      role: "vocals",
      sourceChecksumSha256: checksumDonor,
      bpm: 120,
      bpmConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [
        {
          id: "donor-opening",
          label: "section",
          startMs: 0,
          endMs: 4_000,
          startBeatIndex: 0,
          endBeatIndex: 8,
          passageFingerprint: passageFingerprint(checksumDonor, 0, 16, "different"),
        },
        {
          id: "donor-later",
          label: "section",
          startMs: 4_000,
          endMs: 12_000,
          startBeatIndex: 8,
          endBeatIndex: 24,
          passageFingerprint: passageFingerprint(checksumDonor, 8, 24),
        },
      ],
      vocalActivityIntervals: [{ startMs: 5_000, endMs: 5_500, confidence: 0.95 }],
    }),
    profile({
      role: "instrumental",
      sourceChecksumSha256: checksumBed,
      bpm: 120,
      bpmConfidence: 0.95,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [
        {
          id: "bed-intro-match",
          label: "intro",
          startMs: 8_000,
          endMs: 16_000,
          startBeatIndex: 16,
          endBeatIndex: 32,
          passageFingerprint: passageFingerprint(checksumBed, 16, 32),
        },
        {
          id: "bed-body",
          label: "verse",
          startMs: 16_000,
          endMs: 24_000,
          startBeatIndex: 32,
          endBeatIndex: 48,
          passageFingerprint: passageFingerprint(checksumBed, 32, 48, "different"),
        },
      ],
    }),
  );

  assert.ok(result.ok);
  assert.equal(result.plan.passageSearch?.selectedDonorSectionId, "donor-later");
  assert.equal(result.plan.passageSearch?.selectedBedSectionId, "bed-intro-match");
  assert.ok(result.plan.segments[0]!.mashupStartMs < 16_000,
    "a measured earlier bed passage can be selected instead of the heuristic first-body fallback");
  assert.equal(result.plan.segments[0]!.vocalsFromMs, 4_750,
    "coarse isolated-vocal activity supplies the crop and donor passage even when pitch continuity is unavailable");
});

test("plan: low-confidence vocal phrases are not used as lyric timing evidence", () => {
  const result = planMashup(
    profile({
      role: "vocals",
      durationMs: 60_000,
      vocalPhrases: [{ startMs: 4_000, endMs: 8_000, confidence: 0.49 }],
    }),
    profile({ role: "instrumental", durationMs: 60_000 }),
  );

  assert.ok(result.ok);
  assert.equal(result.plan.segments[0].vocalsFromMs, 0);
  assert.equal(result.plan.segments[0].vocalsToMs, 60_000);
  assert.ok(result.plan.warnings.some((line) => line.includes("not lyric-aware")));
});

test("plan: missing tempo analysis adapts with fallback estimation and honest warning", () => {
  const resultVocalMissing = planMashup(profile({ role: "vocals", bpm: null }), profile({ bpm: 100 }));
  assert.ok(resultVocalMissing.ok);
  assert.equal(resultVocalMissing.plan.masterBpm, 100);
  assert.ok(resultVocalMissing.plan.vocalsStretchRatio > 0);
  assert.ok(resultVocalMissing.plan.warnings.some((w) => /Vocal tempo analysis is incomplete/i.test(w)));

  const resultBothMissing = planMashup(profile({ role: "vocals", bpm: null }), profile({ bpm: null }));
  assert.ok(resultBothMissing.ok);
  assert.equal(resultBothMissing.plan.masterBpm, 120);
  assert.ok(resultBothMissing.plan.vocalsStretchRatio > 0);
  assert.ok(resultBothMissing.plan.warnings.some((w) => /Neither track has complete tempo analysis/i.test(w)));

  const resultBedMissing = planMashup(profile({ role: "vocals", bpm: 128 }), profile({ bpm: null }));
  assert.ok(resultBedMissing.ok);
  assert.ok(resultBedMissing.plan.masterBpm > 0);
  assert.ok(resultBedMissing.plan.vocalsStretchRatio > 0);
  assert.ok(resultBedMissing.plan.warnings.some((w) => /instrumental has no complete tempo analysis/i.test(w)));
});

test("plan: missing key analysis adapts with 0 semitones and honest warning", () => {
  const result = planMashup(
    profile({ role: "vocals", bpm: 120, musicalKey: null }),
    profile({ bpm: 120, musicalKey: "C major" }),
  );
  assert.ok(result.ok);
  assert.equal(result.plan.vocalsPitchSemitones, 0);
  assert.equal(result.plan.keyRelationship, "unknown");
  assert.ok(result.plan.warnings.some((w) => /Key analysis is missing/i.test(w)));
});

test("plan: large key shifts warn (veto belongs to the user's ears)", () => {
  const result = planMashup(
    profile({ role: "vocals", bpm: 120, musicalKey: "F# major" }),
    profile({ bpm: 120, musicalKey: "C major" }),
  );
  assert.ok(result.ok);
  assert.ok(Math.abs(result.plan.vocalsPitchSemitones) === 6);
  assert.ok(result.plan.warnings.some((line) => /semitone shift is large/i.test(line)));
});

test("plan: vocal longer than the bed truncates with a warning", () => {
  const result = planMashup(
    profile({ role: "vocals", bpm: 100, durationMs: 120_000 }),
    profile({ bpm: 100, durationMs: 30_000 }),
  );
  assert.ok(result.ok);
  assert.ok(result.plan.warnings.some((line) => /fades out at the bed's end/i.test(line)));
  assert.equal(result.plan.segments[0].mashupEndMs, 30_000);
});

// --- the sync reassurance: rendered vocal onsets land on bed beats ---------

/** 100 BPM bed: a steady bed tone (no transients). */
function bedTone(seconds: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = 0.25 * Math.sin((2 * Math.PI * 110 * i) / RATE);
    out[i * 2] = value;
    out[i * 2 + 1] = value;
  }
  return out;
}

/** 140 BPM vocal: a short click every beat (428.571ms), starting 600ms in. */
function vocalClicks140(seconds: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  const beat = (60_000 / 140) / 1000; // seconds per beat at 140 BPM
  const clickLength = Math.round(0.02 * RATE);
  for (let beatIndex = 0; beatIndex * beat < seconds - 0.02; beatIndex += 1) {
    const start = Math.round((0.6 + beatIndex * beat) * RATE);
    for (let i = 0; i < clickLength; i += 1) {
      const value = 0.9 * Math.sin((Math.PI * i) / clickLength);
      out[(start + i) * 2] = value;
      out[(start + i) * 2 + 1] = value;
    }
  }
  return out;
}

test("REASSURANCE: a 140 BPM vocal renders ON the 100 BPM bed's beat grid", () => {
  const bedSeconds = 12;
  const vocalSeconds = 10;
  const result = planMashup(
    profile({ role: "vocals", bpm: 140, durationMs: vocalSeconds * 1000, sections: [section("verse", 0, vocalSeconds * 1000)] }),
    profile({ bpm: 100, durationMs: bedSeconds * 1000, sections: [section("verse", 0, bedSeconds * 1000)] }),
  );
  assert.ok(result.ok);
  const plan = result.plan;
  assert.ok(Math.abs(plan.vocalsStretchRatio - 1.4) < 1e-9);

  const rendered = renderMashup(plan, { vocals: vocalClicks140(vocalSeconds), bed: bedTone(bedSeconds), sampleRate: RATE });
  assert.equal(rendered.length, bedSeconds * RATE * 2);

  // Expected: vocal click k starts at 0.6s + k×(3/7)s in source time; after
  // ×1.4 stretch each click sits at (0.6 + k×3/7)×1.4 = 0.84 + k×0.6s —
  // i.e. ON the 100 BPM grid (600 ms beats), offset 240 ms after entry 0.
  // (The segment starts at mashup 0 here.)
  const beatMs = 600;
  let checked = 0;
  for (let k = 0; k < 14; k += 1) {
    const onsetMs = 840 + k * beatMs;
    if (onsetMs > (bedSeconds - 1) * 1000) break;
    // Energy at the onset (60ms window) must clearly exceed the off-beat
    // trough 300ms away (bed tone alone + ducking).
    const atOnset = windowPeak(rendered, onsetMs, onsetMs + 60);
    const offBeat = windowPeak(rendered, onsetMs + 300, onsetMs + 360);
    assert.ok(atOnset > offBeat * 1.8, `click ${k}: onset ${atOnset.toFixed(3)} should beat off-beat ${offBeat.toFixed(3)} at ${onsetMs}ms`);
    checked += 1;
  }
  assert.ok(checked >= 10, `checked ${checked} clicks`);
});

test("REASSURANCE: half-lock leaves the vocal unsynchronized but beat-consistent", () => {
  // 70 BPM vocal clicks over a 140 BPM bed: ratio snaps to 1.0, so clicks
  // stay every 857.14ms = exactly every 2 bed beats.
  const bedSeconds = 12;
  const vocalSeconds = 10;
  const result = planMashup(
    profile({ role: "vocals", bpm: 70, durationMs: vocalSeconds * 1000, sections: [section("verse", 0, vocalSeconds * 1000)] }),
    profile({ bpm: 140, durationMs: bedSeconds * 1000, sections: [section("verse", 0, bedSeconds * 1000)] }),
  );
  assert.ok(result.ok);
  assert.equal(result.plan.vocalsStretchRatio, 1);

  // Half-lock is a timing claim, so it is measured on a composition-only
  // render: loudness matching and limiting are disabled so the mix bus cannot
  // move the clicks this assertion is about.
  const out = renderMashup(result.plan, {
    vocals: clicksAtBpm(vocalSeconds, 70, 0.6),
    bed: bedTone(bedSeconds),
    sampleRate: RATE,
    mix: { matchVocalLoudness: false, limit: false },
  });
  const bedBeatMs = 60_000 / 140;
  const clickPeriodMs = 60_000 / 70;
  for (let k = 0; k < 10; k += 1) {
    const onsetMs = 600 + k * clickPeriodMs;
    if (onsetMs > (bedSeconds - 1) * 1000) break;
    // Every click must sit at a whole number of bed beats after the entry.
    const beatsIn = (onsetMs - 600) / bedBeatMs;
    assert.ok(Math.abs(beatsIn - Math.round(beatsIn)) < 0.02, `click ${k} at ${beatsIn.toFixed(3)} bed beats`);
    assert.ok(windowPeak(out, onsetMs, onsetMs + 60) > 0.2, `click ${k} audible`);
  }
});

function clicksAtBpm(seconds: number, bpm: number, startSeconds: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  const beat = 60 / bpm;
  const clickLength = Math.round(0.02 * RATE);
  for (let beatIndex = 0; startSeconds + beatIndex * beat < seconds - 0.02; beatIndex += 1) {
    const start = Math.round((startSeconds + beatIndex * beat) * RATE);
    for (let i = 0; i < clickLength; i += 1) {
      const value = 0.9 * Math.sin((Math.PI * i) / clickLength);
      out[(start + i) * 2] = value;
      out[(start + i) * 2 + 1] = value;
    }
  }
  return out;
}

function windowPeak(buffer: Float32Array, fromMs: number, toMs: number): number {
  const from = Math.floor((fromMs / 1000) * RATE) * 2;
  const to = Math.min(buffer.length, Math.floor((toMs / 1000) * RATE) * 2);
  let peak = 0;
  for (let i = from; i < to; i += 2) peak = Math.max(peak, Math.abs(buffer[i]));
  return peak;
}

test("render: bed ducks under active vocals, crossfades, and is limited rather than hard-clipped", () => {
  const result = planMashup(
    profile({ role: "vocals", bpm: 100, durationMs: 10_000, sections: [section("verse", 0, 10_000)] }),
    profile({ bpm: 100, durationMs: 10_000, sections: [section("verse", 0, 10_000)] }),
  );
  assert.ok(result.ok);
  const loudBed = new Float32Array(10 * RATE * 2).fill(0.9);
  const loudVocal = new Float32Array(10 * RATE * 2).fill(0.9);
  const out = renderMashupWithBus(result.plan, { vocals: loudVocal, bed: loudBed, sampleRate: RATE });

  // This fixture genuinely overloads: 0.9 bed + 0.9 vocal ≈ +3.8 dB over the
  // ceiling. The mix bus attenuates that overshoot once, statically, instead
  // of clamping every sample at full scale.
  assert.ok(out.mix.staticGainDb < -3 && out.mix.staticGainDb > -5,
    `static attenuation ${out.mix.staticGainDb} dB should recover the overshoot`);
  // Static attenuation removes the bulk of the overshoot; the limiter is then
  // reported as active because the *measured* reconstructable peak still
  // needed it (the overshoot is computed from true peak, not sample peak).
  assert.ok(["active", "not-required"].includes(out.mix.limiter.applied ? "active" : "not-required"));
  assert.ok(out.mix.postLimit.samplePeakDb < -0.5,
    `nothing may sit at full scale after limiting, got ${out.mix.postLimit.samplePeakDb} dBFS`);

  // Nothing exceeds full scale, and — unlike the previous clamp — nothing is
  // pinned at full scale either, which is what a hard-clipped mix looks like.
  let atFullScale = 0;
  for (const value of out.pcm) {
    assert.ok(value >= -1.0001 && value <= 1.0001);
    if (Math.abs(value) > 0.9999) atFullScale += 1;
  }
  assert.equal(atFullScale, 0, "hard-clipped samples must not appear in a limited mix");

  // Ducking still behaves: the bed at the top, before the vocal crossfade
  // completes, is louder than the ducked bed under the vocal once the
  // vocal's own contribution is removed by rendering the bed alone.
  // Loudness matching is disabled here so the bed-only render is comparable
  // with the mixed render: otherwise the vocal (silence) would measure no
  // loudness and a real vocal would be gain-matched, changing absolute gain.
  const bedOnly = renderMashupWithBus(result.plan, {
    vocals: new Float32Array(10 * RATE * 2),
    bed: loudBed,
    sampleRate: RATE,
    mix: { matchVocalLoudness: false },
  });
  const staticGain = 10 ** (bedOnly.mix.staticGainDb / 20);
  const bedMid = bedOnly.pcm[5 * RATE * 2]!;
  const expectedDuckedBed = 0.9 * staticGain * (1 - 0.28);
  assert.ok(Math.abs(bedMid - expectedDuckedBed) < 0.01,
    `bed must sit 28% down under the vocal: ${bedMid.toFixed(3)} vs ${expectedDuckedBed.toFixed(3)}`);
  const bedEarly = bedOnly.pcm[Math.round(0.05 * RATE) * 2]!;
  assert.ok(bedEarly > bedMid * 1.15,
    `bed starts unducked and drops into the vocal pocket: ${bedEarly.toFixed(3)} → ${bedMid.toFixed(3)}`);
});

// --- extension -------------------------------------------------------------

test("extension: plan loops the last body section with bar-aligned fades", () => {
  const source = profile({
    bpm: 120,
    durationMs: 40_000,
    sections: [section("intro", 0, 4000), section("verse", 4000, 20_000), section("chorus", 20_000, 36_000)],
  });
  const plan = planSongExtension(source, { repeats: 2 });
  assert.ok(plan !== null);
  assert.equal(plan.section.label, "chorus", "default = last body section");
  assert.equal(plan.repeats, 2);
  // 120 BPM → bar = 2000ms → crossfade = min(1000, 1000) = 1000ms.
  assert.equal(plan.crossfadeMs, 1000);
  assert.equal(plan.durationMs, 36_000 + 16_000 * 2 + 2000);
  assert.ok(plan.rationale.length >= 3);
});

test("extension: render appends the loops after the original, crossfaded", () => {
  const source = profile({
    bpm: 100,
    durationMs: 20_000,
    sections: [section("chorus", 4000, 12_000)],
  });
  const plan = planSongExtension(source, { repeats: 2 });
  assert.ok(plan !== null);
  // Original 20s of steady tone.
  const pcm = new Float32Array(20 * RATE * 2);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 220 * (i >> 1)) / RATE);

  const out = renderSongExtension(plan, pcm, RATE);
  assert.equal(out.length, Math.round((plan.durationMs / 1000) * RATE) * 2);
  // The chorus (4–12s) replays at 12–20s and 20–28s: energy well past the
  // original's 20s end, no clipping, and the final bar fades to silence.
  assert.ok(windowPeak(out, 14_000, 15_000) > 0.2, "loop 1 is audible");
  assert.ok(windowPeak(out, 22_000, 23_000) > 0.2, "loop 2 is audible");
  assert.ok(windowPeak(out, plan.durationMs - 300, plan.durationMs) < 0.1, "tail fades out");
  for (const value of out) assert.ok(value >= -1.0001 && value <= 1.0001);
  // Original head is untouched.
  assert.ok(windowPeak(out, 0, 3000) > 0.2);
});

test("extension: no sections → no plan (honest null)", () => {
  assert.equal(planSongExtension(profile({ bpm: 120, durationMs: 10_000, sections: [] })), null);
});

// --- full-track arrangement regressions (planner v10) ----------------------

test("plan: whole-body placement preserves phrase gaps instead of snapping fragments independently", () => {
  const vocalFrames = Array.from({ length: 111 }, (_, index) => ({
    timestampMs: 500 + index * 100,
    frequencyHz: 261.625565,
    midiFloat: 60,
    nearestMidiNote: 60,
    confidence: 0.95,
    voiced: true,
  }));
  const vocals = profile({
    role: "vocals", sourceChecksumSha256: "d".repeat(64), durationMs: 12_000,
    beatGridMs: Array.from({ length: 25 }, (_, i) => i * 500), beatConfidence: 0.95, bpmConfidence: 0.95,
    sections: [],
    vocalPhrases: [
      { startMs: 500, endMs: 5_500, confidence: 0.95 },
      { startMs: 6_500, endMs: 11_500, confidence: 0.95 },
    ],
    vocalPitchFrames: vocalFrames,
  });
  // Every chord before 11s clashes with the C4-only phrase (F# major); the
  // ending chord can tempt a fragment-level planner to move only the second
  // phrase. The correct output keeps the whole performance together.
  const bed = profile({
    role: "instrumental", sourceChecksumSha256: "b".repeat(64), durationMs: 15_000,
    beatGridMs: Array.from({ length: 31 }, (_, i) => i * 500), beatConfidence: 0.95, bpmConfidence: 0.95,
    sections: [section("verse", 0, 15_000)],
    harmonyEvents: [
      { startMs: 0, endMs: 4_000, root: "F#", quality: "major", confidence: 0.05 },
      { startMs: 4_000, endMs: 8_000, root: "F#", quality: "major", confidence: 0.05 },
      { startMs: 8_000, endMs: 11_000, root: "F#", quality: "major", confidence: 0.05 },
      { startMs: 11_000, endMs: 13_250, root: "C", quality: "major", confidence: 0.05 },
      { startMs: 13_250, endMs: 15_000, root: "C", quality: "major", confidence: 0.05 },
    ],
  });
  const result = planMashup(vocals, bed);
  assert.ok(result.ok);
  const arrangement = result.plan.arrangement;
  assert.ok(arrangement, "the full-track placement comparison is recorded");
  assert.ok(arrangement.selected === "continuous-overlay" || arrangement.selected === "coherent-overlay");
  assert.equal(arrangement.unitsTotal, 2);
  assert.equal(arrangement.unitsPlaced, arrangement.unitsTotal);
  assert.equal(arrangement.unitsSkipped, 0);
  assert.equal(arrangement.coherentUnitsPlaced, 2);
  assert.equal(arrangement.continuousUnitsPlaced, 2);
  assert.equal(arrangement.placements.length, 2);
  // Phrase order and spacing are preserved by one global offset/tempo map.
  assert.ok(arrangement.placements[0]!.donorFromMs < arrangement.placements[1]!.donorFromMs);
  assert.equal(arrangement.placements[0]!.donorFromMs, 500);
  assert.equal(arrangement.placements[0]!.donorToMs, 5_500);
  assert.equal(arrangement.placements[1]!.donorFromMs, 6_500);
  assert.equal(arrangement.placements[1]!.donorToMs, 11_500);
  assert.equal(
    arrangement.placements[1]!.bedStartMs - arrangement.placements[0]!.bedStartMs,
    Math.round((6_500 - 500) * result.plan.vocalsStretchRatio),
    "the 6s donor spacing is preserved after the one global tempo change",
  );
  assert.equal(result.plan.segments.length, 1, "activity windows are not cut into separately relocated audio clips");
  assert.equal(result.plan.segments[0]!.vocalsFromMs, 250, "the padded vocal body stays intact");
  assert.equal(result.plan.segments[0]!.vocalsToMs, 11_750);
});

test("plan: full-track arrangement keeps the continuous overlay when no re-placement wins decisively", () => {
  const drumEvents = Array.from({ length: 61 }, (_, index) => ({
    timestampMs: index * 250, confidence: 0.9, strength: 0.6,
  }));
  const vocals = profile({
    role: "vocals", sourceChecksumSha256: "d".repeat(64), durationMs: 12_000,
    bpmConfidence: 0.95,
    vocalPhrases: [
      { startMs: 500, endMs: 5_500, confidence: 0.95 },
      { startMs: 6_500, endMs: 11_500, confidence: 0.95 },
    ],
  });
  const bed = profile({
    role: "instrumental", sourceChecksumSha256: "b".repeat(64), durationMs: 15_000,
    bpmConfidence: 0.95,
    sections: [],
    drumEvents,
  });
  const result = planMashup(vocals, bed);
  assert.ok(result.ok);
  const arrangement = result.plan.arrangement;
  assert.ok(arrangement, "the comparison is recorded even when the overlay wins");
  assert.equal(arrangement.selected, "continuous-overlay");
  assert.equal(arrangement.evidence.pairedBeatGrids, false);
  assert.equal(arrangement.pairedBeatPhaseFit, null);
  assert.equal(arrangement.baselineBeatPhaseFit, null);
  assert.ok(result.plan.warnings.some((warning) => warning.includes("paired donor-and-bed beat-grid check was unavailable")),
    "the fallback explicitly says that two-track beat phase was not verified");
  assert.equal(arrangement.coherentUnitsPlaced, arrangement.unitsTotal);
  assert.equal(arrangement.continuousUnitsPlaced, arrangement.unitsTotal);
  assert.ok(arrangement.coherentScore - arrangement.overlayScore <= Math.max(0.5, 0.03 * Math.abs(arrangement.overlayScore)) + 1e-9);
  assert.equal(result.plan.segments.length, 1);
  assert.equal(result.plan.segments[0]!.vocalsFromMs, 250, "the padded overlay body is kept intact");
  assert.ok(result.plan.warnings.some((warning) => warning.includes("whole-body move")),
    "the retained overlay is disclosed in the warnings");
});

test("plan: long bed with no donor grounding keeps one body segment and warns instead of replaying the opening", () => {
  const vocals = profile({
    role: "vocals", sourceChecksumSha256: "d".repeat(64), durationMs: 8_000,
    beatGridMs: Array.from({ length: 17 }, (_, i) => i * 500), beatConfidence: 0.95, bpmConfidence: 0.95,
    sections: [section("verse", 0, 7_500)],
  });
  const bed = profile({
    role: "instrumental", sourceChecksumSha256: "b".repeat(64), durationMs: 60_000,
    sections: [section("verse 1", 0, 30_000), section("chorus", 30_000, 60_000)],
  });
  const result = planMashup(vocals, bed);
  assert.ok(result.ok);
  assert.equal(result.plan.segments.length, 1,
    "the opening body is placed exactly once — the bed continues instrumental rather than looping the verse");
  assert.equal(result.plan.segments[0]!.vocalsFromMs, 0);
  assert.equal(result.plan.segments[0]!.vocalsToMs, 7_500);
  assert.ok(result.plan.warnings.some((warning) => warning.includes("instrumental")),
    "the missing reprise grounding is disclosed");
  assert.equal(result.plan.segments.some((segment) => segment.vocalsFromMs === 0 && segment.mashupStartMs > 0), false,
    "no segment replays the opening body later in the bed");
});

test("plan: too-short bed keeps one full vocal clip and reports the bed-end truncation", () => {
  const vocals = profile({
    role: "vocals", sourceChecksumSha256: "d".repeat(64), durationMs: 12_000,
    beatGridMs: Array.from({ length: 25 }, (_, i) => i * 500), beatConfidence: 0.95, bpmConfidence: 0.95,
    vocalPhrases: [
      { startMs: 500, endMs: 5_500, confidence: 0.95 },
      { startMs: 6_500, endMs: 11_500, confidence: 0.95 },
    ],
  });
  const bed = profile({
    role: "instrumental", sourceChecksumSha256: "b".repeat(64), durationMs: 7_000,
    sections: [],
    drumEvents: Array.from({ length: 29 }, (_, index) => ({ timestampMs: index * 250, confidence: 0.9, strength: 0.5 })),
  });
  const result = planMashup(vocals, bed);
  assert.ok(result.ok);
  const arrangement = result.plan.arrangement;
  assert.ok(arrangement, "the arrangement comparison is recorded");
  assert.equal(arrangement.unitsTotal, 2);
  assert.equal(result.plan.segments.length, 1, "the vocal is not split to fake complete placement");
  assert.equal(result.plan.segments[0]!.vocalsFromMs, 250);
  assert.equal(result.plan.segments[0]!.vocalsToMs, 11_750);
  assert.ok(result.plan.warnings.some((warning) => warning.includes("bed's end")),
    "the full donor clip's end truncation is disclosed");
  assert.equal(result.plan.segments.some((segment) => segment.mashupEndMs > 7_000), false,
    "no segment plays past the end of the bed");
});

test("plan: a longer bed may improve the fit only by shifting the whole vocal body", () => {
  const vocalFrames = Array.from({ length: 111 }, (_, index) => ({
    timestampMs: 500 + index * 100,
    frequencyHz: 261.625565,
    midiFloat: 60,
    nearestMidiNote: 60,
    confidence: 0.95,
    voiced: true,
  }));
  const vocals = profile({
    role: "vocals", sourceChecksumSha256: "d".repeat(64), durationMs: 12_000,
    bpmConfidence: 0.95,
    vocalPhrases: [
      { startMs: 500, endMs: 5_500, confidence: 0.95 },
      { startMs: 6_500, endMs: 11_500, confidence: 0.95 },
    ],
    vocalPitchFrames: vocalFrames,
  });
  const bed = profile({
    role: "instrumental", sourceChecksumSha256: "b".repeat(64), durationMs: 36_000,
    bpmConfidence: 0.95,
    beatGridMs: Array.from({ length: 73 }, (_, index) => index * 500),
    beatConfidence: 0.95,
    sections: [section("verse", 0, 14_000), section("chorus", 14_000, 36_000)],
    harmonyEvents: [
      { startMs: 0, endMs: 7_000, root: "F#", quality: "major", confidence: 0.05 },
      { startMs: 7_000, endMs: 14_000, root: "F#", quality: "major", confidence: 0.05 },
      { startMs: 14_000, endMs: 25_000, root: "C", quality: "major", confidence: 0.05 },
      { startMs: 25_000, endMs: 36_000, root: "C", quality: "major", confidence: 0.05 },
    ],
  });
  const result = planMashup(vocals, bed);
  assert.ok(result.ok);
  const arrangement = result.plan.arrangement;
  assert.ok(arrangement);
  assert.equal(arrangement.selected, "coherent-overlay",
    "a better late backing section moves the whole donor performance together");
  assert.ok(arrangement.coherentEntryMs > 10_000);
  assert.equal(result.plan.segments.length, 1);
  assert.equal(result.plan.segments[0]!.mashupStartMs, arrangement.coherentEntryMs);
  assert.equal(arrangement.placements[1]!.bedStartMs - arrangement.placements[0]!.bedStartMs, 6_000,
    "the donor's verse phrase spacing remains unchanged");
});

test("plan: donor vocal phase is preserved against both tracks' drum grids", () => {
  const donorBeats = Array.from({ length: 80 }, (_, index) => 200 + index * 500);
  const bedBeats = Array.from({ length: 121 }, (_, index) => index * 500);
  const vocals = profile({
    role: "vocals",
    durationMs: 40_000,
    bpm: 120,
    bpmConfidence: 0.95,
    beatConfidence: 0.95,
    beatGridMs: donorBeats,
    vocalActivityIntervals: Array.from({ length: 8 }, (_, index) => ({
      startMs: 300 + index * 4_000,
      endMs: 1_000 + index * 4_000,
      confidence: 0.95,
    })),
  });
  const bed = profile({
    role: "instrumental",
    durationMs: 60_000,
    bpm: 120,
    bpmConfidence: 0.95,
    beatConfidence: 0.95,
    beatGridMs: bedBeats,
    drumEvents: Array.from({ length: 8 }, (_, index) => ({
      timestampMs: 650 + index * 4_000,
      strength: 0.8,
      confidence: 0.95,
    })),
  });

  const result = planMashup(vocals, bed);
  assert.ok(result.ok);
  const arrangement = result.plan.arrangement;
  assert.ok(arrangement);
  assert.equal(arrangement.evidence.pairedBeatGrids, true);
  assert.ok(arrangement.pairedBeatPhaseFit);
  assert.ok(arrangement.baselineBeatPhaseFit);
  assert.equal(arrangement.baselineBeatPhaseFit.score, 0,
    "the old entry puts the donor drums out of phase with the bed grid");
  assert.equal(arrangement.pairedBeatPhaseFit.score, 1,
    "the chosen offset aligns the donor drum beats to bed beats within tolerance");
  assert.equal(arrangement.selected, "coherent-overlay");
  assert.equal(arrangement.coherentEntryMs, 350,
    "aligning the donor beat preserves the vocal's original 100 ms offbeat entry");
  assert.equal(result.plan.segments[0]!.mashupStartMs, 350);
  assert.ok(arrangement.rationale.some((line) => line.includes("donor drum beats are mapped to the bed drum grid")));
});

test("plan and render: bounded local tempo correction reduces slow donor-to-bed grid drift without cutting phrases", () => {
  const donorBeats = Array.from({ length: 49 }, (_, index) => Math.round(index * 500 + index * index * 0.1));
  const bedBeats = Array.from({ length: 61 }, (_, index) => index * 500);
  const vocals = profile({
    role: "vocals",
    durationMs: 30_000,
    bpm: 120,
    bpmConfidence: 0.95,
    beatConfidence: 0.95,
    beatGridMs: donorBeats,
    vocalActivityIntervals: Array.from({ length: 8 }, (_, index) => ({
      startMs: 250 + index * 3_000,
      endMs: 1_000 + index * 3_000,
      confidence: 0.95,
    })),
  });
  const bed = profile({
    role: "instrumental",
    durationMs: 30_000,
    bpm: 120,
    bpmConfidence: 0.95,
    beatConfidence: 0.95,
    beatGridMs: bedBeats,
    drumEvents: Array.from({ length: 30 }, (_, index) => ({
      timestampMs: index * 500,
      strength: 0.8,
      confidence: 0.95,
    })),
  });

  const result = planMashup(vocals, bed);
  assert.ok(result.ok);
  const segment = result.plan.segments[0]!;
  assert.ok(segment.localTempoMap, "a real local grid drift should earn a constrained time map");
  assert.ok(Number.isInteger(segment.mashupStartMs) && Number.isInteger(segment.mashupEndMs),
    "the planned clip timing must use integer milliseconds accepted by persisted Studio clips");
  assert.equal(result.plan.segments.length, 1, "local correction must keep the vocal as one continuous performance");
  assert.ok(segment.localTempoMap.correctedFit.matchedBeats > segment.localTempoMap.baselineFit.matchedBeats);
  assert.ok(segment.localTempoMap.correctedFit.meanErrorMs < segment.localTempoMap.baselineFit.meanErrorMs);
  assert.ok(segment.localTempoMap.maximumRateDeviationPercent <= 1.5);
  const ratios = segment.localTempoMap.points.slice(1).map((point, index) =>
    (point.outputMs - segment.localTempoMap!.points[index]!.outputMs)
      / (point.sourceMs - segment.localTempoMap!.points[index]!.sourceMs));
  assert.ok(ratios.every((ratio) => ratio >= result.plan.vocalsStretchRatio * 0.985 - 1e-6
    && ratio <= result.plan.vocalsStretchRatio * 1.015 + 1e-6), "local tempo must stay inside the documented rate bound");

  const donorClicks = new Float32Array(30 * RATE * 2);
  for (const beatMs of donorBeats) {
    const firstFrame = Math.round(beatMs * RATE / 1000);
    for (let offset = 0; offset < Math.round(RATE * 0.012); offset += 1) {
      const envelope = Math.sin(Math.PI * offset / (RATE * 0.012));
      const sample = 0.75 * envelope * Math.sin(2 * Math.PI * 850 * offset / RATE);
      donorClicks[(firstFrame + offset) * 2] = sample;
      donorClicks[(firstFrame + offset) * 2 + 1] = sample;
    }
  }
  const silentBed = new Float32Array(30 * RATE * 2);
  const rendered = renderMashup(result.plan, {
    vocals: donorClicks,
    bed: silentBed,
    sampleRate: RATE,
  });
  const baselinePlan = {
    ...result.plan,
    segments: result.plan.segments.map(({ localTempoMap: _localTempoMap, ...item }) => ({
      ...item,
      mashupStartMs: item.mashupStartMs - segment.localTempoMap!.entryShiftMs,
      mashupEndMs: item.mashupStartMs - segment.localTempoMap!.entryShiftMs
        + Math.round((item.vocalsToMs - item.vocalsFromMs) * result.plan.vocalsStretchRatio),
    })),
  };
  const baselineRender = renderMashup(baselinePlan, {
    vocals: donorClicks,
    bed: silentBed,
    sampleRate: RATE,
  });
  assert.ok(rendered.length > 0);
  assert.equal(segment.mashupEndMs - segment.mashupStartMs, Math.round(segment.localTempoMap.points.at(-1)!.outputMs),
    "the mapped output duration is the same duration persisted by the plan");
  const targetBedBeatIndex = Math.round(segment.mashupStartMs / 500);
  const inBodyBeats = donorBeats.filter((beat) => beat >= segment.vocalsFromMs && beat <= segment.vocalsToMs);
  const alignmentError = (pcm: Float32Array) => inBodyBeats.slice(2, -2).map((_beat, offset) => {
    const targetMs = bedBeats[targetBedBeatIndex + offset + 2]!;
    const expectedFrame = Math.round(targetMs * RATE / 1000);
    let peakFrame = expectedFrame;
    let peak = 0;
    const radius = Math.round(RATE * 0.2);
    for (let frame = Math.max(0, expectedFrame - radius); frame < Math.min(pcm.length / 2, expectedFrame + radius); frame += 1) {
      const magnitude = Math.max(Math.abs(pcm[frame * 2]!), Math.abs(pcm[frame * 2 + 1]!));
      if (magnitude > peak) { peak = magnitude; peakFrame = frame; }
    }
    assert.ok(peak > 0.05, `mapped donor click is present near bed beat ${targetMs}ms`);
    return Math.abs(peakFrame - expectedFrame) * 1000 / RATE;
  });
  const localMeanErrorMs = alignmentError(rendered).reduce((sum, error) => sum + error, 0) / (inBodyBeats.length - 4);
  const globalMeanErrorMs = alignmentError(baselineRender).reduce((sum, error) => sum + error, 0) / (inBodyBeats.length - 4);
  console.log(`WAVEYARD_LOCAL_TEMPO_ALIGNMENT ${JSON.stringify({ localMeanErrorMs, globalMeanErrorMs, pairedGridBefore: segment.localTempoMap.baselineFit, pairedGridAfter: segment.localTempoMap.correctedFit })}`);
  assert.ok(localMeanErrorMs < globalMeanErrorMs,
    `rendered local map should improve audible transient timing (${localMeanErrorMs.toFixed(1)}ms vs ${globalMeanErrorMs.toFixed(1)}ms)`);
});

test("plan: a missing beat detection disables ordinal pairing and keeps the safe continuous fallback", () => {
  const donorBeats = Array.from({ length: 49 }, (_, index) => index * 500).filter((_beat, index) => index !== 24);
  const bedBeats = Array.from({ length: 61 }, (_, index) => index * 500);
  const vocals = profile({
    role: "vocals",
    durationMs: 24_000,
    bpm: 120,
    bpmConfidence: 0.95,
    beatConfidence: 0.95,
    beatGridMs: donorBeats,
    vocalActivityIntervals: Array.from({ length: 8 }, (_, index) => ({
      startMs: 250 + index * 2_500,
      endMs: 900 + index * 2_500,
      confidence: 0.95,
    })),
  });
  const bed = profile({
    role: "instrumental",
    durationMs: 30_000,
    bpm: 120,
    bpmConfidence: 0.95,
    beatConfidence: 0.95,
    beatGridMs: bedBeats,
    drumEvents: Array.from({ length: 60 }, (_, index) => ({
      timestampMs: index * 500,
      strength: 0.8,
      confidence: 0.95,
    })),
  });
  const result = planMashup(vocals, bed);
  assert.ok(result.ok);
  assert.equal(result.plan.arrangement?.evidence.pairedBeatGrids, false);
  assert.equal(result.plan.segments.length, 1);
  assert.equal(result.plan.segments[0]?.localTempoMap, undefined);
  assert.ok(result.plan.warnings.some((warning) => warning.includes("paired donor-and-bed beat-grid check was unavailable")));
});

// --- tempo octave ambiguity ------------------------------------------------

test("warp ratio: a folded bed reading does not double the vocal's stretch", () => {
  // A hats-heavy 72 BPM part reads 143.555 BPM at confidence 1.0 (measured on
  // the local analyser). Taking both readings at face value produced 0.697
  // where the truth is 1.389, so the vocal was compressed twice as hard as it
  // should have been. The pulse family makes the cheaper pairing available.
  // Arguments are (vocalCandidates, bedCandidates, vocalBpm, bedBpm).
  const folded = warpRatioForTempoCandidates([100], [143.555, 71.777, 287.11], 100, 143.555);
  assert.ok(Math.abs(folded.ratio - 1.393) < 0.01,
    `expected a ~1.39 ratio from the 71.777 BPM reading, got ${folded.ratio}`);
  assert.ok(Math.abs(folded.ratio - warpRatioForTempos(100, 143.555)) > 0.5,
    "the octave-aware ratio must differ materially from the face-value ratio");
  assert.ok(Math.abs(folded.bedBpm - 71.777) < 0.01, "the resolved bed octave must be reported");
  // Playing the vocal at 100/1.393 lands on 71.8 BPM against a 72 BPM bed.
  assert.ok(Math.abs(folded.ratio - 100 / 72) < 0.01, "the chosen warp must land the vocal on the bed's pulse");
});

test("warp ratio: without octave candidates the previous behaviour is unchanged", () => {
  for (const [vocal, bed] of [[102, 100], [140, 70], [200, 100], [300, 100], [40, 100]]) {
    const result = warpRatioForTempoCandidates(null, null, vocal!, bed!);
    assert.equal(result.ratio, warpRatioForTempos(vocal!, bed!),
      `no-candidate ratio for ${vocal}/${bed} must equal warpRatioForTempos`);
  }
});

test("warp ratio: octave-aware selection never asks for more stretch than the readings", () => {
  const cases: Array<[number[], number[], number, number]> = [
    [[143.555, 71.777], [99.384], 143.555, 99.384],
    [[129.199, 64.599], [178.206, 89.103], 129.199, 178.206],
    [[120.185, 60.093], [99.384], 120.185, 99.384],
  ];
  for (const [vocalCandidates, bedCandidates, vocalBpm, bedBpm] of cases) {
    const naive = Math.abs(Math.log(warpRatioForTempos(vocalBpm, bedBpm)));
    const chosen = warpRatioForTempoCandidates(vocalCandidates, bedCandidates, vocalBpm, bedBpm);
    assert.ok(Math.abs(Math.log(chosen.ratio)) <= naive + 1e-9,
      `octave-aware ${chosen.ratio} must not stretch more than ${warpRatioForTempos(vocalBpm, bedBpm)}`);
  }
});

test("plan: a folded bed tempo adopts the resolved octave for bars and warp together", () => {
  const vocals = profile({
    role: "vocals",
    durationMs: 120_000,
    bpm: 100,
    bpmConfidence: 0.9,
    bpmCandidates: [100, 50, 200],
  });
  const bed = profile({
    role: "instrumental",
    durationMs: 180_000,
    bpm: 143.555,
    bpmConfidence: 0.9,
    bpmCandidates: [143.555, 71.777, 287.11],
  });
  const result = planMashup(vocals, bed);
  assert.ok(result.ok);
  assert.ok(Math.abs(result.plan.vocalsStretchRatio - 1.393) < 0.01,
    `stretch should follow the resolved octave, got ${result.plan.vocalsStretchRatio}`);
  // The warp is the deciding evidence: the vocal must end up on the bed's pulse
  // rather than at twice its speed. Barely-stretched output is the failure.
  const playedVocalBpm = 100 / result.plan.vocalsStretchRatio;
  const octaveError = Math.min(...[0.5, 1, 2].map((k) => Math.abs(Math.log2(playedVocalBpm / (71.777 * k)))));
  assert.ok(octaveError < 0.02,
    `warped vocal should sit on the bed's pulse, got ${playedVocalBpm} BPM (${octaveError.toFixed(3)} octaves off)`);
  assert.ok(result.plan.rationale.some((line) => /octave resolved from the pulse family/i.test(line)),
    `expected the octave resolution to be explained, got: ${result.plan.rationale.join(" | ")}`);
});

test("plan: genuinely ambiguous octaves are reported, not silently guessed", () => {
  // The envelope cannot distinguish 60 from 120 BPM when every subdivision is
  // sounded, so the choice must be surfaced rather than presented as certain.
  const result = planMashup(
    profile({ role: "vocals", durationMs: 120_000, bpm: 99.384, bpmConfidence: 0.9, bpmCandidates: [99.384, 49.692, 198.768] }),
    profile({ role: "instrumental", durationMs: 180_000, bpm: 120.185, bpmConfidence: 0.9, bpmCandidates: [120.185, 60.092, 240.37] }),
  );
  assert.ok(result.ok);
  assert.ok(result.plan.warnings.some((warning) => /octave is ambiguous/i.test(warning)),
    `expected an ambiguity warning, got: ${result.plan.warnings.join(" | ")}`);
});
