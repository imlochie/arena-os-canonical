import { describe, expect, it } from "vitest";
import {
  MAX_TIMELINE_MS,
  clipWindowIsValid,
  moveClipTimeline,
  slipClipSource,
  splitEditableClip,
  trimClipLeftBy,
  trimClipRightBy,
} from "@waveyard/types";

const clip = {
  id: "clip-a",
  stemAssetId: "stem-a",
  timelineStartMs: 1_000,
  durationMs: 1_000,
  sourceOffsetMs: 2_000,
  gain: 0.8,
  fadeInMs: 100,
  fadeOutMs: 200,
  tempoSyncEnabled: true,
  keySyncEnabled: true,
  beatSnapEnabled: true,
};

describe("ordinary RemixClip advanced edits", () => {
  it("moves only the timeline anchor and enforces the shared timeline bound", () => {
    expect(moveClipTimeline(clip, 4_321)).toMatchObject({
      timelineStartMs: 4_321, sourceOffsetMs: 2_000, durationMs: 1_000,
      gain: 0.8, fadeInMs: 100, fadeOutMs: 200,
    });
    expect(moveClipTimeline(clip, -1)).toBeNull();
    expect(moveClipTimeline(clip, MAX_TIMELINE_MS)).toBeNull();
  });

  it("trims source and timeline coordinates through the existing tempo ratio", () => {
    const left = trimClipLeftBy(clip, 100, 10_000, 1.5);
    expect(left).toMatchObject({ timelineStartMs: 1_100, durationMs: 900, sourceOffsetMs: 2_150 });
    expect(left && clipWindowIsValid(left, 10_000, 1.5)).toBe(true);
    const right = trimClipRightBy(clip, -100, 10_000, 1.5);
    expect(right).toMatchObject({ timelineStartMs: 1_000, durationMs: 900, sourceOffsetMs: 2_000 });
    expect(trimClipLeftBy(clip, 2_000, 3_500, 1.5)).toBeNull();
  });

  it("slips only a bounded immutable-source window", () => {
    expect(slipClipSource(clip, 3_000, 10_000, 1.5)).toMatchObject({
      timelineStartMs: 1_000, sourceOffsetMs: 3_000, durationMs: 1_000,
    });
    expect(slipClipSource(clip, -1, 10_000, 1.5)).toBeNull();
    expect(slipClipSource(clip, 8_501, 10_000, 1.5)).toBeNull();
  });

  it("splits transactionally into two contiguous ordinary clips without changing transforms", () => {
    const split = splitEditableClip(clip, 1_400, 10_000, 1.5);
    expect(split).toEqual(expect.objectContaining({
      left: expect.objectContaining({ id: undefined, timelineStartMs: 1_000, durationMs: 400, sourceOffsetMs: 2_000, gain: 0.8, keySyncEnabled: true }),
      right: expect.objectContaining({ id: undefined, timelineStartMs: 1_400, durationMs: 600, sourceOffsetMs: 2_600, gain: 0.8, keySyncEnabled: true }),
    }));
    expect(split && clipWindowIsValid(split.left, 10_000, 1.5)).toBe(true);
    expect(split && clipWindowIsValid(split.right, 10_000, 1.5)).toBe(true);
    expect(splitEditableClip(clip, 1_000, 10_000, 1.5)).toBeNull();
    expect(splitEditableClip(clip, 2_000, 10_000, 1.5)).toBeNull();
  });
});
