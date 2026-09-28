import { describe, expect, it } from "vitest";
import { proposeMultiSourcePlacement, type MultiSourcePlacementAnchor, type MultiSourcePlacementSource } from "@waveyard/types";

const source: MultiSourcePlacementSource = {
  sourceAssetId: "source-c", stemAssetId: "sample-c", sourceChecksumSha256: "c-checksum", startMs: 0, endMs: 16_000,
  analysis: { status: "complete", sourceChecksumSha256: "c-checksum", bpm: 100, musicalKey: "A major", beatGridMs: Array.from({ length: 33 }, (_, index) => index * 600) },
};
const anchor: MultiSourcePlacementAnchor = { clipId: "clip-a", timelineStartMs: 16_000, durationMs: 16_000, beatAlignedEnd: true, barAlignedEnd: true };

describe("Multi-source transitions and overlays", () => {
  it("keeps an intentional overlay as an ordinary explicit-transform placement", () => {
    const proposal = proposeMultiSourcePlacement({ source, anchor, mode: "overlay", remixBpm: 120, targetKey: "C major" });
    expect(proposal).toMatchObject({ state: "ready", timelineStartMs: 16_000, durationMs: 13_333, tempoRatio: 1.2, tempoSyncEnabled: true, keyShiftSemitones: 3, keySyncEnabled: true, beatSnapEnabled: true, fadeInMs: 0 });
  });

  it("supports repeated user-controlled 2-, 3-, and 4-source stacking without a source-count model", () => {
    const placements = ["source-b", "source-c", "source-d", "source-e"].map((sourceAssetId) => proposeMultiSourcePlacement({ source: { ...source, sourceAssetId, stemAssetId: `${sourceAssetId}-stem` }, anchor, mode: "overlay", remixBpm: 120, targetKey: "C major" }));
    expect(placements.every(Boolean)).toBe(true);
    expect(new Set(placements.map((placement) => placement?.source.sourceAssetId)).size).toBe(4);
  });

  it("describes hard, beat, bar, and crossfade handoffs using existing clip/fade mechanics", () => {
    expect(proposeMultiSourcePlacement({ source, anchor, mode: "hard-cut", remixBpm: 120, targetKey: "C major" })).toMatchObject({ timelineStartMs: 32_000, fadeInMs: 0, fadeOutMs: 0 });
    expect(proposeMultiSourcePlacement({ source, anchor, mode: "beat-handoff", remixBpm: 120, targetKey: "C major" })?.state).toBe("ready");
    expect(proposeMultiSourcePlacement({ source, anchor, mode: "bar-handoff", remixBpm: 120, targetKey: "C major" })?.state).toBe("ready");
    expect(proposeMultiSourcePlacement({ source, anchor, mode: "crossfade", remixBpm: 120, targetKey: "C major" })).toMatchObject({ timelineStartMs: 31_500, fadeInMs: 500, fadeOutMs: 500 });
  });

  it("does not silently transform unknown or stale analysis", () => {
    expect(proposeMultiSourcePlacement({ source: { ...source, analysis: null }, anchor, mode: "overlay", remixBpm: 120, targetKey: "C major" })).toBeNull();
    expect(proposeMultiSourcePlacement({ source: { ...source, analysis: { ...source.analysis!, sourceChecksumSha256: "stale" } }, anchor, mode: "overlay", remixBpm: 120, targetKey: "C major" })).toBeNull();
    expect(proposeMultiSourcePlacement({ source, anchor: { ...anchor, barAlignedEnd: false }, mode: "bar-handoff", remixBpm: 120, targetKey: null })).toMatchObject({ state: "experimental", keySyncEnabled: false });
  });

  it("is deterministic for the same user-selected source and anchor", () => {
    expect(proposeMultiSourcePlacement({ source, anchor, mode: "crossfade", remixBpm: 120, targetKey: "C major" })).toEqual(proposeMultiSourcePlacement({ source, anchor, mode: "crossfade", remixBpm: 120, targetKey: "C major" }));
  });
});
