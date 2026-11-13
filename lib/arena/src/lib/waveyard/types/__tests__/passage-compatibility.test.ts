import assert from "node:assert/strict";
import test from "node:test";

import {
  comparePassageCompatibility,
  parsePassageFingerprint,
  PASSAGE_FINGERPRINT_ENGINE,
  PASSAGE_FINGERPRINT_ENGINE_VERSION,
  type PassageFingerprint,
} from "../passage-compatibility";
import { buildAutomaticRemixPlan, type AutomaticRemixSource } from "../automatic-remix";

function measured<T>(value: T, method = "fixture") {
  return { status: "measured" as const, value, method, confidence: 0.9 };
}

function missing(reason: string) {
  return { status: "unavailable" as const, reason };
}

function fingerprint(checksum: string, startBeatIndex = 0, endBeatIndex = 16, overrides: Partial<PassageFingerprint> = {}): PassageFingerprint {
  return {
    schemaVersion: 3,
    engine: PASSAGE_FINGERPRINT_ENGINE,
    engineVersion: PASSAGE_FINGERPRINT_ENGINE_VERSION,
    sourceChecksumSha256: checksum,
    startBeatIndex,
    endBeatIndex,
    rhythm: measured(Array.from({ length: (endBeatIndex - startBeatIndex) * 4 }, (_, index) => index % 7 === 0 ? 1 : 0)),
    chroma: measured(Array.from({ length: 48 }, (_, index) => index % 12 === 0 ? 1 : -1 / 11)),
    beatPhase: measured({ subdivisionProfile: [1, 0, 0, 0], beatPeriodMs: 500 }),
    energy: measured({ rmsDb: -14 }),
    downbeatConfidence: missing("No independent downbeat analysis."),
    vocalActivity: missing("No isolated-vocal analysis."),
    instrumentalDensity: missing("No non-vocal stem activity envelope."),
    stemActivity: missing("No current separated-stem activity evidence."),
    ...overrides,
  };
}

function compatibility(anchor: PassageFingerprint, donor: PassageFingerprint) {
  return comparePassageCompatibility({
    anchorSectionId: "anchor-section",
    donorSectionId: "donor-section",
    anchor,
    donor,
    anchorBpm: 120,
    donorBpm: 120,
    anchorBeatConfidence: 0.9,
    donorBeatConfidence: 0.9,
    anchorKeyTrusted: false,
    donorKeyTrusted: false,
  });
}

function source(id: string, checksum: string, sections: AutomaticRemixSource["sections"]): AutomaticRemixSource {
  return {
    id,
    originalFilename: `${id}.wav`,
    checksumSha256: checksum,
    durationMs: 16_000,
    analysis: {
      id: `${id}-analysis`,
      status: "complete",
      sourceChecksumSha256: checksum,
      bpm: 120,
      bpmConfidence: 0.9,
      musicalKey: "C major",
      keyConfidence: 0.9,
      beatConfidence: 0.9,
      beatGridMs: Array.from({ length: 33 }, (_, index) => index * 500),
    },
    sections,
    stems: [
      { id: `${id}-drums`, sourceAssetId: id, stemType: "drums", durationMs: 16_000 },
      { id: `${id}-other`, sourceAssetId: id, stemType: "other", durationMs: 16_000 },
      { id: `${id}-vocals`, sourceAssetId: id, stemType: "vocals", durationMs: 16_000 },
    ],
  };
}

test("fingerprint parser binds every persisted feature to its exact source passage", () => {
  const value = fingerprint("sha-a");
  assert.deepEqual(parsePassageFingerprint(value, { sourceChecksumSha256: "sha-a", startBeatIndex: 0, endBeatIndex: 16 }), value);
  assert.equal(parsePassageFingerprint(value, { sourceChecksumSha256: "sha-b" }), null);
  assert.equal(parsePassageFingerprint({ ...value, rhythm: measured([1, 0]) }), null);
  assert.equal(parsePassageFingerprint({ ...value, downbeatConfidence: { status: "unavailable", reason: 8 } }), null);
  assert.equal(parsePassageFingerprint({ ...value, stemActivity: { status: "measured", value: [{ stemType: "vocals", sectionRmsDb: -10 }], method: "bad", confidence: null } }), null);
});

test("fingerprint parser preserves distinct vocal activity and pitch evidence", () => {
  const evidence = {
    status: "measured" as const,
    value: {
      activityCoverage: 0.42,
      meanActivityStrength: 0.81,
      pitchCoverage: 0.31,
      meanPitchConfidence: 0.77,
      analysisId: "analysis",
      stemAssetId: "vocal-stem",
      stemChecksumSha256: "b".repeat(64),
      activityIntervals: [{ startMs: 1_000, endMs: 2_000, confidence: 0.81 }],
      pitchContinuityRuns: [{ startMs: 1_200, endMs: 1_800, confidence: 0.77 }],
    },
    method: "Source/stem-checksum-current vocal RMS activity and pitch continuity; neither denotes lyrics",
    confidence: null,
  };
  const value = fingerprint("sha-a", 0, 16, { vocalActivity: evidence });
  assert.deepEqual(parsePassageFingerprint(value), value);
  assert.equal(parsePassageFingerprint({
    ...value,
    vocalActivity: { ...evidence, method: "x".repeat(121) },
  }), null, "oversized method metadata is rejected before persistence");
});

test("fingerprint parser validates checksum-bound rolling beat windows and rejects stale schemas", () => {
  const legacy = { ...fingerprint("sha-a"), schemaVersion: 2 };
  assert.equal(parsePassageFingerprint(legacy), null, "old pitch-only fingerprints must be rebuilt before use");
  const rolling = fingerprint("sha-a", 0, 16, {
    rollingWindows: measured([{
      startBeatIndex: 4,
      endBeatIndex: 12,
      rhythm: measured(Array.from({ length: 32 }, (_, index) => index % 4 === 0 ? 1 : 0)),
      chroma: measured(Array.from({ length: 48 }, (_, index) => index % 12 === 0 ? 1 : -1 / 11)),
      beatPhase: measured({ subdivisionProfile: [1, 0, 0, 0], beatPeriodMs: 500 }),
    }]),
  });
  assert.deepEqual(parsePassageFingerprint(rolling), rolling);
  const invalid = {
    ...rolling,
    rollingWindows: measured([{
      ...rolling.rollingWindows!.value[0]!,
      rhythm: measured([1, 0]),
    }]),
  };
  assert.equal(parsePassageFingerprint(invalid), null, "malformed local vectors are rejected rather than treated as evidence");
});

test("per-stem shifts are visible as context but never decide cross-song eligibility", () => {
  const stemActivity = {
    status: "measured" as const,
    method: "isolated-stem PCM RMS",
    confidence: null,
    value: [{
      stemType: "vocals",
      stemAssetId: "vocal-stem",
      separationJobId: "separation-job",
      stemChecksumSha256: "d".repeat(64),
      sectionRmsDb: -18,
      boundaryChanges: [{ beatIndex: 4, deltaDb: -9.2 }],
    }],
  };
  const result = compatibility(
    fingerprint("sha-a", 0, 16, { stemActivity }),
    fingerprint("sha-b", 0, 16, { stemActivity: missing("No matched stem audio.") }),
  );
  assert.equal(result.eligible, true);
  assert.equal(result.dimensions.stemActivity.status, "context");
  assert.match(result.dimensions.stemActivity.detail, /Anchor: vocals at beat 4 -9\.2 dB/);
  assert.match(result.dimensions.stemActivity.detail, /not a semantic role or compatibility gate/);
});

test("isolated vocal pitch-continuity runs remain visible context, not lyric claims or eligibility gates", () => {
  const vocalActivity = measured({
    activityCoverage: 0.38,
    meanActivityStrength: 0.81,
    pitchCoverage: 0.31,
    meanPitchConfidence: 0.8,
    analysisId: "vocal-analysis",
    stemAssetId: "vocal-stem",
    stemChecksumSha256: "d".repeat(64),
    activityIntervals: [{ startMs: 8_800, endMs: 10_600, confidence: 0.81 }],
    pitchContinuityRuns: [{ startMs: 9_000, endMs: 10_500, confidence: 0.8 }],
  });
  const donor = fingerprint("sha-b", 0, 16, { vocalActivity });
  const result = compatibility(fingerprint("sha-a"), donor);
  assert.equal(result.eligible, true);
  assert.equal(result.dimensions.vocalActivity.status, "context");
  assert.match(result.dimensions.vocalActivity.detail, /38% vocal-stem activity across 1 coarse interval/);
  assert.match(result.dimensions.vocalActivity.detail, /8\.8–10\.6 s/);
  assert.match(result.dimensions.vocalActivity.detail, /1 separate pitch-continuity run/);
  assert.match(result.dimensions.vocalActivity.detail, /not lyric or word boundaries/);
  assert.deepEqual(parsePassageFingerprint(donor, { sourceChecksumSha256: "sha-b" }), donor);
  assert.equal(parsePassageFingerprint({
    ...donor,
    vocalActivity: measured({
      ...vocalActivity.value,
      pitchContinuityRuns: [{ startMs: 12_000, endMs: 11_000, confidence: 0.8 }],
    }),
  }), null);
  assert.equal(parsePassageFingerprint({
    ...donor,
    vocalActivity: measured({
      ...vocalActivity.value,
      activityIntervals: [
        { startMs: 10_000, endMs: 11_000, confidence: 0.8 },
        { startMs: 9_000, endMs: 9_500, confidence: 0.8 },
      ],
    }),
  }), null, "activity windows must remain ordered and bounded");
});

test("compatibility requires separate rhythm, chroma, beat-phase, tempo and beat-confidence evidence", () => {
  const result = compatibility(fingerprint("a"), fingerprint("b"));
  assert.equal(result.eligible, true);
  assert.equal(result.dimensions.rhythm.status, "match");
  assert.equal(result.dimensions.harmony.status, "match");
  assert.equal(result.dimensions.beatPhase.status, "match");
  assert.equal(result.dimensions.vocalActivity.status, "unavailable");
  assert.equal(result.dimensions.instrumentalDensity.status, "unavailable");
  assert.equal(result.dimensions.downbeatConfidence.status, "unavailable");
  assert.deepEqual(result.missingEvidence, ["donor vocal activity", "anchor non-vocal stem activity", "downbeat confidence"]);
});

test("different whole-bar durations compare normalized rhythm shape without claiming an exact phrase match", () => {
  const rhythmShape = (beats: number) => Array.from({ length: beats * 4 }, (_, index) => {
    const position = index / (beats * 4);
    return Math.sin(position * Math.PI * 8) + Math.cos(position * Math.PI * 4) * 0.4;
  });
  const result = compatibility(
    fingerprint("sha-a", 0, 20, { rhythm: measured(rhythmShape(20)) }),
    fingerprint("sha-b", 0, 16, { rhythm: measured(rhythmShape(16)) }),
  );

  assert.equal(result.dimensions.phraseAlignment.status, "context");
  assert.equal(result.dimensions.phraseAlignment.similarity, 0.8);
  assert.match(result.dimensions.phraseAlignment.detail, /time-normalized for relative ranking/);
  assert.equal(result.dimensions.rhythm.status, "match");
  assert.ok((result.dimensions.rhythm.similarity ?? 0) > 0.99);
  assert.equal(result.eligible, false, "different durations remain a ranked comparison, not a core exact match");
});

test("a rhythm-only recurrence is never enough when the chroma sequence conflicts", () => {
  const chroma = Array.from({ length: 48 }, (_, index) => index % 12 === 7 ? 1 : -1 / 11);
  const result = compatibility(fingerprint("a"), fingerprint("b", 0, 16, { chroma: measured(chroma) }));
  assert.equal(result.dimensions.rhythm.status, "match");
  assert.equal(result.dimensions.harmony.status, "conflict");
  assert.equal(result.eligible, false);
});

test("off-phase accents and low beat confidence block an otherwise similar passage", () => {
  const offPhase = fingerprint("b", 0, 16, { beatPhase: measured({ subdivisionProfile: [0, 1, 0, 0], beatPeriodMs: 500 }) });
  assert.equal(compatibility(fingerprint("a"), offPhase).eligible, false);
  const lowConfidence = comparePassageCompatibility({
    anchorSectionId: "a", donorSectionId: "b", anchor: fingerprint("a"), donor: fingerprint("b"),
    anchorBpm: 120, donorBpm: 120, anchorBeatConfidence: 0.49, donorBeatConfidence: 0.9,
    anchorKeyTrusted: false, donorKeyTrusted: false,
  });
  assert.equal(lowConfidence.eligible, false);
});

test("automatic hybrid can use a measured passage match without semantic verse/chorus labels", () => {
  const anchor = source("a", "sha-a", [
    { id: "a-0", sectionIndex: 0, startMs: 0, endMs: 8_000, startBeatIndex: 0, endBeatIndex: 16, label: "section", labelConfidence: 0, structuralConfidence: 0.9, passageFingerprint: fingerprint("sha-a", 0, 16) },
    { id: "a-1", sectionIndex: 1, startMs: 8_000, endMs: 16_000, startBeatIndex: 16, endBeatIndex: 32, label: "section", labelConfidence: 0, structuralConfidence: 0.9, passageFingerprint: fingerprint("sha-a", 16, 32) },
  ]);
  const donor = source("b", "sha-b", [
    { id: "b-0", sectionIndex: 0, startMs: 0, endMs: 8_000, startBeatIndex: 0, endBeatIndex: 16, label: "section", labelConfidence: 0, structuralConfidence: 0.9, passageFingerprint: fingerprint("sha-b", 0, 16) },
    { id: "b-1", sectionIndex: 1, startMs: 8_000, endMs: 16_000, startBeatIndex: 16, endBeatIndex: 32, label: "section", labelConfidence: 0, structuralConfidence: 0.9, passageFingerprint: fingerprint("sha-b", 16, 32) },
  ]);
  const result = buildAutomaticRemixPlan([anchor, donor], { variant: "hybrid" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const vocals = result.plan.tracks.find((track) => track.stemType === "vocals");
  assert.equal(vocals?.stemAssetId, "b-vocals");
  assert.deepEqual(vocals?.clips.map((clip) => [clip.timelineStartMs, clip.sourceOffsetMs, clip.durationMs]), [
    [0, 0, 8_000],
    [8_000, 8_000, 8_000],
  ]);
  assert.equal(result.plan.compatibility?.eligiblePairs, 3);
  assert.equal(result.plan.compatibility?.pairs[0]?.anchorSourceName, "a.wav");
  assert.equal(result.plan.compatibility?.pairs[0]?.donorSourceName, "b.wav");
  assert.equal(result.plan.compatibility?.pairs[0]?.dimensions.phraseAlignment.status, "match");
  assert.ok(result.plan.notices.some((notice) => notice.includes("downbeat confidence")));
  assert.ok(result.plan.provenance.decisions.some((decision) => decision.includes("without requiring semantic")));
});

test("automatic hybrid reports mismatched harmony and uses fallback instead of rejecting", () => {
  const anchor = source("a", "sha-a", [
    { id: "a-0", sectionIndex: 0, startMs: 0, endMs: 8_000, startBeatIndex: 0, endBeatIndex: 16, label: "section", labelConfidence: 0, structuralConfidence: 0.9, passageFingerprint: fingerprint("sha-a", 0, 16) },
  ]);
  const donor = source("b", "sha-b", [
    { id: "b-0", sectionIndex: 0, startMs: 0, endMs: 8_000, startBeatIndex: 0, endBeatIndex: 16, label: "section", labelConfidence: 0, structuralConfidence: 0.9, passageFingerprint: fingerprint("sha-b", 0, 16, { chroma: measured(Array.from({ length: 48 }, (_, index) => index % 12 === 7 ? 1 : -1 / 11)) }) },
  ]);
  const result = buildAutomaticRemixPlan([anchor, donor], { variant: "hybrid" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.compatibility?.eligiblePairs, 0);
  assert.ok(result.plan.compatibility?.pairs.some((pair) => pair.dimensions.harmony.status === "conflict"));
  assert.ok(result.plan.notices.some((notice) => notice.includes("conservative alternating full-song passages")));
});

test("automatic hybrid reports tempo conflicts instead of hiding the donor", () => {
  const anchor = source("a", "sha-a", [
    { id: "a-0", sectionIndex: 0, startMs: 0, endMs: 8_000, startBeatIndex: 0, endBeatIndex: 16, label: "section", labelConfidence: 0, structuralConfidence: 0.9, passageFingerprint: fingerprint("sha-a", 0, 16) },
  ]);
  const donor = source("b", "sha-b", [
    { id: "b-0", sectionIndex: 0, startMs: 0, endMs: 8_000, startBeatIndex: 0, endBeatIndex: 16, label: "section", labelConfidence: 0, structuralConfidence: 0.9, passageFingerprint: fingerprint("sha-b", 0, 16) },
  ]);
  if (donor.analysis) donor.analysis.bpm = 100;
  const result = buildAutomaticRemixPlan([anchor, donor], { variant: "hybrid" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.compatibility?.pairs[0]?.dimensions.tempo.status, "conflict");
  assert.match(result.plan.compatibility?.pairs[0]?.dimensions.tempo.detail ?? "", /100\.0 BPM/);
  assert.ok(result.plan.notices.some((notice) => notice.includes("conservative alternating full-song passages")));
});
