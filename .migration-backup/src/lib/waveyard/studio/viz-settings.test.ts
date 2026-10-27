/**
 * VizSettings tests — the customization layer must be total: any hostile
 * localStorage value parses to clamped settings or null, and the defaults
 * round-trip.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_VIZ_SETTINGS, parseVizSettings, vizSettingsKey } from "./viz-settings";

test("defaults are sane and parse as themselves", () => {
  assert.equal(DEFAULT_VIZ_SETTINGS.energy, 1);
  assert.equal(DEFAULT_VIZ_SETTINGS.palette.mode, "stems");
  assert.equal(DEFAULT_VIZ_SETTINGS.postFx.letterbox, false);
  const parsed = parseVizSettings(JSON.parse(JSON.stringify(DEFAULT_VIZ_SETTINGS)) as unknown);
  assert.deepEqual(parsed, DEFAULT_VIZ_SETTINGS, "defaults round-trip identically");
});

test("garbage is rejected, partial objects are completed", () => {
  assert.equal(parseVizSettings(null), null);
  assert.equal(parseVizSettings("nope"), null);
  assert.equal(parseVizSettings([1, 2, 3]), null);
  assert.equal(parseVizSettings(42), null);

  const partial = parseVizSettings({ energy: 99, timeScale: 0.01, dwellMs: 1 });
  assert.ok(partial !== null);
  assert.equal(partial.energy, 3, "energy clamps at 3");
  assert.equal(partial.timeScale, 0.25, "time scale clamps at 0.25");
  assert.equal(partial.dwellMs, 2000, "dwell clamps at 2 s");
  assert.equal(partial.trails, DEFAULT_VIZ_SETTINGS.trails, "missing fields default");
  assert.equal(partial.overlays.title, false, "overlay flags default off");
});

test("unknown fields are stripped; palette colors are validated", () => {
  const parsed = parseVizSettings({ energy: 2, malicious: { deep: true }, palette: { mode: "custom", colors: ["#ff0000", "red", "#00ff00", null] } });
  assert.ok(parsed !== null);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "dwellMs",
    "energy",
    "overlays",
    "palette",
    "particleCap",
    "postFx",
    "sceneWhitelist",
    "timeScale",
    "trails",
  ], "no unknown fields survive");
  assert.deepEqual(parsed.palette.colors, ["#ff0000", "#00ff00"], "only valid hex colors survive");
  const evil = parseVizSettings({ postFx: { grain: "lots" }, overlays: { caption: 123 } });
  assert.ok(evil !== null);
  assert.equal(evil.postFx.grain, 0, "non-numeric strength → 0");
  assert.equal(evil.overlays.caption, "", "non-string caption → empty");
});

test("the storage key is project-scoped", () => {
  assert.equal(vizSettingsKey("abc"), "waveyard:viz:abc");
  assert.notEqual(vizSettingsKey("abc"), vizSettingsKey("def"));
});
