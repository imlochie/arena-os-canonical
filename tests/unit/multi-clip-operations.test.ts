import { describe, expect, it } from "vitest";
import {
  duplicateEditableClips,
  hasClipCapacity,
  moveEditableClips,
} from "@waveyard/types";
import {
  clipRangeSelection,
  toggleClipSelection,
  trackClipSelection,
} from "../../apps/web/src/lib/clip-selection";
import {
  redoArrangementHistory,
  recordArrangementHistory,
  undoArrangementHistory,
} from "../../apps/web/src/components/studio/useArrangementHistory";

const makeClip = (id: string, timelineStartMs: number, durationMs = 500) => ({
  id,
  stemAssetId: "stem-a",
  timelineStartMs,
  durationMs,
  sourceOffsetMs: 0,
  gain: 1,
  fadeInMs: 0,
  fadeOutMs: 0,
  tempoSyncEnabled: false,
  keySyncEnabled: false,
  beatSnapEnabled: false,
});

describe("UI-only multi-clip selection", () => {
  it("supports single add/remove, same-track ranges, and compatible track selection", () => {
    expect(toggleClipSelection([], "a")).toEqual(["a"]);
    expect(toggleClipSelection(["a", "b"], "a")).toEqual(["b"]);
    expect(clipRangeSelection(["a", "b", "c", "d"], 3, 1)).toEqual(["b", "c", "d"]);
    expect(trackClipSelection(["a", "b", "a"]).sort()).toEqual(["a", "b"]);
  });
});

describe("transactional group clip math", () => {
  it("moves all selected clips by one delta while retaining their relative spacing", () => {
    const moved = moveEditableClips([makeClip("a", 1_000), makeClip("b", 2_750)], 250);
    expect(moved?.map((clip) => clip.timelineStartMs)).toEqual([1_250, 3_000]);
    expect((moved?.[1].timelineStartMs ?? 0) - (moved?.[0].timelineStartMs ?? 0)).toBe(1_750);
    // A rejected member rejects the entire group instead of partially moving it.
    expect(moveEditableClips([makeClip("a", 0), makeClip("b", 2_000)], -1)).toBeNull();
  });

  it("duplicates a group after its furthest end and enforces the shared clip ceiling", () => {
    const duplicates = duplicateEditableClips([makeClip("a", 500, 400), makeClip("b", 1_500, 300)]);
    expect(duplicates?.map((clip) => clip.timelineStartMs)).toEqual([1_800, 2_800]);
    expect((duplicates?.[1].timelineStartMs ?? 0) - (duplicates?.[0].timelineStartMs ?? 0)).toBe(1_000);
    expect(hasClipCapacity(254, 2)).toBe(true);
    expect(hasClipCapacity(255, 2)).toBe(false);
  });

  it("records one group snapshot and restores it through ordinary undo and redo", () => {
    const before = { clipIds: ["a", "b"] };
    const after = { clipIds: ["a", "b", "c", "d"] };
    const history = recordArrangementHistory([], before);
    const undone = undoArrangementHistory(history, [], after);
    expect(undone.prior).toEqual(before);
    expect(undone.history).toEqual([]);
    expect(undone.future).toEqual([after]);
    const redone = redoArrangementHistory(undone.history, undone.future, before);
    expect(redone.next).toEqual(after);
    expect(redone.history).toEqual([before]);
  });
});
