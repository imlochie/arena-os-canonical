import assert from "node:assert/strict";
import test from "node:test";
import { invalidateCompositionEvidence } from "./composition-evidence";
import { planMashup, type MashupSourceProfile } from "./mashup";
import {
  measuredEvidence,
  MUSICAL_EVIDENCE_PACKET_FORMAT,
  type MusicalEvidenceProvenance,
} from "./musical-evidence";

function profile(): MashupSourceProfile {
  const provenance: MusicalEvidenceProvenance = {
    analysisEngine: "test",
    analysisEngineVersion: "1",
    sourceChecksumSha256: "old-mix",
    persistence: "database",
  };
  const tempo = { bpm: 120, confidence: 0.99 };
  const grid = Array.from({ length: 40 }, (_, index) => index * 500);
  const sections = [{ label: "verse", startMs: 6_000, endMs: 20_000 }];
  const attacks = [{ timestampMs: 6_000, strength: 1, confidence: 0.99 }];
  return {
    role: "instrumental",
    sourceAssetId: "bed",
    sourceChecksumSha256: "old-mix",
    durationMs: 20_000,
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    bpmCandidates: [120, 60],
    musicalKey: "C major",
    keyConfidence: 0.99,
    beatGridMs: grid,
    beatConfidence: 0.99,
    downbeatGridMs: grid.filter((_, index) => index % 4 === 0),
    downbeatConfidence: 0.99,
    sections,
    drumEvents: attacks,
    bassEvents: attacks,
    vocalPhrases: [{ startMs: 6_000, endMs: 7_000, confidence: 0.99 }],
    harmonyEvidenceSource: "separated-stem",
    harmonyEvidenceStemType: "bass",
    evidence: {
      format: MUSICAL_EVIDENCE_PACKET_FORMAT,
      source: { assetId: "bed", checksumSha256: "old-mix", durationMs: 20_000 },
      features: {
        tempo: measuredEvidence(tempo, provenance),
        key: measuredEvidence({ key: "C major", confidence: 0.99 }, provenance),
        beatGrid: measuredEvidence({ beatsMs: grid, confidence: 0.99 }, provenance),
        sections: measuredEvidence(sections, provenance),
        vocalPhrases: measuredEvidence([{ startMs: 6_000, endMs: 7_000, confidence: 0.99 }], provenance),
        harmony: measuredEvidence([], provenance),
        drumEvents: measuredEvidence(attacks, provenance),
        bassAttacks: measuredEvidence(attacks, provenance),
      },
    },
  };
}

test("a composition edit invalidates packet and flat measurements without changing source identity", () => {
  const original = profile();
  const before = structuredClone(original);
  const changed = invalidateCompositionEvidence(original, ["drums", "bass"]);
  assert.deepEqual(original, before, "recomputation must not mutate another candidate's evidence");
  assert.equal(changed.sourceAssetId, original.sourceAssetId);
  assert.equal(changed.sourceChecksumSha256, original.sourceChecksumSha256);
  assert.equal(changed.durationMs, original.durationMs);
  for (const value of Object.values(changed.evidence!.features)) {
    assert.equal(value.status, "unavailable", "no original-mix measurement may survive the edit");
  }
  for (const key of ["bpm", "bpmConfidence", "bpmCandidates", "musicalKey", "keyConfidence",
    "beatGridMs", "beatConfidence", "downbeatGridMs", "downbeatConfidence"] as const) {
    assert.equal(changed[key], null, key);
  }
  for (const key of ["sections", "drumEvents", "bassEvents", "vocalPhrases",
    "vocalActivityIntervals", "vocalPitchFrames", "harmonyEvents"] as const) {
    assert.deepEqual(changed[key], [], key);
  }
  assert.equal(changed.harmonyEvidenceSource, undefined);
});

test("no edit preserves existing evidence; legacy sessions without packets are invalidated too", () => {
  const original = profile();
  assert.equal(invalidateCompositionEvidence(original, []), original);
  const legacy = { ...original, evidence: undefined };
  assert.equal(invalidateCompositionEvidence(legacy, ["other"]).beatGridMs, null);
});

test("planner cannot revive the previous section entry or confident tempo after an edit", () => {
  const original = profile();
  const donor: MashupSourceProfile = {
    role: "vocals", durationMs: 10_000, bpm: null, musicalKey: null, sections: [],
  };
  const before = planMashup(donor, original, { strategy: "continuous" });
  const changed = invalidateCompositionEvidence(original, ["drums"]);
  const after = planMashup(donor, changed, { strategy: "continuous" });
  assert.ok(before.ok && after.ok, "missing measurements must not block creation");
  assert.equal(before.plan.segments[0]!.mashupStartMs, 6_000);
  assert.notEqual(after.plan.segments[0]!.mashupStartMs, 6_000,
    "the original-mix verse boundary is not a valid entry for the changed mix");
  assert.ok(after.plan.warnings.some((warning) => /tempo|BPM/i.test(warning)));
});

test("fresh measurements can replace invalidated values without restoring other old evidence", () => {
  const changed = invalidateCompositionEvidence(profile(), ["bass"]);
  changed.bpm = 100;
  changed.bpmConfidence = 0.95;
  changed.evidence!.features.tempo = measuredEvidence({ bpm: 100, confidence: 0.95 }, {
    analysisEngine: "composition-test",
    analysisEngineVersion: "1",
    sourceChecksumSha256: changed.sourceChecksumSha256!,
    persistence: "request",
  });
  const result = planMashup({
    role: "vocals", durationMs: 5_000, bpm: 100, bpmConfidence: 0.95,
    musicalKey: null, sections: [],
  }, changed, { strategy: "continuous" });
  assert.ok(result.ok);
  assert.equal(result.plan.masterBpm, 100);
  assert.equal(changed.evidence!.features.harmony.status, "unavailable");
  assert.equal(changed.downbeatGridMs, null);
});
