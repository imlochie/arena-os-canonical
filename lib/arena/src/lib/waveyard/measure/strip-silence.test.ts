/**
 * Strip silence tests — segment detection, gap bridging, minimum lengths,
 * padding, and the rebuilt buffer's integrity.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_STRIP_SILENCE,
  detectAudibleSegments,
  stripSilence,
} from "./strip-silence";
import type { StereoBuffer } from "../mixer/dsp";

const FS = 48000;

/** Burst layout: [silence 500ms, tone 1000ms, silence 500ms, tone 1000ms, silence 500ms]. */
function burstBuffer(): StereoBuffer {
  const frames = Math.round(3.5 * FS);
  const buffer = new Float32Array(frames * 2);
  const tone = (startMs: number, endMs: number) => {
    for (let i = Math.round((startMs / 1000) * FS); i < Math.round((endMs / 1000) * FS); i += 1) {
      const v = Math.sin((2 * Math.PI * 440 * i) / FS) * 0.25;
      buffer[i * 2] = v;
      buffer[i * 2 + 1] = v;
    }
  };
  tone(500, 1500);
  tone(2000, 3000);
  return buffer;
}

test("two audible bursts are detected as two segments", () => {
  const buffer = burstBuffer();
  const plan = detectAudibleSegments(buffer, FS, { thresholdDb: -50 });
  assert.equal(plan.segments.length, 2);
  const [a, b] = plan.segments;
  const pad = 20 + 48; // padMs + one analysis frame of slack
  assert.ok(Math.abs(a.startMs - 500) <= pad, `first start ${a.startMs}`);
  assert.ok(Math.abs(a.endMs - 1500) <= pad, `first end ${a.endMs}`);
  assert.ok(Math.abs(b.startMs - 2000) <= pad, `second start ${b.startMs}`);
  assert.ok(Math.abs(b.endMs - 3000) <= pad, `second end ${b.endMs}`);
  assert.ok(a.endFrame <= b.startFrame, "segments must not overlap");
  assert.ok(plan.keptMs > 1800 && plan.keptMs < 2200, `keptMs ${plan.keptMs}`);
  assert.ok(plan.removedMs > 1200, `removedMs ${plan.removedMs}`);
});

test("gaps shorter than minGapMs are bridged", () => {
  const frames = Math.round(1.2 * FS);
  const buffer = new Float32Array(frames * 2);
  // Two 400 ms bursts separated by a 100 ms gap.
  for (const [startMs, endMs] of [[100, 500], [600, 1000]] as const) {
    for (let i = Math.round((startMs / 1000) * FS); i < Math.round((endMs / 1000) * FS); i += 1) {
      buffer[i * 2] = 0.25;
      buffer[i * 2 + 1] = 0.25;
    }
  }
  const bridged = detectAudibleSegments(buffer, FS, { minGapMs: 250 });
  const split = detectAudibleSegments(buffer, FS, { minGapMs: 50 });
  assert.equal(bridged.segments.length, 1, "100 ms gap must be bridged at 250 ms min");
  assert.equal(split.segments.length, 2, "100 ms gap must split at 50 ms min");
});

test("blips shorter than minSegmentMs are dropped", () => {
  const frames = Math.round(1 * FS);
  const buffer = new Float32Array(frames * 2);
  for (let i = Math.round(0.4 * FS); i < Math.round(0.44 * FS); i += 1) {
    buffer[i * 2] = 0.3;
    buffer[i * 2 + 1] = 0.3;
  }
  const plan = detectAudibleSegments(buffer, FS, { minSegmentMs: 250 });
  assert.equal(plan.segments.length, 0, "40 ms blip must be dropped");
  assert.equal(plan.keptFrames, 0);
});

test("an entirely silent buffer yields no segments", () => {
  const buffer = new Float32Array(FS);
  const plan = detectAudibleSegments(buffer, FS);
  assert.equal(plan.segments.length, 0);
  assert.equal(plan.removedMs, 500);
});

test("an entirely loud buffer yields one full segment", () => {
  const buffer = new Float32Array(FS).fill(0.2);
  const plan = detectAudibleSegments(buffer, FS);
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].startFrame, 0);
  assert.equal(plan.segments[0].endFrame, FS / 2);
});

test("padding is clamped to the buffer edges", () => {
  const frames = Math.round(1 * FS);
  const buffer = new Float32Array(frames * 2);
  // A 400 ms tone (survives minSegmentMs) with padding larger than the margins.
  for (let i = Math.round(0.3 * FS); i < Math.round(0.7 * FS); i += 1) {
    buffer[i * 2] = 0.3;
    buffer[i * 2 + 1] = 0.3;
  }
  const plan = detectAudibleSegments(buffer, FS, { padMs: 500 });
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].startFrame, 0, "pad must clamp to the start");
  assert.equal(plan.segments[0].endFrame, frames, "pad must clamp to the end");
});

test("stripSilence rebuilds a buffer equal to the kept regions", () => {
  const buffer = burstBuffer();
  const plan = detectAudibleSegments(buffer, FS, { thresholdDb: -50, padMs: 0 });
  const stripped = stripSilence(buffer, FS, { thresholdDb: -50, padMs: 0 });
  assert.equal(stripped.length, plan.keptFrames * 2);
  // Manual concatenation of the planned segments must match exactly.
  let cursor = 0;
  for (const seg of plan.segments) {
    for (let i = seg.startFrame * 2; i < seg.endFrame * 2; i += 1) {
      assert.equal(stripped[cursor], buffer[i], `sample ${cursor}`);
      cursor += 1;
    }
  }
  assert.equal(cursor, stripped.length);
});

test("stripSilence on silence returns an empty buffer", () => {
  const buffer = new Float32Array(FS);
  const stripped = stripSilence(buffer, FS);
  assert.equal(stripped.length, 0);
});

test("defaults are the documented Pro Tools-style starting point", () => {
  assert.equal(DEFAULT_STRIP_SILENCE.thresholdDb, -50);
  assert.equal(DEFAULT_STRIP_SILENCE.frameMs, 20);
  assert.equal(DEFAULT_STRIP_SILENCE.minSegmentMs, 250);
  assert.equal(DEFAULT_STRIP_SILENCE.minGapMs, 250);
  assert.equal(DEFAULT_STRIP_SILENCE.padMs, 20);
});
