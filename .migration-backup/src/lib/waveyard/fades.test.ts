/**
 * Fade curve tests — endpoint behaviour, monotonicity, equal-power
 * complementarity, and whole-buffer application.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CLIP_FADE_SHAPES,
  FADE_SHAPES,
  applyFades,
  clipFadeShapeOrLinear,
  fadeCurveSamples,
  fadeGainAt,
  isClipFadeShape,
  isFadeShape,
} from "./fades";
import type { StereoBuffer } from "./mixer/dsp";

const FS = 48000;

test("every shape starts silent and ends at unity", () => {
  for (const shape of FADE_SHAPES) {
    assert.ok(Math.abs(fadeGainAt(shape, 0)) < 1e-9, `${shape} at 0`);
    assert.ok(Math.abs(fadeGainAt(shape, 1) - 1) < 1e-9, `${shape} at 1`);
  }
});

test("out-of-range and NaN positions clamp to the endpoints", () => {
  for (const shape of FADE_SHAPES) {
    assert.equal(fadeGainAt(shape, -0.5), fadeGainAt(shape, 0));
    assert.equal(fadeGainAt(shape, 1.5), fadeGainAt(shape, 1));
    assert.equal(fadeGainAt(shape, Number.NaN), fadeGainAt(shape, 0));
  }
});

test("every shape is monotonically non-decreasing", () => {
  for (const shape of FADE_SHAPES) {
    let prev = -Infinity;
    for (let i = 0; i <= 100; i += 1) {
      const g = fadeGainAt(shape, i / 100);
      assert.ok(g >= prev - 1e-12, `${shape} must not decrease at t=${i / 100}`);
      prev = g;
    }
  }
});

test("equal-power curves are complementary for crossfades", () => {
  for (let i = 0; i <= 20; i += 1) {
    const t = i / 20;
    const a = fadeGainAt("equal-power", t);
    const b = fadeGainAt("equal-power", 1 - t);
    assert.ok(Math.abs(a * a + b * b - 1) < 1e-9, `sin²+cos² must be 1 at t=${t}`);
  }
});

test("s-curve passes through its midpoint; exp and log bracket it", () => {
  assert.ok(Math.abs(fadeGainAt("s-curve", 0.5) - 0.5) < 1e-9);
  assert.ok(fadeGainAt("exponential", 0.5) < 0.5, "exponential is slow-start");
  assert.ok(fadeGainAt("logarithmic", 0.5) > 0.5, "logarithmic is fast-start");
});

test("isFadeShape guards the union", () => {
  assert.equal(isFadeShape("linear"), true);
  assert.equal(isFadeShape("equal-power"), true);
  assert.equal(isFadeShape("sine"), false);
  assert.equal(isFadeShape(3), false);
});

test("applyFades leaves the middle untouched and defaults to linear", () => {
  const frames = 1000;
  const buffer = new Float32Array(frames * 2).fill(0.5);
  const fadeIn = 100;
  const fadeOut = 100;
  applyFades(buffer, fadeIn, fadeOut);
  // First frame is silent; frame fadeIn (first unfaded) is unity.
  assert.ok(Math.abs(buffer[0]) < 1e-9);
  assert.ok(Math.abs(buffer[fadeIn * 2] - 0.5) < 1e-12);
  // Middle untouched.
  assert.equal(buffer[500 * 2], 0.5);
  // Last frame is silent.
  assert.ok(Math.abs(buffer[(frames - 1) * 2]) < 0.5 * 1e-9 + 1e-9);
});

test("applyFades linear fade matches a manual ramp", () => {
  const frames = 100;
  const buffer = new Float32Array(frames * 2).fill(1);
  applyFades(buffer, 50, 0, "linear");
  // Frame 25: gain 25/50 = 0.5.
  assert.ok(Math.abs(buffer[25 * 2] - 0.5) < 1e-12);
});

test("applyFades fade-out mirrors the fade-in curve", () => {
  const frames = 200;
  const fadeIn = 50;
  const buffer = new Float32Array(frames * 2).fill(1);
  applyFades(buffer, fadeIn, 0, "s-curve");
  const out = new Float32Array(frames * 2).fill(1);
  applyFades(out, 0, fadeIn, "s-curve");
  // Fade-out gain at frame k from the end equals fade-in gain at frame k from the start.
  for (let i = 0; i < fadeIn; i += 1) {
    const fromStart = buffer[i * 2];
    const fromEnd = out[(frames - 1 - i) * 2];
    assert.ok(Math.abs(fromStart - fromEnd) < 1e-12, `frame pair ${i} must mirror`);
  }
});

test("applyFades clamps oversized fades and accepts zero-length fades", () => {
  const buffer = new Float32Array(100 * 2).fill(0.5);
  applyFades(buffer, 0, 0);
  assert.equal(buffer[42 * 2], 0.5);
  applyFades(buffer, 10000, 0, "linear");
  // Frame 0 still starts at gain 0.
  assert.ok(Math.abs(buffer[0]) < 1e-9);
});

test("clip fade shapes are the renderable subset of all fade shapes", () => {
  for (const shape of CLIP_FADE_SHAPES) {
    assert.ok((FADE_SHAPES as readonly string[]).includes(shape), `${shape} must be a real shape`);
    assert.ok(isClipFadeShape(shape), `${shape} must pass the guard`);
  }
  // exponential/logarithmic are TS-only (no exact afade equivalent).
  assert.equal(isClipFadeShape("exponential"), false);
  assert.equal(isClipFadeShape("logarithmic"), false);
  assert.equal(isClipFadeShape("sine"), false);
  assert.equal(isClipFadeShape(3), false);
  assert.equal(clipFadeShapeOrLinear(undefined), "linear");
  assert.equal(clipFadeShapeOrLinear("s-curve"), "s-curve");
  assert.equal(clipFadeShapeOrLinear("nope"), "linear", "invalid falls back to linear for optional reads");
});

test("fadeCurveSamples samples inclusive endpoints in either direction", () => {
  const up = fadeCurveSamples("equal-power", 0, 1, 5);
  assert.equal(up.length, 5);
  assert.ok(Math.abs(up[0] - fadeGainAt("equal-power", 0)) < 1e-12, "first point = fromT");
  assert.ok(Math.abs(up[4] - 1) < 1e-12, "last point = toT (unity)");
  // Quarter sine midpoint: sin(π/4) ≈ 0.7071 (Float32Array storage precision).
  assert.ok(Math.abs(up[2] - Math.SQRT1_2) < 1e-6, `midpoint ${up[2]}`);

  const down = fadeCurveSamples("s-curve", 1, 0, 3);
  assert.ok(Math.abs(down[0] - 1) < 1e-12, "descending starts at unity");
  assert.ok(Math.abs(down[2] - 0) < 1e-12, "descending ends silent");

  // Partial range (resume into a fade): from 0.5 to 1.
  const partial = fadeCurveSamples("linear", 0.5, 1, 3);
  assert.ok(Math.abs(partial[0] - 0.5) < 1e-12);
  assert.ok(Math.abs(partial[1] - 0.75) < 1e-12);

  // Hostile input: count clamps to >= 2, t clamps to [0,1].
  const hostile = fadeCurveSamples("linear", -5, 99, 1);
  assert.equal(hostile.length, 2);
  assert.equal(hostile[0], 0);
  assert.equal(hostile[1], 1);
});
