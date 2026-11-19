import assert from "node:assert/strict";
import test from "node:test";

import { selectSectionBeatGrid } from "./section-beat-grid";

const reliableDrumGrid = Array.from({ length: 65 }, (_, index) => index * 490);

test("keeps a trusted full-mix source grid instead of replacing it with drum-only timing", () => {
  const sourceBeatGrid = Array.from({ length: 65 }, (_, index) => index * 500);
  const selected = selectSectionBeatGrid({
    sourceBeatGrid,
    sourceBeatConfidence: 0.9,
    isolatedDrum: {
      bpm: 122.449,
      bpmConfidence: 0.9,
      beatGrid: reliableDrumGrid,
      beatConfidence: 0.9,
    },
    durationMs: 33_000,
  });

  assert.equal(selected?.source, "source");
  assert.deepEqual(selected?.beatGridMs, sourceBeatGrid);
});

test("uses a validated isolated-drum grid when the full-mix grid is low confidence", () => {
  const drumGrid = reliableDrumGrid;
  const selected = selectSectionBeatGrid({
    sourceBeatGrid: Array.from({ length: 65 }, (_, index) => index * 530),
    sourceBeatConfidence: 0.2,
    isolatedDrum: {
      bpm: 122.449,
      bpmConfidence: 0.9,
      beatGrid: drumGrid,
      beatConfidence: 0.8,
    },
    durationMs: 33_000,
  });

  assert.equal(selected?.source, "isolated-drums");
  assert.deepEqual(selected?.beatGridMs, drumGrid);
  assert.equal(selected?.beatConfidence, 0.8);
});

test("rejects stale or malformed drum timing and keeps a usable source fallback", () => {
  const sourceBeatGrid = Array.from({ length: 65 }, (_, index) => index * 500);
  const selected = selectSectionBeatGrid({
    sourceBeatGrid,
    sourceBeatConfidence: 0.1,
    isolatedDrum: {
      bpm: 122.449,
      bpmConfidence: 0.49,
      beatGrid: reliableDrumGrid,
      beatConfidence: 0.9,
    },
    durationMs: 33_000,
  });

  assert.equal(selected?.source, "source");
  assert.equal(selected?.beatConfidence, 0.1);
  assert.deepEqual(selected?.beatGridMs, sourceBeatGrid);
});

test("returns no grid when neither source nor isolated drums has usable timing", () => {
  assert.equal(selectSectionBeatGrid({
    sourceBeatGrid: null,
    sourceBeatConfidence: null,
    isolatedDrum: {
      bpm: 120,
      bpmConfidence: 0.9,
      beatGrid: [0, 750, 1500, 2250],
      beatConfidence: 0.9,
    },
    durationMs: 3_000,
  }), null);
});
