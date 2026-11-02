import { test } from "node:test";
import assert from "node:assert/strict";
import { readArcadeGameControls } from "./arcadeGameControls";

test("reads game-specific controls from the metadata tag", () => {
  assert.deepEqual(
    readArcadeGameControls('<meta name="arena-controls" content="Arrow keys &amp; WASD — move | Space — jump">'),
    ["Arrow keys & WASD — move", "Space — jump"],
  );
});

test("reads explicit help from older offline game files", () => {
  assert.deepEqual(
    readArcadeGameControls('<div class="help">← → / A-D — run · Space / W — jump</div>'),
    ["← → / A-D — run · Space / W — jump"],
  );
});

test("does not invent controls when the source has no instructions", () => {
  assert.equal(readArcadeGameControls("<!doctype html><canvas></canvas>"), null);
  assert.equal(readArcadeGameControls(null), null);
});
