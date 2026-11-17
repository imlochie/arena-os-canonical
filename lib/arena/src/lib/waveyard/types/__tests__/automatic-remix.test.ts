import { describe, it } from "node:test";
import { expect } from "../../test-shim";
import {
  AUTOMATIC_REMIX_ENGINE,
  assessWholeHybridArrangement,
  buildAutomaticRemixPlan,
  type AutomaticRemixSource,
} from "../index";

type SourceOverrides = Omit<Partial<AutomaticRemixSource>, "analysis"> & {
  analysis?: Partial<NonNullable<AutomaticRemixSource["analysis"]>> | null;
};

function source(overrides: SourceOverrides & Pick<AutomaticRemixSource, "id">): AutomaticRemixSource {
  const id = overrides.id;
  const defaultAnalysis = {
    id: `${id}-analysis`, status: "complete", sourceChecksumSha256: `${id}-checksum`, bpm: 120, bpmConfidence: 0.9,
    musicalKey: "C major", keyConfidence: 0.9, beatConfidence: 0.9,
    beatGridMs: Array.from({ length: 33 }, (_, index) => index * 500),
  };
  return {
    originalFilename: `${id}.wav`,
    checksumSha256: `${id}-checksum`,
    durationMs: 16_000,
    analysis: defaultAnalysis,
    sections: [
      { id: `${id}-a`, sectionIndex: 0, startMs: 0, endMs: 8_000, label: "section", labelConfidence: 0, structuralConfidence: 0.9 },
      { id: `${id}-b`, sectionIndex: 1, startMs: 8_000, endMs: 16_000, label: "section", labelConfidence: 0, structuralConfidence: 0.9 },
    ],
    stems: [
      { id: `${id}-drums`, sourceAssetId: id, stemType: "drums", durationMs: 16_000 },
      { id: `${id}-bass`, sourceAssetId: id, stemType: "bass", durationMs: 16_000 },
      { id: `${id}-other`, sourceAssetId: id, stemType: "other", durationMs: 16_000 },
      { id: `${id}-vocals`, sourceAssetId: id, stemType: "vocals", durationMs: 16_000 },
    ],
    ...overrides,
    analysis: overrides.analysis === null ? null : { ...defaultAnalysis, ...overrides.analysis },
  };
}

/**
 * A measured passage fingerprint that passes the rhythm/chroma/beat-phase
 * eligibility checks, so a hybrid can actually be built in these tests.
 */
function measuredFingerprint(checksum: string, startBeatIndex: number, endBeatIndex: number) {
  const measure = <T>(value: T) => ({ status: "measured" as const, value, method: "fixture", confidence: 0.95 });
  return {
    schemaVersion: 3 as const,
    engine: "waveyard-passage-fingerprint" as const,
    engineVersion: "2.2.0" as const,
    sourceChecksumSha256: checksum,
    startBeatIndex,
    endBeatIndex,
    rhythm: measure(Array.from({ length: (endBeatIndex - startBeatIndex) * 4 }, (_, index) => Number(index % 4 === 0))),
    chroma: measure(Array.from({ length: 48 }, (_, index) => {
      const pitch = index % 12;
      return pitch === 0 ? 1 : pitch === 4 ? 0.75 : pitch === 7 ? 0.5 : 0.02;
    })),
    beatPhase: measure({ subdivisionProfile: [0.9, 0.05, 0.03, 0.02], beatPeriodMs: 500 }),
    energy: measure({ rmsDb: -12 }),
    downbeatConfidence: measure(0.95),
    vocalActivity: { status: "unavailable" as const, reason: "fixture" },
    instrumentalDensity: { status: "unavailable" as const, reason: "fixture" },
    stemActivity: { status: "unavailable" as const, reason: "fixture" },
  };
}

function withFingerprints(input: AutomaticRemixSource): AutomaticRemixSource {
  return {
    ...input,
    sections: input.sections.map((section) => ({
      ...section,
      passageFingerprint: measuredFingerprint(input.checksumSha256, section.startMs / 500, section.endMs / 500),
    })),
  };
}

function withDifferentSourceMixChroma(input: AutomaticRemixSource): AutomaticRemixSource {
  return {
    ...input,
    sections: input.sections.map((section) => ({
      ...section,
      passageFingerprint: section.passageFingerprint ? {
        ...section.passageFingerprint,
        chroma: {
          status: "measured" as const,
          method: "fixture",
          confidence: 0.95,
          value: Array.from({ length: 48 }, (_, index) => {
            const pitch = index % 12;
            return pitch === 2 ? 1 : pitch === 6 ? 0.75 : pitch === 9 ? 0.5 : 0.02;
          }),
        },
      } : null,
    })),
  };
}

function withRoles(input: AutomaticRemixSource, labels: string[] = ["verse", "chorus"]): AutomaticRemixSource {
  return {
    ...input,
    sections: input.sections.map((section, index) => ({
      ...section,
      label: labels[index] ?? "section",
      labelConfidence: labels[index] ? 0.9 : 0,
      structuralConfidence: 0.9,
    })),
  };
}

describe("deterministic automatic remix arranger", () => {
  it("builds a faithful section-aware arrangement using ordinary clip intent", () => {
    const result = buildAutomaticRemixPlan([source({ id: "a" })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tracks.map((track) => track.stemType)).toEqual(["drums", "bass", "other", "vocals"]);
    expect(result.plan.tracks[0].clips).toEqual([
      expect.objectContaining({ timelineStartMs: 0, durationMs: 8_000, sourceOffsetMs: 0, beatSnapEnabled: true, tempoSyncEnabled: false, keySyncEnabled: false }),
      expect.objectContaining({ timelineStartMs: 8_000, durationMs: 8_000, sourceOffsetMs: 8_000, beatSnapEnabled: true }),
    ]);
    expect(result.plan.provenance).toMatchObject({ engine: AUTOMATIC_REMIX_ENGINE, variant: "original", anchorSourceId: "a", targetBpm: 120, targetKey: "C major" });
  });

  it("maps every verified structural section into contiguous clips", () => {
    const result = buildAutomaticRemixPlan([source({
      id: "a",
      sections: [
        { id: "a-a", sectionIndex: 0, startMs: 200, endMs: 8_000 },
        { id: "a-b", sectionIndex: 1, startMs: 8_000, endMs: 12_500 },
        { id: "a-c", sectionIndex: 2, startMs: 12_500, endMs: 15_800 },
      ],
    })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedWindows = [
      { timelineStartMs: 0, durationMs: 7_800, sourceOffsetMs: 200 },
      { timelineStartMs: 7_800, durationMs: 4_500, sourceOffsetMs: 8_000 },
      { timelineStartMs: 12_300, durationMs: 3_300, sourceOffsetMs: 12_500 },
    ];
    expect(result.plan.tracks).toHaveLength(4);
    for (const track of result.plan.tracks)
      expect(track.clips).toEqual(
        expectedWindows.map((window) => expect.objectContaining(window)),
      );
  });

  it("creates the same explainable plan for the same authoritative inputs", () => {
    const inputs = [source({ id: "a" }), source({ id: "b" })];
    expect(buildAutomaticRemixPlan(inputs, { variant: "hybrid" })).toEqual(buildAutomaticRemixPlan(inputs, { variant: "hybrid" }));
  });

  it("does not admit an alternate vocal from global key and role labels without passage evidence", () => {
    const anchor = withRoles(source({ id: "a" }));
    const donor = withRoles(source({
      id: "b",
      analysis: { id: "b-analysis", status: "complete", sourceChecksumSha256: "b-checksum", bpm: 124, musicalKey: "D major", beatGridMs: Array.from({ length: 33 }, (_, index) => index * 484) },
    }));
    const result = buildAutomaticRemixPlan([anchor, donor], { variant: "hybrid" });
    expect(result).toMatchObject({ ok: false, reason: "hybrid_evidence_unavailable" });
    if (!result.ok) expect(result.compatibility?.missingEvidence.some((reason) => reason.includes("passage fingerprints"))).toBe(true);
  });

  it("uses trusted beat-grid tempo for donor adaptation when raw BPM confidence is weak", () => {
    const anchor = withFingerprints(source({
      id: "a",
      durationMs: 22_000,
      analysis: { bpm: 110, bpmConfidence: 0.9 },
    }));
    const donor = withFingerprints(source({
      id: "b",
      durationMs: 22_000,
      analysis: {
        id: "b-analysis",
        status: "complete",
        sourceChecksumSha256: "b-checksum",
        analysisEngine: "arena-js-dsp",
        analysisEngineVersion: "1.4.0",
        bpm: 109.957,
        bpmConfidence: 0.426,
        beatConfidence: 0.642,
        beatGridMs: Array.from({ length: 41 }, (_, index) => Math.round(index * 60_000 / 110)),
      },
    }));

    const result = buildAutomaticRemixPlan([anchor, donor], {
      variant: "hybrid",
      anchorSourceId: "a",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tempoBpm).toBe(110);
    expect(result.plan.tracks.some((track) => track.stemAssetId === "b-vocals"
      && track.clips.some((clip) => clip.tempoSyncEnabled))).toBe(true);
  });

  it("withholds a hybrid when passage evidence is unavailable", () => {
    const result = buildAutomaticRemixPlan([source({ id: "a" }), source({ id: "b" })], { variant: "hybrid" });
    expect(result).toMatchObject({ ok: false, reason: "hybrid_evidence_unavailable" });
    if (!result.ok) expect(result.compatibility?.missingEvidence.join(" ").includes("passage fingerprints")).toBe(true);
  });

  it("withholds a hybrid when neither semantic roles nor passage fingerprints support a pairing", () => {
    for (const structuralLabel of ["pattern-repeat-a", "rhythm-repeat-a", "energy-rise", "energy-drop"]) {
      const anchor = withRoles(source({ id: "a" }), [structuralLabel, structuralLabel]);
      const donor = withRoles(source({ id: "b" }), [structuralLabel, structuralLabel]);
      const result = buildAutomaticRemixPlan([anchor, donor], { variant: "hybrid" });
      expect(result).toMatchObject({ ok: false, reason: "hybrid_evidence_unavailable" });
    }
  });

  it("withholds a hybrid instead of mapping reversed unsupported role order by ordinal position", () => {
    const anchor = withRoles(source({ id: "a" }));
    const donor = withRoles(source({ id: "b" }), ["chorus", "verse"]);
    const result = buildAutomaticRemixPlan([anchor, donor], { variant: "hybrid" });
    expect(result).toMatchObject({ ok: false, reason: "hybrid_evidence_unavailable" });
  });

  it("withholds a hybrid when low-confidence tempo, key, or beat evidence cannot support alignment", () => {
    const anchor = withRoles(source({ id: "a" }));
    const donor = withRoles(source({
      id: "b",
      analysis: {
        id: "b-analysis", status: "complete", sourceChecksumSha256: "b-checksum", bpm: 120, bpmConfidence: 0.49,
        musicalKey: "C major", keyConfidence: 0.49, beatConfidence: 0.49, beatGridMs: Array.from({ length: 33 }, (_, index) => index * 500),
      },
    }));
    const result = buildAutomaticRemixPlan([anchor, donor], { variant: "hybrid" });
    expect(result).toMatchObject({ ok: false, reason: "hybrid_evidence_unavailable" });
  });

  it("does not beat-snap an anchor whose BPM confidence is below the trusted threshold", () => {
    const uncertain = source({
      id: "uncertain",
      analysis: { bpmConfidence: 0.49 },
    });
    const result = buildAutomaticRemixPlan([uncertain]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tempoBpm).toBe(120);
    expect(result.plan.tracks[0].clips).toEqual([
      expect.objectContaining({ tempoSyncEnabled: false, beatSnapEnabled: false }),
    ]);
    expect(result.plan.notices).toContain("Tempo confidence is insufficient, so Waveyard will not claim BPM matching or beat snapping for this arrangement.");
  });

  it("withholds a hybrid when an incompatible source lacks passage evidence for a fit", () => {
    const incompatible = source({ id: "b", analysis: { id: "b-analysis", status: "complete", sourceChecksumSha256: "b-checksum", bpm: 168, musicalKey: "F# minor", beatGridMs: Array.from({ length: 33 }, (_, index) => index * 357) } });
    const result = buildAutomaticRemixPlan([source({ id: "a" }), incompatible], { variant: "hybrid" });
    expect(result).toMatchObject({ ok: false, reason: "hybrid_evidence_unavailable" });
  });

  it("lets isolated drum evidence decide a drum swap without gating on discarded harmony", () => {
    const withDrumEvidence = (input: AutomaticRemixSource): AutomaticRemixSource => {
      const stem = input.stems.find((candidate) => candidate.stemType === "drums")!;
      const checksum = `${input.id}-drum-checksum`;
      const events = Array.from({ length: 32 }, (_, index) => ({
        timestampMs: index * 500,
        strength: 1,
        confidence: 0.95,
      }));
      return {
        ...input,
        stems: input.stems.map((candidate) =>
          candidate.id === stem.id ? { ...candidate, checksumSha256: checksum } : candidate),
        drumEvidence: {
          analysisEngine: "waveyard-numpy-drum-transients",
          analysisEngineVersion: "1.0.0",
          stemAssetId: stem.id,
          stemType: "drums",
          stemChecksumSha256: checksum,
          sourceChecksumSha256: input.checksumSha256,
          events,
        },
      };
    };
    const anchor = withDrumEvidence(withFingerprints(source({ id: "drum-anchor" })));
    const donor = withDrumEvidence(withDifferentSourceMixChroma(withFingerprints(source({ id: "drum-donor" }))));

    const result = buildAutomaticRemixPlan([anchor, donor], {
      variant: "hybrid",
      anchorSourceId: anchor.id,
      drumsStemId: "drum-donor-drums",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tracks.find((track) => track.stemType === "drums")?.stemAssetId).toBe("drum-donor-drums");
    expect(result.plan.compatibility?.pairs.some((pair) =>
      pair.donorSourceName === donor.originalFilename
      && pair.eligible
      && pair.dimensions.harmony.status === "context"
      && pair.dimensions.harmony.detail.includes("not a gate for a drum swap"))).toBe(true);
  });

  it("shows missing donor provenance and withholds the hybrid", () => {
    const donor = source({
      id: "b",
      analysis: {
        id: "b-analysis",
        status: "processing",
        sourceChecksumSha256: "b-checksum",
        bpm: null,
        musicalKey: null,
        beatGridMs: null,
      },
    });
    const result = buildAutomaticRemixPlan([source({ id: "a" }), donor], { variant: "hybrid" });
    expect(result).toMatchObject({ ok: false, reason: "hybrid_evidence_unavailable" });
    if (!result.ok) expect(result.compatibility?.missingEvidence.join(" ").includes("current checksum-verified source analysis")).toBe(true);
  });

  it("refuses a hybrid when anchor structural evidence is incomplete", () => {
    const unknown = source({ id: "unproven", analysis: { id: "unproven-analysis", status: "processing", sourceChecksumSha256: "unproven-checksum", bpm: null, musicalKey: null, beatGridMs: null }, sections: [] });
    const result = buildAutomaticRemixPlan([unknown], { variant: "hybrid", instrumental: true });
    expect(result).toMatchObject({ ok: false, reason: "hybrid_evidence_unavailable" });
    if (!result.ok) expect(result.compatibility?.missingEvidence.join(" ").includes("current checksum-verified source analysis")).toBe(true);
  });

  it("rejects an empty source set rather than inventing material", () => {
    expect(buildAutomaticRemixPlan([])).toEqual({ ok: false, reason: "no_usable_source" });
  });
});

describe("retained-stem harmonic selection", () => {
  const bedChords = (root: number) => [{
    startMs: 0, endMs: 16_000,
    root: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][root]!,
    quality: "major" as const,
    confidence: 0.6,
  }];
  // A sustained C-major arpeggio in the donor's own key.
  const arpeggio = Array.from({ length: 32 }, (_, index) => ({
    startMs: index * 500,
    endMs: index * 500 + 480,
    midiNote: [60, 64, 67][index % 3]!,
    velocity: 100,
  }));

  it("uses the retained vocal and bed harmony instead of discarded donor-mix chroma", () => {
    const anchorBase = withFingerprints(source({ id: "role-anchor" }));
    const anchor = {
      ...anchorBase,
      bedHarmony: {
        analysisEngine: "arena-js-stem-harmony",
        analysisEngineVersion: "1.0.0",
        stemAssetId: "role-anchor-other",
        stemType: "other",
        stemChecksumSha256: "role-anchor-other-checksum",
        sourceChecksumSha256: anchorBase.checksumSha256,
        events: bedChords(0),
      },
    };
    const donor = withDifferentSourceMixChroma(withFingerprints(source({
      id: "role-donor",
      vocalNotes: arpeggio,
    })));

    const result = buildAutomaticRemixPlan([anchor, donor], {
      variant: "hybrid",
      anchorSourceId: anchor.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tracks.find((track) => track.stemType === "vocals")?.stemAssetId).toBe("role-donor-vocals");
    expect(result.plan.compatibility?.pairs.some((pair) =>
      pair.donorSourceName === donor.originalFilename
      && pair.eligible
      && pair.dimensions.harmony.status === "match"
      && pair.dimensions.harmony.detail.includes("Isolated donor-vocal notes"))).toBe(true);
  });

  it("does not let source-mix chroma overrule measured vocal conflict with the retained bed", () => {
    const anchorBase = withFingerprints(source({ id: "conflict-anchor" }));
    const anchor = {
      ...anchorBase,
      bedHarmony: {
        analysisEngine: "arena-js-stem-harmony",
        analysisEngineVersion: "1.0.0",
        stemAssetId: "conflict-anchor-other",
        stemType: "other",
        stemChecksumSha256: "conflict-anchor-other-checksum",
        sourceChecksumSha256: anchorBase.checksumSha256,
        events: bedChords(0),
      },
    };
    const donor = withFingerprints(source({
      id: "conflict-donor",
      vocalNotes: arpeggio.map((note) => ({ ...note, midiNote: note.midiNote + 1 })),
    }));

    const result = buildAutomaticRemixPlan([anchor, donor], {
      variant: "hybrid",
      anchorSourceId: anchor.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.compatibility?.pairs.some((pair) =>
      pair.donorSourceName === donor.originalFilename
      && pair.dimensions.harmony.status === "conflict"
      && pair.dimensions.harmony.detail.includes("Isolated donor-vocal notes"))).toBe(true);
  });

  it("avoids a donor section with measured silence and preserves the active vocal entry offset", () => {
    const anchorBase = withFingerprints(source({ id: "entry-anchor" }));
    const anchor = {
      ...anchorBase,
      bedHarmony: {
        analysisEngine: "arena-js-stem-harmony",
        analysisEngineVersion: "1.0.0",
        stemAssetId: "entry-anchor-other",
        stemType: "other",
        stemChecksumSha256: "entry-anchor-other-checksum",
        sourceChecksumSha256: anchorBase.checksumSha256,
        events: bedChords(0),
      },
    };
    const donorBase = withFingerprints(source({
      id: "entry-donor",
      vocalNotes: arpeggio.filter((note) => note.startMs >= 8_000),
    }));
    const donor = {
      ...donorBase,
      sections: donorBase.sections.map((section, index) => ({
        ...section,
        passageFingerprint: {
          ...section.passageFingerprint!,
          vocalActivity: {
            status: "measured" as const,
            method: "fixture: isolated-vocal activity",
            confidence: null,
            value: {
              activityCoverage: index === 0 ? 0 : 0.125,
              meanActivityStrength: index === 0 ? 0 : 0.9,
              pitchCoverage: 0,
              meanPitchConfidence: 0,
              analysisId: "entry-vocal-analysis",
              stemAssetId: "entry-donor-vocals",
              stemChecksumSha256: "entry-vocal-checksum",
              activityIntervals: index === 0 ? [] : [{ startMs: 8_500, endMs: 9_500, confidence: 0.9 }],
              pitchContinuityRuns: [],
            },
          },
        },
      })),
    };

    const result = buildAutomaticRemixPlan([anchor, donor], {
      variant: "hybrid",
      anchorSourceId: anchor.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const vocalTrack = result.plan.tracks.find((track) => track.stemType === "vocals");
    expect(vocalTrack?.stemAssetId).toBe("entry-donor-vocals");
    expect(vocalTrack?.clips).toEqual([
      expect.objectContaining({ timelineStartMs: 0, sourceOffsetMs: 8_000, durationMs: 8_000 }),
    ]);
    expect(result.plan.compatibility?.pairs.some((pair) =>
      pair.donorSectionId === "entry-donor-a"
      && pair.dimensions.vocalActivity.status === "conflict"
      && pair.dimensions.vocalActivity.detail.includes("no vocal content"))).toBe(true);
    expect(result.plan.compatibility?.pairs.some((pair) =>
      pair.donorSectionId === "entry-donor-b"
      && pair.eligible
      && pair.dimensions.vocalActivity.detail.includes("would enter 500 ms"))).toBe(true);
  });

  it("does not call a vocal silent when pitch events contradict an empty activity detector", () => {
    const anchorBase = withFingerprints(source({ id: "pitch-anchor" }));
    const anchor = {
      ...anchorBase,
      bedHarmony: {
        analysisEngine: "arena-js-stem-harmony",
        analysisEngineVersion: "1.0.0",
        stemAssetId: "pitch-anchor-other",
        stemType: "other",
        stemChecksumSha256: "pitch-anchor-other-checksum",
        sourceChecksumSha256: anchorBase.checksumSha256,
        events: bedChords(0),
      },
    };
    const donorBase = withFingerprints(source({ id: "pitch-donor", vocalNotes: arpeggio }));
    const donor = {
      ...donorBase,
      sections: donorBase.sections.map((section) => ({
        ...section,
        passageFingerprint: {
          ...section.passageFingerprint!,
          vocalActivity: {
            status: "measured" as const,
            method: "fixture: isolated-vocal activity",
            confidence: null,
            value: {
              activityCoverage: 0,
              meanActivityStrength: 0,
              pitchCoverage: 0,
              meanPitchConfidence: 0,
              analysisId: "pitch-vocal-analysis",
              stemAssetId: "pitch-donor-vocals",
              stemChecksumSha256: "pitch-vocal-checksum",
              activityIntervals: [],
              pitchContinuityRuns: [],
            },
          },
        },
      })),
    };

    const result = buildAutomaticRemixPlan([anchor, donor], {
      variant: "hybrid",
      anchorSourceId: anchor.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tracks.find((track) => track.stemType === "vocals")?.stemAssetId).toBe("pitch-donor-vocals");
    expect(result.plan.compatibility?.pairs.some((pair) =>
      pair.eligible
      && pair.dimensions.vocalActivity.detail.includes("but checksum-current isolated-vocal pitch evidence"))).toBe(true);
  });

  it("judges the whole hybrid at the same BPM-mapped times the saved clips will play", () => {
    const anchor = source({
      id: "tempo-anchor",
      analysis: { bpm: 120, bpmConfidence: 0.9 },
      sections: [{ id: "anchor-passage", sectionIndex: 0, startMs: 0, endMs: 8_000 }],
      bedHarmony: {
        analysisEngine: "arena-js-stem-harmony",
        analysisEngineVersion: "1.0.0",
        stemAssetId: "tempo-anchor-other",
        stemType: "other",
        stemChecksumSha256: "tempo-anchor-other-checksum",
        sourceChecksumSha256: "tempo-anchor-checksum",
        events: bedChords(0),
      },
    });
    const donor = source({
      id: "tempo-donor",
      analysis: {
        bpm: 100,
        bpmConfidence: 0.9,
        beatGridMs: Array.from({ length: 33 }, (_, index) => index * 600),
      },
      sections: [{ id: "donor-passage", sectionIndex: 0, startMs: 0, endMs: 10_000 }],
      vocalNotes: [{ startMs: 4_800, endMs: 7_200, midiNote: 60, velocity: 100 }],
    });

    const result = assessWholeHybridArrangement({
      anchor,
      donor,
      counterparts: new Map([["anchor-passage", donor.sections[0]!]]),
    });

    expect(result.status).toBe("measured");
    if (result.status === "measured") {
      const section = result.harmony.sections[0];
      expect(section?.status).toBe("measured");
      if (section?.status !== "measured") return;
      // 8,000 ms at 120 BPM consumes 9,600 ms at 100 BPM. The saved WSOLA
      // map therefore places this note at 4,000 ms, not at 3,840 ms (the
      // incorrect whole-section 8,000/10,000 mapping).
      expect(section.stretchRatio).toBe(8_000 / 9_600);
      expect(section.assessment.relations[0]?.startMs).toBe(4_000);
    }
  });

  it("does not judge a whole hybrid using donor audio beyond the selected section", () => {
    const anchor = source({
      id: "short-anchor",
      analysis: { bpm: 120, bpmConfidence: 0.9 },
      sections: [{ id: "anchor-passage", sectionIndex: 0, startMs: 0, endMs: 8_000 }],
      bedHarmony: {
        analysisEngine: "arena-js-stem-harmony",
        analysisEngineVersion: "1.0.0",
        stemAssetId: "short-anchor-other",
        stemType: "other",
        stemChecksumSha256: "short-anchor-other-checksum",
        sourceChecksumSha256: "short-anchor-checksum",
        events: bedChords(0),
      },
    });
    const donor = source({
      id: "short-donor",
      analysis: {
        bpm: 100,
        bpmConfidence: 0.9,
        beatGridMs: Array.from({ length: 33 }, (_, index) => index * 600),
      },
      sections: [{ id: "donor-passage", sectionIndex: 0, startMs: 0, endMs: 9_500 }],
      vocalNotes: arpeggio,
    });

    const result = assessWholeHybridArrangement({
      anchor,
      donor,
      counterparts: new Map([["anchor-passage", donor.sections[0]!]]),
    });

    expect(result).toMatchObject({ status: "unavailable" });
    if (result.status === "unavailable")
      expect(result.reason).toContain("exact source span required by its tempo-synced clip");
  });

  it("prefers the donor vocal that fits the retained bed, not the one with more passage matches", () => {
    // Anchor bed is C major. Donor "fits" is a C arpeggio; donor "clashes" sits a
    // semitone up. Both have structurally compatible passages, so the old
    // count-of-matches ordering could not tell them apart.
    const anchor = withFingerprints(source({ id: "a", bedHarmony: undefined }));
    const withBed = {
      ...anchor,
      bedHarmony: {
        analysisEngine: "arena-js-stem-harmony", analysisEngineVersion: "1.0.0",
        stemAssetId: "a-other", stemType: "other", stemChecksumSha256: "a-other-checksum",
        sourceChecksumSha256: "a-checksum", events: bedChords(0),
      },
    };
    const fits = withFingerprints(source({ id: "fits", vocalNotes: arpeggio }));
    const clashes = withFingerprints(source({
      id: "clashes",
      vocalNotes: arpeggio.map((note) => ({ ...note, midiNote: note.midiNote + 1 })),
    }));

    // Order matters: "clashes" is offered first, so a tie falls back to it.
    const result = buildAutomaticRemixPlan([withBed, clashes, fits], {
      variant: "hybrid", vocalStemId: undefined, anchorSourceId: "a",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const vocalTrack = result.plan.tracks.find((track) => track.stemType === "vocals");
    expect(vocalTrack).toBeDefined();
    // The chosen vocal must come from the fitting donor.
    expect(String(vocalTrack!.stemAssetId)).toContain("fits");
  });

  /** A structurally usable bed carrying a checksum-bound chord analysis. */
  const bedWithBass = (id: string, line: unknown[] | null) => {
    const base = withFingerprints(source({ id, bedHarmony: undefined }));
    return {
      ...base,
      bassLine: line as never,
      bedHarmony: {
        analysisEngine: "arena-js-stem-harmony", analysisEngineVersion: "1.0.0",
        stemAssetId: `${id}-other`, stemType: "other", stemChecksumSha256: `${id}-other-checksum`,
        sourceChecksumSha256: base.checksumSha256, events: bedChords(0),
      },
    };
  };
  /** A bass line of repeated notes; one MIDI pitch per 4-bar phrase. */
  const bassLine = (pitches: number[], confidence = 0.9) => pitches.flatMap((midi, phrase) =>
    Array.from({ length: 16 }, (_, step) => ({
      startMs: phrase * 4_000 + step * 250,
      endMs: phrase * 4_000 + step * 250 + 230,
      midiNote: midi,
      confidence,
    })));
  const chosenVocal = (sources: AutomaticRemixSource[]) => {
    const result = buildAutomaticRemixPlan(sources, {
      variant: "hybrid", vocalStemId: undefined, anchorSourceId: "a",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return null;
    const track = result.plan.tracks.find((entry) => entry.stemType === "vocals");
    return track ? String(track.stemAssetId) : null;
  };

  it("rejects a donor whose later section clashes even though its opening is perfect", () => {
    // Both donors sing the same C arpeggio over the first section, so judging
    // one matched pair -- the previous behaviour -- cannot separate them. The
    // second section is where they differ.
    const anchor = bedWithBass("a", null);
    const throughout = withFingerprints(source({ id: "throughout", vocalNotes: arpeggio as never }));
    const openingOnly = withFingerprints(source({
      id: "opening-only",
      vocalNotes: arpeggio.map((note) => (note.startMs >= 8_000
        ? { ...note, midiNote: note.midiNote + 1 }
        : note)) as never,
    }));
    // Offer the worse candidate first so a tie would fall back to it.
    const chosen = chosenVocal([anchor, openingOnly, throughout]);
    expect(chosen).toContain("throughout");
    expect(chosen).not.toContain("opening-only");
  });

  it("prefers an anchor whose own bass corroborates its chord analysis", () => {
    // Two equally structural beds. One's bass line supports the chords its
    // harmony analysis reports; the other sustains pitches foreign to them.
    // The caller names no anchor, so the choice is the planner's.
    // The contradicting bed is offered FIRST, so ordering alone would keep it.
    const contradicting = bedWithBass("first", bassLine([42, 45, 44, 42]));
    const supporting = bedWithBass("second", bassLine([36, 43, 40, 36]));
    const donor = withFingerprints(source({ id: "donor", vocalNotes: arpeggio as never }));
    const result = buildAutomaticRemixPlan([contradicting, supporting, donor], {
      variant: "hybrid", vocalStemId: undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.provenance.anchorSourceId).toBe("second");
    expect(result.plan.provenance.decisions.join(" ")).toContain("bass line corroborates");
  });

  it("does not move the anchor when the bass contradicts every candidate", () => {
    // Contradicting bass is not support. With no corroborating bed, the previous
    // ordering must stand unchanged.
    const first = bedWithBass("first", bassLine([42, 45, 44, 42]));
    const second = bedWithBass("second", bassLine([41, 44, 43, 41]));
    const donor = withFingerprints(source({ id: "donor", vocalNotes: arpeggio as never }));
    const result = buildAutomaticRemixPlan([first, second, donor], { variant: "hybrid", vocalStemId: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.provenance.anchorSourceId).toBe("first");
  });

  it("leaves the anchor choice untouched when no bass evidence exists at all", () => {
    const first = bedWithBass("first", null);
    const second = bedWithBass("second", null);
    const donor = withFingerprints(source({ id: "donor", vocalNotes: arpeggio as never }));
    const result = buildAutomaticRemixPlan([first, second, donor], { variant: "hybrid", vocalStemId: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.provenance.anchorSourceId).toBe("first");
  });

  it("is unmoved when neither donor can be judged, rather than preferring an unknown", () => {
    // No bed harmony on the anchor: the new evidence cannot decide anything,
    // so the previous ordering must stand unchanged.
    const anchor = withFingerprints(source({ id: "a" }));
    const first = withFingerprints(source({ id: "first", vocalNotes: arpeggio }));
    const second = withFingerprints(source({ id: "second", vocalNotes: arpeggio }));
    const result = buildAutomaticRemixPlan([anchor, first, second], { variant: "hybrid", anchorSourceId: "a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const vocalTrack = result.plan.tracks.find((track) => track.stemType === "vocals");
    expect(String(vocalTrack!.stemAssetId)).toContain("first");
  });
});
