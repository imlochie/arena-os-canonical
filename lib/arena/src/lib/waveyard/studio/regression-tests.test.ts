// Regression tests for mashup validation
import assert from "node:assert/strict";
import test from "node:test";

import { planMashup, renderMashup, warpRatioForTempos } from "./mashup";
import { keyCompatibility } from "../library/session-logic";

const RATE = 44_100;

test("regression: warp ratio clamps to 0.5–2 range", () => {
  assert.equal(warpRatioForTempos(300, 1), 2, "300/1 should clamp to 2");
  assert.equal(warpRatioForTempos(1, 300), 0.5, "1/300 should clamp to 0.5");
  assert.equal(warpRatioForTempos(0, 100), 1, "0 BPM should default to 1");
  assert.equal(warpRatioForTempos(100, 0), 1, "0 bed BPM should default to 1");
});

test("regression: key compatibility C major / A minor are relative", () => {
  const rel = keyCompatibility("C major", "A minor");
  assert.ok(rel.compatible, "C major / A minor should be compatible");
  assert.equal(rel.relationship, "relative", "C major / A minor should be relative relationship");
});

test("regression: key compatibility A major / F# minor are relative", () => {
  const rel = keyCompatibility("A major", "F# minor");
  assert.ok(rel.compatible, "A major / F# minor should be compatible");
  assert.equal(rel.relationship, "relative", "A major / F# minor should be relative relationship");
});

test("regression: key compatibility C major / E minor are NOT relative", () => {
  const notRel = keyCompatibility("C major", "E minor");
  assert.ok(notRel.relationship !== "relative", "C major / E minor should NOT be relative");
  // C major to E minor is a shift of 4 semitones (or -8)
  assert.ok(Math.abs(notRel.shiftSemitones) === 4, "C major / E minor should have shift of ±4 semitones");
});

test("regression: plan with null vocal key handles gracefully", () => {
  const result = planMashup(
    { role: "vocals", bpm: 100, musicalKey: null, durationMs: 30000, sections: [{label: "verse", startMs: 0, endMs: 30000}] },
    { role: "instrumental", bpm: 100, musicalKey: "C major", durationMs: 60000, sections: [{label: "verse", startMs: 0, endMs: 60000}] }
  );
  assert.ok(result.ok, "plan should ok even with null vocal key");
  assert.ok(result.plan.warnings.some((w) => w.includes("Key analysis is missing")), "should warn about missing key");
});

test("regression: render produces valid PCM within [-1, 1]", () => {
  const result = planMashup(
    { role: "vocals", bpm: 100, musicalKey: "C major", durationMs: 5000, sections: [{label: "verse", startMs: 0, endMs: 5000}] },
    { role: "instrumental", bpm: 100, musicalKey: "C major", durationMs: 10000, sections: [{label: "verse", startMs: 0, endMs: 10000}] }
  );
  assert.ok(result.ok);
  const rendered = renderMashup(result.plan, {
    vocals: new Float32Array(5 * RATE * 2).fill(0.3),
    bed: new Float32Array(10 * RATE * 2).fill(0.7),
    sampleRate: RATE,
  });
  for (let i = 0; i < rendered.length; i++) {
    const v = rendered[i];
    assert.ok(v >= -1 && v <= 1, "sample [" + i + "] = " + v + " out of range");
  }
  assert.equal(rendered.length, 10 * RATE * 2, "rendered length should match bed duration");
});

test("regression: large key shift warns appropriately", () => {
  const result = planMashup(
    { role: "vocals", bpm: 120, musicalKey: "F# major", durationMs: 30000, sections: [{label: "verse", startMs: 0, endMs: 30000}] },
    { role: "instrumental", bpm: 120, musicalKey: "C major", durationMs: 60000, sections: [{label: "verse", startMs: 0, endMs: 60000}] }
  );
  assert.ok(result.ok);
  assert.ok(result.plan.warnings.some((w) => /semitone shift is large/.test(w)), "should warn about large key shift");
  assert.equal(Math.abs(result.plan.vocalsPitchSemitones), 6, "should be 6 semitones");
});

test("regression: vocal longer than bed truncates with warning", () => {
  const result = planMashup(
    { role: "vocals", bpm: 100, durationMs: 120000, sections: [{label: "verse", startMs: 0, endMs: 120000}] },
    { role: "instrumental", bpm: 100, durationMs: 30000, sections: [{label: "verse", startMs: 0, endMs: 30000}] }
  );
  assert.ok(result.ok);
  assert.ok(result.plan.warnings.some((w) => /fades out at the bed's end/.test(w)), "should warn about truncation");
  assert.equal(result.plan.segments[0].mashupEndMs, 30000, "should fade out at bed's end");
});

test("regression: half-lock leaves vocal beat-consistent", () => {
  const result = planMashup(
    { role: "vocals", bpm: 70, durationMs: 10000, sections: [{label: "verse", startMs: 0, endMs: 10000}] },
    { role: "instrumental", bpm: 140, durationMs: 12000, sections: [{label: "verse", startMs: 0, endMs: 12000}] }
  );
  assert.ok(result.ok);
  assert.equal(result.plan.vocalsStretchRatio, 1, "stretch ratio should be 1 (half-lock)");
  
  const rendered = renderMashup(result.plan, {
    vocals: (() => { const frames = Math.round(10 * RATE); const out = new Float32Array(frames * 2); const beat = (60_000 / 70) / 1000; const clickLength = Math.round(0.02 * RATE); for (let bi = 0; bi * beat < 10 - 0.02; bi++) { const start = Math.round((0.6 + bi * beat) * RATE); for (let i = 0; i < clickLength; i++) { const v = 0.9 * Math.sin((Math.PI * i) / clickLength); out[(start + i) * 2] = v; out[(start + i) * 2 + 1] = v; } } return out; })(),
    bed: (() => { const frames = Math.round(12 * RATE); const out = new Float32Array(frames * 2); for (let i = 0; i < frames; i++) { const v = 0.25 * Math.sin((2 * Math.PI * 110 * i) / RATE); out[i * 2] = v; out[i * 2 + 1] = v; } return out; })(),
    sampleRate: RATE,
  );
  
  const bedBeatMs = 60_000 / 140;
  const clickPeriodMs = 60_000 / 70;
  let checked = 0;
  for (let k = 0; k < 10; k++) {
    const onsetMs = 600 + k * clickPeriodMs;
    if (onsetMs > 11000) break;
    const beatsIn = (onsetMs - 600) / bedBeatMs;
    assert.ok(Math.abs(beatsIn - Math.round(beatsIn)) < 0.02, "click " + k + " at " + beatsIn.toFixed(3) + " bed beats");
    checked++;
  }
  assert.ok(checked >= 8, "checked " + checked + " clicks — at least 8 should be beat-consistent");
});
