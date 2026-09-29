import { describe, expect, it } from "vitest";
import { AUTOMATIC_REMIX_ENGINE, buildAutomaticRemixPlan, type AutomaticRemixSource } from "@waveyard/types";

function source(overrides: Partial<AutomaticRemixSource> & Pick<AutomaticRemixSource, "id">): AutomaticRemixSource {
  const id = overrides.id;
  return {
    originalFilename: `${id}.wav`,
    checksumSha256: `${id}-checksum`,
    durationMs: 16_000,
    analysis: {
      id: `${id}-analysis`, status: "complete", sourceChecksumSha256: `${id}-checksum`, bpm: 120, musicalKey: "C major",
      beatGridMs: Array.from({ length: 33 }, (_, index) => index * 500),
    },
    sections: [
      { id: `${id}-a`, sectionIndex: 0, startMs: 0, endMs: 8_000 },
      { id: `${id}-b`, sectionIndex: 1, startMs: 8_000, endMs: 16_000 },
    ],
    stems: [
      { id: `${id}-drums`, sourceAssetId: id, stemType: "drums", durationMs: 16_000 },
      { id: `${id}-bass`, sourceAssetId: id, stemType: "bass", durationMs: 16_000 },
      { id: `${id}-other`, sourceAssetId: id, stemType: "other", durationMs: 16_000 },
      { id: `${id}-vocals`, sourceAssetId: id, stemType: "vocals", durationMs: 16_000 },
    ],
    ...overrides,
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
    const result = buildAutomaticRemixPlan([source({ id: "a" }), source({ id: "b", analysis: { id: "b-analysis", status: "complete", sourceChecksumSha256: "b-checksum", bpm: 124, musicalKey: "D major", beatGridMs: Array.from({ length: 33 }, (_, index) => index * 484) } })], { variant: "hybrid" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const vocals = result.plan.tracks.find((track) => track.stemType === "vocals");
    expect(vocals?.stemAssetId).toBe("b-vocals");
    expect(vocals?.clips.every((clip) => clip.tempoSyncEnabled && clip.keySyncEnabled && clip.beatSnapEnabled)).toBe(true);
    expect(result.plan.provenance.decisions).toContain("replaced only verified, structurally compatible featured stems");
  });

  it("does not force an incompatible second source into a hybrid", () => {
    const incompatible = source({ id: "b", analysis: { id: "b-analysis", status: "complete", sourceChecksumSha256: "b-checksum", bpm: 168, musicalKey: "F# minor", beatGridMs: Array.from({ length: 33 }, (_, index) => index * 357) } });
    const result = buildAutomaticRemixPlan([source({ id: "a" }), incompatible], { variant: "hybrid" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tracks.find((track) => track.stemType === "vocals")?.stemAssetId).toBe("a-vocals");
    expect(result.plan.notices).toContain("No compatible outside source was available, so the hybrid preserves the anchor arrangement.");
  });

  it("falls back to preserved anchor material when evidence is insufficient", () => {
    const unknown = source({ id: "unproven", analysis: { id: "unproven-analysis", status: "processing", sourceChecksumSha256: "unproven-checksum", bpm: null, musicalKey: null, beatGridMs: null }, sections: [] });
    const result = buildAutomaticRemixPlan([unknown], { variant: "hybrid", instrumental: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tracks.some((track) => track.stemType === "vocals")).toBe(false);
    expect(result.plan.tracks.every((track) => track.clips.length === 1 && !track.clips[0].tempoSyncEnabled)).toBe(true);
    expect(result.plan.notices[0]).toContain("Structural analysis is incomplete");
  });

  it("rejects an empty source set rather than inventing material", () => {
    expect(buildAutomaticRemixPlan([])).toEqual({ ok: false, reason: "no_usable_source" });
  });
});
