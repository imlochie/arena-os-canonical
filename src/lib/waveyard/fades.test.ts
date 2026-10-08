/**
 * Fade curve tests — endpoint behaviour, monotonicity, equal-power
 * complementarity, and whole-buffer application.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { FADE_SHAPES, applyFades, fadeGainAt, isFadeShape } from "./fades";
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
