import { describe, it } from "node:test";
import { expect } from "../../test-shim";
import { AUTOMATIC_REMIX_ENGINE, buildAutomaticRemixPlan, type AutomaticRemixSource } from "../index";

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
