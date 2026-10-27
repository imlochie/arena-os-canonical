/**
 * Mashup brain tests — the reassurance pass for song × song and extension.
 * Signals are synthetic with KNOWN tempo/key/sections, so sync is verified
 * arithmetically: after the render, a 140 BPM vocal's onsets must land on
 * the 100 BPM bed's beat grid, key moves must be musically correct, and the
 * extension must be longer with crossfaded, non-clipping loops.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  pitchMoveForKeys,
  planMashup,
  planSongExtension,
  renderMashup,
  renderSongExtension,
  warpRatioForTempos,
  type MashupSourceProfile,
  type MashupSection,
} from "./mashup";

const RATE = 44_100;

function section(label: string, startMs: number, endMs: number): MashupSection {
  return { label, startMs, endMs };
}

function profile(overrides: Partial<MashupSourceProfile>): MashupSourceProfile {
  return { role: "instrumental", bpm: 120, musicalKey: null, durationMs: 60_000, sections: [], ...overrides };
}

// --- tempo warping ---------------------------------------------------------

test("warp ratio: near-equal tempos stretch lightly", () => {
  assert.ok(Math.abs(warpRatioForTempos(102, 100) - 1.02) < 1e-9, "2% off is NOT a lock — it stretches");
});

test("warp ratio: half/double locks snap to the nearest-to-1 lock", () => {
  assert.equal(warpRatioForTempos(140, 70), 1, "140 over 70 is a double lock — stay at 1.0 (half-time feel)");
  assert.equal(warpRatioForTempos(71, 141), 1, "71 over 141 is a half lock — stay at 1.0");
  assert.equal(warpRatioForTempos(70, 140), 1, "70 over 140 = exact half relationship → natural speed (half-time feel)");
  assert.equal(warpRatioForTempos(200, 100), 1, "200 over 100 = exact double relationship → natural speed (double-time feel)");
  assert.ok(Math.abs(warpRatioForTempos(140.5, 70) - 1) < 1e-9, "140.5 over 70 is within 1% of 2:1 → natural speed");
});

test("warp ratio: clamps extreme mismatches to 0.5–2", () => {
  assert.equal(warpRatioForTempos(300, 100), 2);
  assert.equal(warpRatioForTempos(40, 100), 0.5);
});

// --- key moves -------------------------------------------------------------

test("key moves: same key stays, fifth shifts by tonic distance, relative stays", () => {
  assert.deepEqual(pitchMoveForKeys("C major", "C major"), { semitones: 0, relationship: "same" });
  // G major vocals over C major bed: shift +7 wraps to -5 (fifth down).
  const fifth = pitchMoveForKeys("G major", "C major");
  assert.equal(fifth.relationship, "fifth");
  assert.ok(Math.abs(fifth.semitones) === 5, `fifth shift should be ±5, got ${fifth.semitones}`);
  // C major over A minor: relative — same scale, no shift.
  assert.deepEqual(pitchMoveForKeys("C major", "A minor"), { semitones: 0, relationship: "relative" });
  // Unknown key: honest.
  assert.deepEqual(pitchMoveForKeys(null, "A minor"), { semitones: 0, relationship: "unknown" });
});

// --- planning --------------------------------------------------------------

test("plan: bed owns the tempo, vocal stretch + entry are explained", () => {
  const result = planMashup(
    profile({ role: "vocals", bpm: 140, musicalKey: "C major", durationMs: 30_000, sections: [section("verse", 4000, 20_000)] }),
    profile({ role: "instrumental", bpm: 100, musicalKey: "C major", durationMs: 60_000, sections: [section("intro", 0, 8000), section("verse", 8000, 30_000)] }),
  );
  assert.ok(result.ok);
  const { plan } = result;
  assert.equal(plan.masterBpm, 100);
  assert.ok(Math.abs(plan.vocalsStretchRatio - 1.4) < 1e-9, "140→100 BPM = stretch ×1.4");
  assert.equal(plan.vocalsPitchSemitones, 0);
  // Entry at the bed's first body section, not the intro.
  assert.equal(plan.segments[0].mashupStartMs, 8000);
  // Vocal body 4–20s stretched ×1.4 = 22.4s from 8s.
  assert.ok(Math.abs(plan.segments[0].mashupEndMs - 8000 - 16_000 * 1.4) < 1, `${plan.segments[0].mashupEndMs}`);
  assert.equal(plan.durationMs, 60_000);
  assert.ok(plan.rationale.length >= 4, "every decision is explained");
  assert.ok(plan.rationale.some((line) => line.includes("master tempo")));
});

test("plan: missing tempo analysis rejects honestly", () => {
  const result = planMashup(profile({ role: "vocals", bpm: null }), profile({ bpm: 100 }));
  assert.ok(!result.ok);
  assert.match(result.reason, /tempo analysis/i);
});

test("plan: large key shifts warn (veto belongs to the user's ears)", () => {
  const result = planMashup(
    profile({ role: "vocals", bpm: 120, musicalKey: "F# major" }),
    profile({ bpm: 120, musicalKey: "C major" }),
  );
  assert.ok(result.ok);
  assert.ok(Math.abs(result.plan.vocalsPitchSemitones) === 6);
  assert.ok(result.plan.warnings.some((line) => /semitone shift is large/i.test(line)));
});

test("plan: vocal longer than the bed truncates with a warning", () => {
  const result = planMashup(
    profile({ role: "vocals", bpm: 100, durationMs: 120_000 }),
    profile({ bpm: 100, durationMs: 30_000 }),
  );
  assert.ok(result.ok);
  assert.ok(result.plan.warnings.some((line) => /fades out at the bed's end/i.test(line)));
  assert.equal(result.plan.segments[0].mashupEndMs, 30_000);
});

// --- the sync reassurance: rendered vocal onsets land on bed beats ---------

/** 100 BPM bed: a steady bed tone (no transients). */
function bedTone(seconds: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = 0.25 * Math.sin((2 * Math.PI * 110 * i) / RATE);
    out[i * 2] = value;
    out[i * 2 + 1] = value;
  }
  return out;
}

/** 140 BPM vocal: a short click every beat (428.571ms), starting 600ms in. */
function vocalClicks140(seconds: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  const beat = (60_000 / 140) / 1000; // seconds per beat at 140 BPM
  const clickLength = Math.round(0.02 * RATE);
  for (let beatIndex = 0; beatIndex * beat < seconds - 0.02; beatIndex += 1) {
    const start = Math.round((0.6 + beatIndex * beat) * RATE);
    for (let i = 0; i < clickLength; i += 1) {
      const value = 0.9 * Math.sin((Math.PI * i) / clickLength);
      out[(start + i) * 2] = value;
      out[(start + i) * 2 + 1] = value;
    }
  }
  return out;
}

test("REASSURANCE: a 140 BPM vocal renders ON the 100 BPM bed's beat grid", () => {
  const bedSeconds = 12;
  const vocalSeconds = 10;
  const result = planMashup(
    profile({ role: "vocals", bpm: 140, durationMs: vocalSeconds * 1000, sections: [section("verse", 0, vocalSeconds * 1000)] }),
    profile({ bpm: 100, durationMs: bedSeconds * 1000, sections: [section("verse", 0, bedSeconds * 1000)] }),
  );
  assert.ok(result.ok);
  const plan = result.plan;
  assert.ok(Math.abs(plan.vocalsStretchRatio - 1.4) < 1e-9);

  const rendered = renderMashup(plan, { vocals: vocalClicks140(vocalSeconds), bed: bedTone(bedSeconds), sampleRate: RATE });
  assert.equal(rendered.length, bedSeconds * RATE * 2);

  // Expected: vocal click k starts at 0.6s + k×(3/7)s in source time; after
  // ×1.4 stretch each click sits at (0.6 + k×3/7)×1.4 = 0.84 + k×0.6s —
  // i.e. ON the 100 BPM grid (600 ms beats), offset 240 ms after entry 0.
  // (The segment starts at mashup 0 here.)
  const beatMs = 600;
  let checked = 0;
  for (let k = 0; k < 14; k += 1) {
    const onsetMs = 840 + k * beatMs;
    if (onsetMs > (bedSeconds - 1) * 1000) break;
    // Energy at the onset (60ms window) must clearly exceed the off-beat
    // trough 300ms away (bed tone alone + ducking).
    const atOnset = windowPeak(rendered, onsetMs, onsetMs + 60);
    const offBeat = windowPeak(rendered, onsetMs + 300, onsetMs + 360);
    assert.ok(atOnset > offBeat * 1.8, `click ${k}: onset ${atOnset.toFixed(3)} should beat off-beat ${offBeat.toFixed(3)} at ${onsetMs}ms`);
    checked += 1;
  }
  assert.ok(checked >= 10, `checked ${checked} clicks`);
});

test("REASSURANCE: half-lock leaves the vocal unsynchronized but beat-consistent", () => {
  // 70 BPM vocal clicks over a 140 BPM bed: ratio snaps to 1.0, so clicks
  // stay every 857.14ms = exactly every 2 bed beats.
  const bedSeconds = 12;
  const vocalSeconds = 10;
  const result = planMashup(
    profile({ role: "vocals", bpm: 70, durationMs: vocalSeconds * 1000, sections: [section("verse", 0, vocalSeconds * 1000)] }),
    profile({ bpm: 140, durationMs: bedSeconds * 1000, sections: [section("verse", 0, bedSeconds * 1000)] }),
  );
  assert.ok(result.ok);
  assert.equal(result.plan.vocalsStretchRatio, 1);

  const out = renderMashup(result.plan, {
    vocals: clicksAtBpm(vocalSeconds, 70, 0.6),
    bed: bedTone(bedSeconds),
    sampleRate: RATE,
  });
  const bedBeatMs = 60_000 / 140;
  const clickPeriodMs = 60_000 / 70;
  for (let k = 0; k < 10; k += 1) {
    const onsetMs = 600 + k * clickPeriodMs;
    if (onsetMs > (bedSeconds - 1) * 1000) break;
    // Every click must sit at a whole number of bed beats after the entry.
    const beatsIn = (onsetMs - 600) / bedBeatMs;
    assert.ok(Math.abs(beatsIn - Math.round(beatsIn)) < 0.02, `click ${k} at ${beatsIn.toFixed(3)} bed beats`);
    assert.ok(windowPeak(out, onsetMs, onsetMs + 60) > 0.2, `click ${k} audible`);
  }
});

function clicksAtBpm(seconds: number, bpm: number, startSeconds: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  const beat = 60 / bpm;
  const clickLength = Math.round(0.02 * RATE);
  for (let beatIndex = 0; startSeconds + beatIndex * beat < seconds - 0.02; beatIndex += 1) {
    const start = Math.round((startSeconds + beatIndex * beat) * RATE);
    for (let i = 0; i < clickLength; i += 1) {
      const value = 0.9 * Math.sin((Math.PI * i) / clickLength);
      out[(start + i) * 2] = value;
      out[(start + i) * 2 + 1] = value;
    }
  }
  return out;
}

function windowPeak(buffer: Float32Array, fromMs: number, toMs: number): number {
  const from = Math.floor((fromMs / 1000) * RATE) * 2;
  const to = Math.min(buffer.length, Math.floor((toMs / 1000) * RATE) * 2);
  let peak = 0;
  for (let i = from; i < to; i += 2) peak = Math.max(peak, Math.abs(buffer[i]));
  return peak;
}

test("render: bed ducks under active vocals, crossfades, never clips", () => {
  const result = planMashup(
    profile({ role: "vocals", bpm: 100, durationMs: 10_000, sections: [section("verse", 0, 10_000)] }),
    profile({ bpm: 100, durationMs: 10_000, sections: [section("verse", 0, 10_000)] }),
  );
  assert.ok(result.ok);
  const loudBed = new Float32Array(10 * RATE * 2).fill(0.9);
  const loudVocal = new Float32Array(10 * RATE * 2).fill(0.9);
  const out = renderMashup(result.plan, { vocals: loudVocal, bed: loudBed, sampleRate: RATE });

  // Mid-segment: bed 0.9×0.72 + vocal 0.9 = 1.548 → clamped at 1.0 (no clip
  // past full scale, values sane).
  const mid = out[5 * RATE * 2];
  assert.ok(mid <= 1.0001 && mid >= -1.0001);
  // Before the vocal segment's crossfade completes, bed is near full.
  const early = out[Math.round(0.02 * RATE) * 2];
  assert.ok(early > 0.8, `early bed ${early}`);
  for (const value of out) assert.ok(value >= -1.0001 && value <= 1.0001);
});

// --- extension -------------------------------------------------------------

test("extension: plan loops the last body section with bar-aligned fades", () => {
  const source = profile({
    bpm: 120,
    durationMs: 40_000,
    sections: [section("intro", 0, 4000), section("verse", 4000, 20_000), section("chorus", 20_000, 36_000)],
  });
  const plan = planSongExtension(source, { repeats: 2 });
  assert.ok(plan !== null);
  assert.equal(plan.section.label, "chorus", "default = last body section");
  assert.equal(plan.repeats, 2);
  // 120 BPM → bar = 2000ms → crossfade = min(1000, 1000) = 1000ms.
  assert.equal(plan.crossfadeMs, 1000);
  assert.equal(plan.durationMs, 36_000 + 16_000 * 2 + 2000);
  assert.ok(plan.rationale.length >= 3);
});

test("extension: render appends the loops after the original, crossfaded", () => {
  const source = profile({
    bpm: 100,
    durationMs: 20_000,
    sections: [section("chorus", 4000, 12_000)],
  });
  const plan = planSongExtension(source, { repeats: 2 });
  assert.ok(plan !== null);
  // Original 20s of steady tone.
  const pcm = new Float32Array(20 * RATE * 2);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 220 * (i >> 1)) / RATE);

  const out = renderSongExtension(plan, pcm, RATE);
  assert.equal(out.length, Math.round((plan.durationMs / 1000) * RATE) * 2);
  // The chorus (4–12s) replays at 12–20s and 20–28s: energy well past the
  // original's 20s end, no clipping, and the final bar fades to silence.
  assert.ok(windowPeak(out, 14_000, 15_000) > 0.2, "loop 1 is audible");
  assert.ok(windowPeak(out, 22_000, 23_000) > 0.2, "loop 2 is audible");
  assert.ok(windowPeak(out, plan.durationMs - 300, plan.durationMs) < 0.1, "tail fades out");
  for (const value of out) assert.ok(value >= -1.0001 && value <= 1.0001);
  // Original head is untouched.
  assert.ok(windowPeak(out, 0, 3000) > 0.2);
});

test("extension: no sections → no plan (honest null)", () => {
  assert.equal(planSongExtension(profile({ bpm: 120, durationMs: 10_000, sections: [] })), null);
});
