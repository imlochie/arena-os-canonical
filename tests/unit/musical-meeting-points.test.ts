import { describe, expect, it } from "vitest";
import { discoverMusicalMeetingPoints, type MeetingPointSourceRegion, type MeetingPointTargetRegion } from "@waveyard/types";

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
});
