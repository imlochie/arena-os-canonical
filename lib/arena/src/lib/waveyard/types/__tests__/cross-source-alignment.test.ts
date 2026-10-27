import { describe, it } from "node:test";
import { expect } from "../../test-shim";
import {
  alignSourceBeatToTimelineMs,
  clipTempoRatio,
  crossSourceAlignmentState,
  projectSourceBeatToRemixMs,
} from "../index";

describe("deterministic cross-source beat projection", () => {
  it("projects a source beat at the clip anchor with no tempo difference", () => {
    expect(clipTempoRatio(false, 96, 120)).toBe(1);
    expect(clipTempoRatio(true, 120, 120)).toBe(1);
    expect(projectSourceBeatToRemixMs({
      sourceBeatMs: 2_000, sourceOffsetMs: 2_000, timelineStartMs: 7_500,
      sourceBpm: 120, remixBpm: 120, tempoSyncEnabled: true,
    })).toBe(7_500);
  });

  it("uses the established target/source tempo ratio for speeding up and slowing down", () => {
    expect(projectSourceBeatToRemixMs({
      sourceBeatMs: 2_500, sourceOffsetMs: 1_000, timelineStartMs: 200,
      sourceBpm: 100, remixBpm: 150, tempoSyncEnabled: true,
    })).toBe(1_200);
    expect(projectSourceBeatToRemixMs({
      sourceBeatMs: 2_000, sourceOffsetMs: 1_000, timelineStartMs: 200,
      sourceBpm: 120, remixBpm: 80, tempoSyncEnabled: true,
    })).toBe(1_700);
    expect(projectSourceBeatToRemixMs({
      sourceBeatMs: 2_000, sourceOffsetMs: 1_000, timelineStartMs: 200,
      sourceBpm: 120, remixBpm: 80, tempoSyncEnabled: false,
    })).toBe(1_200);
  });

  it("rounds once at integer timeline boundaries and solves the inverse anchor deterministically", () => {
    const anchor = alignSourceBeatToTimelineMs({
      sourceBeatMs: 1_001, sourceOffsetMs: 333, timelineTargetMs: 9_000,
      sourceBpm: 96, remixBpm: 120, tempoSyncEnabled: true,
    });
    expect(anchor).toBe(8_466);
    expect(projectSourceBeatToRemixMs({
      sourceBeatMs: 1_001, sourceOffsetMs: 333, timelineStartMs: anchor!,
      sourceBpm: 96, remixBpm: 120, tempoSyncEnabled: true,
    })).toBe(9_000);
    expect(alignSourceBeatToTimelineMs({
      sourceBeatMs: 1_001, sourceOffsetMs: 1_000, timelineTargetMs: 9_000,
      sourceBpm: 60, remixBpm: 120, tempoSyncEnabled: true,
    })).toBe(8_999);
    expect(alignSourceBeatToTimelineMs({
      sourceBeatMs: 2_000, sourceOffsetMs: 0, timelineTargetMs: 100,
      sourceBpm: 120, remixBpm: 120, tempoSyncEnabled: false,
    })).toBeNull();
  });

  it("keeps alignment states distinct rather than treating every clip as matched", () => {
    const base = { analysisComplete: true, beatGridAvailable: true, tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false };
    expect(crossSourceAlignmentState(base)).toBe("source-only");
    expect(crossSourceAlignmentState({ ...base, beatSnapEnabled: true })).toBe("aligned");
    expect(crossSourceAlignmentState({ ...base, tempoSyncEnabled: true })).toBe("tempo-transformed");
    expect(crossSourceAlignmentState({ ...base, keySyncEnabled: true })).toBe("key-transformed");
    expect(crossSourceAlignmentState({ ...base, tempoSyncEnabled: true, keySyncEnabled: true })).toBe("fully-transformed");
    expect(crossSourceAlignmentState({ ...base, beatGridAvailable: false })).toBe("analysis-unavailable");
  });
});
