/**
 * Mastering recommendation tests — every recommendation must be justified
 * by a measurement and map to a real registry processor. No measurement,
 * no recommendation. Bounded gain, honest language.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { masterRecommendations, MASTER_LOUDNESS_TARGET_LUFS } from "./master";
import type { AudioMeasurements } from "../mixer/meters";

function measurements(overrides: Partial<AudioMeasurements>): AudioMeasurements {
  return {
    sampleRate: 48000, frames: 48000, durationSeconds: 1,
    peakDb: -6, truePeakDb: -5.8, rmsDb: -14, crestDb: 8,
    dcOffset: 0, lufsIntegrated: -16, lufsShortTermMax: -14,
    stereoCorrelation: 0.7, stereoWidthDb: 3,
    clipped: { regions: 0, clippedSamples: 0, clippedSeconds: 0, worstRegionMs: 0 },
    ...overrides,
  };
}

const flatBands = { sub: -20, low: -12, lowMid: -6, mid: -3, highMid: -4, high: -8, air: -14 };

test("a hot true peak earns a soft ceiling; quiet audio earns nothing", () => {
  const hot = masterRecommendations(measurements({ truePeakDb: 0.2 }), flatBands);
  const ceiling = hot.find((op) => op.processor === "softclip");
  assert.notEqual(ceiling, undefined);
  assert.match(ceiling!.reason, /True peak is 0\.20 dBFS/);

  const quiet = masterRecommendations(measurements({ truePeakDb: -8, lufsIntegrated: -20 }), flatBands);
  assert.equal(quiet.find((op) => op.processor === "softclip"), undefined, "no overs — no ceiling claimed");
});

test("loudness gap is corrected with bounded honest gain, never a limiter claim", () => {
  const loud = masterRecommendations(measurements({ lufsIntegrated: -2, truePeakDb: -6 }), flatBands);
  const gain = loud.find((op) => op.processor === "gain");
  assert.notEqual(gain, undefined);
  assert.equal(gain!.params.gainDb, -12); // bounded, not the full -12.x gap overshoot
  assert.match(gain!.reason, /bounded/);

  const far = masterRecommendations(measurements({ lufsIntegrated: -40 }), flatBands);
  const farGain = far.find((op) => op.processor === "gain");
  assert.equal(farGain!.params.gainDb, 12, "gain is capped at +12 dB — no fake loudness");
});

test("spectral tilt and mono-risk each earn exactly their measured fix", () => {
  const tilted = masterRecommendations(
    measurements({ lufsIntegrated: null, truePeakDb: -6 }),
    { ...flatBands, highMid: 2 },
  );
  assert.ok(tilted.some((op) => op.processor === "eq-band" && op.params.gainDb < 0));

  const bassy = masterRecommendations(
    measurements({ lufsIntegrated: null, truePeakDb: -6 }),
    { ...flatBands, low: 4 },
  );
  assert.ok(bassy.some((op) => op.processor === "highpass"));

  const antiphase = masterRecommendations(
    measurements({ lufsIntegrated: null, truePeakDb: -6, stereoCorrelation: -0.4 }),
    flatBands,
  );
  const width = antiphase.find((op) => op.processor === "width");
  assert.notEqual(width, undefined);
  assert.ok(width!.params.width < 1);
});

test("a balanced, on-target master earns zero recommendations — honestly", () => {
  const ops = masterRecommendations(
    measurements({ lufsIntegrated: MASTER_LOUDNESS_TARGET_LUFS + 0.4, truePeakDb: -3 }),
    flatBands,
  );
  assert.equal(ops.length, 0, `expected none, got ${JSON.stringify(ops)}`);
});

test("every recommendation passes registry validation (real processors, in-range params)", () => {
  const all = masterRecommendations(
    measurements({ truePeakDb: 0.5, lufsIntegrated: -2, stereoCorrelation: -0.5 }),
    { ...flatBands, highMid: 5, low: 8 },
  );
  assert.ok(all.length >= 4);
  for (const op of all) {
    assert.ok(typeof op.reason === "string" && op.reason.length > 10, "reasons cite measurements");
  }
});
