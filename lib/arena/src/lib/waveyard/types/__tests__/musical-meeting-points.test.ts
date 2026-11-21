import { describe, it } from "node:test";
import { expect } from "../../test-shim";
import {
  discoverMusicalMeetingPoints,
  projectVocalActivityToTimeline,
  vocalActivityOverlapRatio,
  type MeetingPointSourceRegion,
  type MeetingPointTargetRegion,
} from "../index";

const grid = Array.from({ length: 65 }, (_, index) => index * 500);
const source: MeetingPointSourceRegion = {
  sourceAssetId: "source-b", stemAssetId: "vocal-b", sourceChecksumSha256: "checksum-b", sectionId: "section-b",
  startBeatIndex: 0, endBeatIndex: 32, startMs: 0, endMs: 16_000, phraseBoundaryStart: true, phraseBoundaryEnd: true,
  analysis: { status: "complete", sourceChecksumSha256: "checksum-b", bpm: 120, musicalKey: "D major", beatGridMs: grid },
};
function target(overrides: Partial<MeetingPointTargetRegion> = {}): MeetingPointTargetRegion {
  return {
    targetClipId: "clip-a", sourceAssetId: "source-a", sourceChecksumSha256: "checksum-a", timelineStartMs: 16_000, durationMs: 16_000,
    barCount: 8, sectionId: "section-a", beatAligned: true,
    analysis: { status: "complete", sourceChecksumSha256: "checksum-a", bpm: 120, musicalKey: "C major", beatGridMs: grid },
    ...overrides,
  };
}

describe("Musical Meeting Points", () => {
  it("finds a deterministic ready eight-bar placement with explicit transforms", () => {
    const result = discoverMusicalMeetingPoints({ source, targets: [target()], remixBpm: 120, targetKey: "C major" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ state: "ready", barCount: 8, tempoSyncEnabled: false, keySyncEnabled: true, keyShiftSemitones: -2, beatSnapEnabled: true, phraseAligned: true, sectionAligned: true });
    expect(result[0].reasons).toContain("8 bars match the current window");
  });

  it("describes different bar lengths as experimental rather than ranking them", () => {
    const result = discoverMusicalMeetingPoints({ source, targets: [target({ barCount: 4, durationMs: 8_000 })], remixBpm: 120, targetKey: "C major" });
    expect(result[0]?.state).toBe("experimental");
    expect(result[0]?.reasons).toContain("bar count differs from the current window");
  });

  it("keeps manual section labels distinct from detected section evidence", () => {
    const result = discoverMusicalMeetingPoints({
      source: { ...source, sectionEvidence: "manual", startMs: 250, endMs: 16_250 },
      targets: [target()],
      remixBpm: 120,
      targetKey: "C major",
    });
    expect(result[0]).toMatchObject({ state: "ready", sectionAligned: false, beatSnapEnabled: false });
    expect(result[0]?.source.startMs).toBe(250);
    expect(result[0]?.reasons).toContain("source range and role were marked by the user; the fit remains an analysis recommendation");
  });

  it("uses existing tempo and key systems only when their analyses are available", () => {
    const result = discoverMusicalMeetingPoints({ source, targets: [target()], remixBpm: 96, targetKey: "F# minor" });
    expect(result[0]).toMatchObject({ tempoRatio: 0.8, tempoSyncEnabled: true, keyShiftSemitones: 4, keySyncEnabled: true });
    const unknownKey = discoverMusicalMeetingPoints({ source, targets: [target()], remixBpm: 96, targetKey: null });
    expect(unknownKey[0]).toMatchObject({ state: "possible", keySyncEnabled: false, keyShiftSemitones: null });
  });

  it("rejects missing, stale, or beat-grid-free source evidence", () => {
    expect(discoverMusicalMeetingPoints({ source: { ...source, analysis: null }, targets: [target()], remixBpm: 120, targetKey: "C major" })).toEqual([]);
    expect(discoverMusicalMeetingPoints({ source: { ...source, analysis: { ...source.analysis!, sourceChecksumSha256: "stale" } }, targets: [target()], remixBpm: 120, targetKey: "C major" })).toEqual([]);
    expect(discoverMusicalMeetingPoints({ source: { ...source, analysis: { ...source.analysis!, beatGridMs: [] } }, targets: [target()], remixBpm: 120, targetKey: "C major" })).toEqual([]);
    expect(discoverMusicalMeetingPoints({ source, targets: [target({ analysis: { ...target().analysis!, sourceChecksumSha256: "stale" } })], remixBpm: 120, targetKey: "C major" })[0]?.state).toBe("experimental");
  });

  it("keeps source identity in deterministic recommendations even when checksums match", () => {
    const sameChecksumTarget = target({ sourceAssetId: "different-source-with-same-content", sourceChecksumSha256: "checksum-b" });
    const first = discoverMusicalMeetingPoints({ source, targets: [sameChecksumTarget], remixBpm: 120, targetKey: "C major" });
    const second = discoverMusicalMeetingPoints({ source, targets: [sameChecksumTarget], remixBpm: 120, targetKey: "C major" });
    expect(first).toEqual(second);
    expect(first[0]?.source.sourceAssetId).toBe("source-b");
    expect(first[0]?.target.sourceAssetId).toBe("different-source-with-same-content");
  });

  it("maps persisted vocal activity through the source window and tempo transform", () => {
    const mapped = projectVocalActivityToTimeline({
      timelineStartMs: 10_000,
      durationMs: 4_000,
      sourceOffsetMs: 2_000,
      sourceDurationMs: 20_000,
      tempoRatio: 0.5,
      intervals: [
        { startMs: 1_000, endMs: 4_000, confidence: 0.8 },
        { startMs: 3_000, endMs: 6_000, confidence: 0.9 },
      ],
    });
    expect(mapped).toEqual([
      { startMs: 10_000, endMs: 14_000, confidence: 0.8 },
      { startMs: 12_000, endMs: 14_000, confidence: 0.9 },
    ]);
    expect(projectVocalActivityToTimeline({
      timelineStartMs: 10_000, durationMs: 4_000, sourceOffsetMs: 2_000,
      sourceDurationMs: 20_000, tempoRatio: 0.5, intervals: [],
    })).toEqual([]);
    expect(projectVocalActivityToTimeline({
      timelineStartMs: 10_000, durationMs: 4_000, sourceOffsetMs: 2_000,
      sourceDurationMs: 20_000, tempoRatio: 0.5, intervals: null,
    })).toBeNull();
  });

  it("measures the union of activity without double-counting and fails closed on malformed evidence", () => {
    expect(vocalActivityOverlapRatio(2_000, 8_000, [
      { startMs: 0, endMs: 4_000, confidence: 0.7 },
      { startMs: 2_000, endMs: 6_000, confidence: 0.8 },
      { startMs: 9_000, endMs: 12_000, confidence: 0.9 },
    ])).toBe(0.625);
    expect(vocalActivityOverlapRatio(2_000, 8_000, [])).toBe(0);
    expect(vocalActivityOverlapRatio(2_000, 8_000, null)).toBeNull();
    expect(vocalActivityOverlapRatio(2_000, 8_000, [
      { startMs: 5_000, endMs: 4_000, confidence: 0.9 },
    ])).toBeNull();
  });

  it("ranks vocal placement windows by persisted host activity but keeps unavailable evidence last", () => {
    const vocalSource = { ...source, stemType: "vocals" };
    const result = discoverMusicalMeetingPoints({
      source: vocalSource,
      targets: [
        target({ targetClipId: "overlap", vocalSlotEvidence: { status: "measured", overlapRatio: 0.75 } }),
        target({ targetClipId: "unknown", vocalSlotEvidence: { status: "unavailable", overlapRatio: null } }),
        target({ targetClipId: "clear", vocalSlotEvidence: { status: "measured", overlapRatio: 0.1 } }),
        target({ targetClipId: "empty", vocalSlotEvidence: { status: "no-existing-vocal-clip", overlapRatio: null } }),
      ],
      remixBpm: 120,
      targetKey: "C major",
    });
    expect(result.map((point) => point.target.targetClipId)).toEqual(["empty", "clear", "overlap", "unknown"]);
    expect(result[0]?.vocalSlotEvidence).toEqual({ status: "no-existing-vocal-clip", overlapRatio: null });
    expect(result[1]?.reasons).toContain("existing vocal-role activity overlaps 10% of this window");
    expect(result[3]?.reasons).toContain("existing vocal-role activity is unavailable; no vocal-slot preference was applied");
  });
});
