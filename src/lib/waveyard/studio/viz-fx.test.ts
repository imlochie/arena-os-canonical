/**
 * FX + overlay math tests — letterbox geometry, anchors, timecodes, and
 * the Web MIDI maps. The draw helpers are exercised by the browser; the
 * numbers they agree on are verified here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { letterboxBars, midiControlToVolume, midiNoteToScene, overlayPositions, timecodeLabel } from "./viz-fx";
import { SCENE_IDS } from "./visualizer";

test("letterbox bars only appear when the canvas is too tall", () => {
  // 21:9 letterbox on a 16:9 canvas: bars shrink the view to 21:9.
  const bars = letterboxBars(1920, 1080, 21 / 9);
  assert.ok(bars.top > 0, `bars appear (${bars.top})`);
  const targetHeight = 1920 / (21 / 9);
  assert.ok(Math.abs(1080 - 2 * bars.top - targetHeight) < 1e-9, "the visible area is exactly 21:9");

  // Already wider than the target: no bars.
  assert.deepEqual(letterboxBars(2520, 1080, 21 / 9), { top: 0, bottom: 0 });
  // Degenerate inputs: no bars, no crash.
  assert.deepEqual(letterboxBars(0, 100, 21 / 9), { top: 0, bottom: 0 });
  assert.deepEqual(letterboxBars(100, 100, 0), { top: 0, bottom: 0 });
});

test("overlay anchors sit inside the canvas", () => {
  const positions = overlayPositions(800, 400);
  for (const anchor of [positions.title, positions.caption, positions.badge, positions.section]) {
    assert.ok(anchor.x >= 0 && anchor.x <= 800, `x in bounds (${anchor.x})`);
    assert.ok(anchor.y >= 0 && anchor.y <= 400, `y in bounds (${anchor.y})`);
  }
  assert.ok(positions.badge.x > positions.title.x, "the badge sits right of the title");
  assert.ok(positions.caption.y > positions.title.y, "the caption sits below the title");
  const tiny = overlayPositions(10, 10);
  assert.ok(tiny.title.x >= 0 && tiny.title.y >= 0, "tiny canvases clamp to the corner");
});

test("timecodes format as M:SS then H:MM:SS", () => {
  assert.equal(timecodeLabel(0), "0:00");
  assert.equal(timecodeLabel(65), "1:05");
  assert.equal(timecodeLabel(3599), "59:59");
  assert.equal(timecodeLabel(3600), "1:00:00");
  assert.equal(timecodeLabel(-5), "0:00", "negative time clamps");
});

test("MIDI notes select scenes chromatically; 61 is Auto", () => {
  assert.equal(midiNoteToScene(48), SCENE_IDS[0]);
  assert.equal(midiNoteToScene(48 + SCENE_IDS.length - 1), SCENE_IDS[SCENE_IDS.length - 1]);
  assert.equal(midiNoteToScene(61), "auto");
  assert.equal(midiNoteToScene(47), null, "below the map");
  assert.equal(midiNoteToScene(62), null, "above the map");
});

test("MIDI controls map CC70+ to stem volumes", () => {
  assert.deepEqual(midiControlToVolume(70, 127, 4), { stemIndex: 0, volume: 1.25 });
  assert.deepEqual(midiControlToVolume(73, 0, 4), { stemIndex: 3, volume: 0 });
  const half = midiControlToVolume(73, 51, 4);
  assert.ok(half !== null && Math.abs(half.volume - 0.5) < 0.01, "51/127 ≈ half");
  assert.equal(midiControlToVolume(74, 100, 4), null, "beyond the stem count");
  assert.equal(midiControlToVolume(69, 100, 4), null, "below the control map");
  assert.deepEqual(midiControlToVolume(70, 999, 4), { stemIndex: 0, volume: 1.25 }, "values clamp");
});
