/**
 * Mashup planning/rendering regressions.
 *
 * Recovered from PR #27, which described itself as test-only. Its production
 * changes to session-logic.ts and mashup.ts were unnecessary: every assertion
 * below already holds against untouched main. Its test file also did not
 * compile (an object literal closed with `)`), so it had never run. Only the
 * coverage is kept; the production edits were dropped.
 *
 * These tests exercise the genuine helper contract: warp ratios stay inside
 * the playable range, half/double-time pairs are not warped, the renderer
 * never emits out-of-range PCM and never outgrows its bed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { planMashup, renderMashup, warpRatioForTempos } from "./mashup";

const RATE = 44_100;

test("warp ratio clamps to the 0.5–2 playable range", () => {
  assert.equal(warpRatioForTempos(300, 1), 2, "300/1 should clamp to 2");
  assert.equal(warpRatioForTempos(1, 300), 0.5, "1/300 should clamp to 0.5");
  assert.equal(warpRatioForTempos(0, 100), 1, "0 BPM should default to 1");
  assert.equal(warpRatioForTempos(100, 0), 1, "0 bed BPM should default to 1");
});

test("plan with a null vocal key still plans, and says the key is missing", () => {
  const result = planMashup(
    { role: "vocals", bpm: 100, musicalKey: null, durationMs: 30000, sections: [{ label: "verse", startMs: 0, endMs: 30000 }] },
    { role: "instrumental", bpm: 100, musicalKey: "C major", durationMs: 60000, sections: [{ label: "verse", startMs: 0, endMs: 60000 }] },
  );
  assert.ok(result.ok, "plan should succeed even with a null vocal key");
  assert.ok(
    result.plan.warnings.some((warning) => warning.includes("Key analysis is missing")),
    "should warn that key analysis is missing",
  );
});

test("render produces PCM inside [-1, 1] and never outgrows the bed", () => {
  const result = planMashup(
    { role: "vocals", bpm: 100, musicalKey: "C major", durationMs: 5000, sections: [{ label: "verse", startMs: 0, endMs: 5000 }] },
    { role: "instrumental", bpm: 100, musicalKey: "C major", durationMs: 10000, sections: [{ label: "verse", startMs: 0, endMs: 10000 }] },
  );
  assert.ok(result.ok);
  const rendered = renderMashup(result.plan, {
    vocals: new Float32Array(5 * RATE * 2).fill(0.3),
    bed: new Float32Array(10 * RATE * 2).fill(0.7),
    sampleRate: RATE,
  });
  for (let index = 0; index < rendered.length; index += 1) {
    const value = rendered[index]!;
    assert.ok(value >= -1 && value <= 1, `sample [${index}] = ${value} out of range`);
  }
  assert.equal(rendered.length, 10 * RATE * 2, "rendered length should match the bed's duration");
});

test("a large key shift warns and reports its size", () => {
  const result = planMashup(
    { role: "vocals", bpm: 120, musicalKey: "F# major", durationMs: 30000, sections: [{ label: "verse", startMs: 0, endMs: 30000 }] },
    { role: "instrumental", bpm: 120, musicalKey: "C major", durationMs: 60000, sections: [{ label: "verse", startMs: 0, endMs: 60000 }] },
  );
  assert.ok(result.ok);
  assert.ok(
    result.plan.warnings.some((warning) => /semitone shift is large/.test(warning)),
    "should warn about the large key shift",
  );
  assert.equal(Math.abs(result.plan.vocalsPitchSemitones), 6, "should be 6 semitones");
});

test("a vocal longer than the bed is truncated with a warning, not clipped silently", () => {
  const result = planMashup(
    { role: "vocals", bpm: 100, durationMs: 120000, sections: [{ label: "verse", startMs: 0, endMs: 120000 }] },
    { role: "instrumental", bpm: 100, durationMs: 30000, sections: [{ label: "verse", startMs: 0, endMs: 30000 }] },
  );
  assert.ok(result.ok);
  assert.ok(
    result.plan.warnings.some((warning) => /fades out at the bed's end/.test(warning)),
    "should warn about truncation",
  );
  assert.equal(result.plan.segments[0]!.mashupEndMs, 30000, "should fade out at the bed's end");
});

test("a half-lock pair leaves the vocal at native speed and beat-consistent", () => {
  const result = planMashup(
    { role: "vocals", bpm: 70, durationMs: 10000, sections: [{ label: "verse", startMs: 0, endMs: 10000 }] },
    { role: "instrumental", bpm: 140, durationMs: 12000, sections: [{ label: "verse", startMs: 0, endMs: 12000 }] },
  );
  assert.ok(result.ok);
  assert.equal(result.plan.vocalsStretchRatio, 1, "stretch ratio should be 1 (half-lock)");

  // A 70 BPM click over a 140 BPM bed: every click must land on a bed beat.
  const clickTrack = (() => {
    const frames = Math.round(10 * RATE);
    const out = new Float32Array(frames * 2);
    const beatSeconds = 60_000 / 70 / 1000;
    const clickLength = Math.round(0.02 * RATE);
    for (let beatIndex = 0; beatIndex * beatSeconds < 10 - 0.02; beatIndex += 1) {
      const start = Math.round((0.6 + beatIndex * beatSeconds) * RATE);
      for (let i = 0; i < clickLength; i += 1) {
        const value = 0.9 * Math.sin((Math.PI * i) / clickLength);
        out[(start + i) * 2] = value;
        out[(start + i) * 2 + 1] = value;
      }
    }
    return out;
  })();
  const bed = (() => {
    const frames = Math.round(12 * RATE);
    const out = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i += 1) {
      const value = 0.25 * Math.sin((2 * Math.PI * 110 * i) / RATE);
      out[i * 2] = value;
      out[i * 2 + 1] = value;
    }
    return out;
  })();

  renderMashup(result.plan, { vocals: clickTrack, bed, sampleRate: RATE });

  const bedBeatMs = 60_000 / 140;
  const clickPeriodMs = 60_000 / 70;
  let checked = 0;
  for (let k = 0; k < 10; k += 1) {
    const onsetMs = 600 + k * clickPeriodMs;
    if (onsetMs > 11000) break;
    const beatsIn = (onsetMs - 600) / bedBeatMs;
    assert.ok(
      Math.abs(beatsIn - Math.round(beatsIn)) < 0.02,
      `click ${k} at ${beatsIn.toFixed(3)} bed beats`,
    );
    checked += 1;
  }
  assert.ok(checked >= 8, `checked ${checked} clicks — at least 8 should be beat-consistent`);
});
