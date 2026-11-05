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

  it("uses a compatible alternate vocal with explicit transform intent", () => {
    const anchor = withRoles(source({ id: "a" }));
    const donor = withRoles(source({
      id: "b",
      analysis: { id: "b-analysis", status: "complete", sourceChecksumSha256: "b-checksum", bpm: 124, musicalKey: "D major", beatGridMs: Array.from({ length: 33 }, (_, index) => index * 484) },
    }));
    const result = buildAutomaticRemixPlan([anchor, donor], { variant: "hybrid" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const vocals = result.plan.tracks.find((track) => track.stemType === "vocals");
    expect(vocals?.stemAssetId).toBe("b-vocals");
    expect(vocals?.clips.every((clip) => clip.tempoSyncEnabled && clip.keySyncEnabled && clip.beatSnapEnabled)).toBe(true);
    expect(result.plan.provenance.decisions).toContain("replaced only verified, structurally compatible featured stems");
  });

  it("refuses same-index generic sections as cross-song phrase evidence", () => {
    const result = buildAutomaticRemixPlan([source({ id: "a" }), source({ id: "b" })], { variant: "hybrid" });
    expect(result).toEqual({ ok: false, reason: "no_compatible_hybrid_source" });
  });

  it("rejects reversed role order instead of mapping by ordinal position", () => {
    const anchor = withRoles(source({ id: "a" }));
    const donor = withRoles(source({ id: "b" }), ["chorus", "verse"]);
    const result = buildAutomaticRemixPlan([anchor, donor], { variant: "hybrid" });
    expect(result).toEqual({ ok: false, reason: "no_compatible_hybrid_source" });
  });

  it("does not enable a hybrid from low-confidence tempo, key, or beat analysis", () => {
    const anchor = withRoles(source({ id: "a" }));
    const donor = withRoles(source({
      id: "b",
      analysis: {
        id: "b-analysis", status: "complete", sourceChecksumSha256: "b-checksum", bpm: 120, bpmConfidence: 0.49,
        musicalKey: "C major", keyConfidence: 0.49, beatConfidence: 0.49, beatGridMs: Array.from({ length: 33 }, (_, index) => index * 500),
      },
    }));
    const result = buildAutomaticRemixPlan([anchor, donor], { variant: "hybrid" });
    expect(result).toEqual({ ok: false, reason: "no_compatible_hybrid_source" });
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

  it("does not force an incompatible second source into a hybrid", () => {
    const incompatible = source({ id: "b", analysis: { id: "b-analysis", status: "complete", sourceChecksumSha256: "b-checksum", bpm: 168, musicalKey: "F# minor", beatGridMs: Array.from({ length: 33 }, (_, index) => index * 357) } });
    const result = buildAutomaticRemixPlan([source({ id: "a" }), incompatible], { variant: "hybrid" });
    expect(result).toEqual({ ok: false, reason: "no_compatible_hybrid_source" });
  });

  it("refuses a hybrid when anchor structural evidence is incomplete", () => {
    const unknown = source({ id: "unproven", analysis: { id: "unproven-analysis", status: "processing", sourceChecksumSha256: "unproven-checksum", bpm: null, musicalKey: null, beatGridMs: null }, sections: [] });
    const result = buildAutomaticRemixPlan([unknown], { variant: "hybrid", instrumental: true });
    expect(result).toEqual({ ok: false, reason: "hybrid_evidence_unavailable" });
  });

  it("rejects an empty source set rather than inventing material", () => {
    expect(buildAutomaticRemixPlan([])).toEqual({ ok: false, reason: "no_usable_source" });
  });
});
