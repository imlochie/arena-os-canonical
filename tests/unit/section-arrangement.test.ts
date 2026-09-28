import { describe, expect, it } from "vitest";
import {
  createSectionArrangementClips,
  sectionActionProvenanceReason,
  sectionActionScopeReason,
  type MusicalClipInput,
} from "@waveyard/types";

const grid = [0, 500, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000];
const template: MusicalClipInput = {
  stemAssetId: "stem-a",
  timelineStartMs: 0,
  durationMs: 1,
  sourceOffsetMs: 0,
  gain: 0.75,
  fadeInMs: 100,
  fadeOutMs: 150,
  tempoSyncEnabled: true,
  keySyncEnabled: true,
  beatSnapEnabled: true,
};

function create(
  action: "add" | "insert" | "loop" = "insert",
  startBeatIndex = 0,
  endBeatIndex = 4,
  timelineStartMs = 1_250,
  remaining = 256,
  repetitions = 1,
) {
  return createSectionArrangementClips(
    template,
    { startBeatIndex, endBeatIndex },
    grid,
    4_100,
    timelineStartMs,
    0.8,
    action,
    remaining,
    repetitions,
  );
}

describe("section-aware arrangement construction", () => {
  it("uses the existing beat slice conversion for first, final, and generic sections", () => {
    expect(create("add", 0, 4, 0)).toEqual({
      ok: true,
      clips: [expect.objectContaining({
        stemAssetId: "stem-a", timelineStartMs: 0, sourceOffsetMs: 0,
        durationMs: 2_500, gain: 0.75, fadeInMs: 100, fadeOutMs: 150,
        tempoSyncEnabled: true, keySyncEnabled: true, beatSnapEnabled: true,
      })],
    });
    expect(create("insert", 4, 8, 1_234)).toEqual({
      ok: true,
      clips: [expect.objectContaining({
        timelineStartMs: 1_234, sourceOffsetMs: 2_000, durationMs: 2_500,
      })],
    });
  });

  it("rejects invalid/stale-unavailable source ranges instead of falling back to milliseconds", () => {
    expect(create("add", 3, 3)).toEqual({ ok: false, reason: "beat_range_invalid" });
    expect(createSectionArrangementClips(template, { startBeatIndex: 0, endBeatIndex: 4 }, null, 4_100, 0, 1, "add", 1)).toEqual({ ok: false, reason: "beat_grid_unavailable" });
    expect(create("insert", 0, 4, -1)).toEqual({ ok: false, reason: "timeline_bounds_invalid" });
  });

  it("places loops deterministically with ordinary independent clip metadata", () => {
    const result = create("loop", 0, 4, 2_000, 8, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clips).toHaveLength(4);
    expect(result.clips.map((clip) => clip.timelineStartMs)).toEqual([2_000, 4_500, 7_000, 9_500]);
    expect(result.clips.every((clip) => clip.sourceOffsetMs === 0 && clip.durationMs === 2_500)).toBe(true);
    expect(result.clips.every((clip) => clip.tempoSyncEnabled && clip.keySyncEnabled && clip.beatSnapEnabled)).toBe(true);
    expect(new Set(result.clips).size).toBe(4);
  });

  it("rejects an entire loop before persistence when capacity or placement is invalid", () => {
    expect(create("loop", 0, 4, 0, 3, 3)).toEqual({ ok: false, reason: "clip_capacity_exceeded" });
    expect(create("loop", 0, 4, 86_399_000, 8, 1)).toEqual({ ok: false, reason: "timeline_bounds_invalid" });
    expect(create("loop", 0, 4, 0, 8, 0)).toEqual({ ok: false, reason: "loop_repetitions_invalid" });
  });

  it("rejects cross-project/source/stem/track reference chains before construction", () => {
    const current = {
      remixProjectId: "project-a", sectionProjectId: "project-a", sourceProjectId: "project-a",
      sourceAnalysisProjectId: "project-a", sectionAnalysisProjectId: "project-a", stemProjectId: "project-a",
      trackRemixSessionId: "remix-a", remixId: "remix-a",
      sectionSourceAssetId: "source-a", sourceAssetId: "source-a", analysisSourceAssetId: "source-a",
      sectionAnalysisSourceAssetId: "source-a", stemSourceAssetId: "source-a",
      trackStemAssetId: "stem-a", stemAssetId: "stem-a",
    };
    expect(sectionActionScopeReason(current)).toBeNull();
    expect(sectionActionScopeReason({ ...current, sectionProjectId: "project-b" })).toBe("section_action_unavailable");
    expect(sectionActionScopeReason({ ...current, stemProjectId: "project-b" })).toBe("section_action_unavailable");
    expect(sectionActionScopeReason({ ...current, stemSourceAssetId: "source-b" })).toBe("section_action_unavailable");
    expect(sectionActionScopeReason({ ...current, trackRemixSessionId: "remix-b" })).toBe("section_action_unavailable");
  });

  it("requires the current checksum, source analysis, and section engine provenance", () => {
    const current = {
      sourceChecksumSha256: "source-checksum",
      sectionChecksumSha256: "source-checksum",
      sourceAnalysisId: "analysis-a",
      sectionSourceAnalysisId: "analysis-a",
      sectionAnalysisStatus: "complete",
      sectionAnalysisEngine: "waveyard-numpy-structure",
      sectionAnalysisEngineVersion: "1.0.0",
      sectionEngine: "waveyard-numpy-structure",
      sectionEngineVersion: "1.0.0",
    };
    expect(sectionActionProvenanceReason(current)).toBeNull();
    expect(sectionActionProvenanceReason({ ...current, sectionChecksumSha256: "stale" })).toBe("section_action_unavailable");
    expect(sectionActionProvenanceReason({ ...current, sectionSourceAnalysisId: "old-analysis" })).toBe("section_action_unavailable");
    expect(sectionActionProvenanceReason({ ...current, sectionEngineVersion: "0.9.0" })).toBe("section_action_unavailable");
    expect(sectionActionProvenanceReason({ ...current, sectionAnalysisStatus: "failed" })).toBe("section_action_unavailable");
  });
});
