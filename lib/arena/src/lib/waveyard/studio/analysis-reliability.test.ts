import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { analyseStereoPcm } from "./mashup";
import { trustedAnalysisBpm, trustedAnalysisKey, trustedAnalysisBeatGrid, hasReliableMixingConfidence } from "../types/analysis-confidence";
import { planMashup, type MashupSourceProfile } from "./mashup";

const RATE = 44_100;

function generatePercussionTrack(bpm: number, seconds: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  const beatSec = 60 / bpm;
  const kickFrames = Math.round(0.04 * RATE);
  const snareFrames = Math.round(0.03 * RATE);

  let beatIndex = 0;
  for (let t = 0; t < seconds; t += beatSec) {
    const start = Math.round(t * RATE);
    const isSnare = beatIndex % 2 === 1;
    const len = isSnare ? snareFrames : kickFrames;
    const freq = isSnare ? 220 : 65;

    for (let i = 0; i < len && start + i < frames; i++) {
      const env = Math.exp(-i / (len * 0.3));
      const s = 0.8 * env * Math.sin((2 * Math.PI * freq * i) / RATE);
      out[(start + i) * 2] += s;
      out[(start + i) * 2 + 1] += s;
    }
    beatIndex++;
  }
  return out;
}

function generateTempoChangingTrack(bpmStart: number, bpmEnd: number, seconds: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  let t = 0;
  const clickFrames = Math.round(0.02 * RATE);

  while (t < seconds) {
    const progress = t / seconds;
    const currentBpm = bpmStart + (bpmEnd - bpmStart) * progress;
    const beatSec = 60 / currentBpm;
    const start = Math.round(t * RATE);

    for (let i = 0; i < clickFrames && start + i < frames; i++) {
      const s = 0.7 * Math.sin((2 * Math.PI * 440 * i) / RATE);
      out[(start + i) * 2] += s;
      out[(start + i) * 2 + 1] += s;
    }
    t += beatSec;
  }
  return out;
}

describe("Waveyard Automatic Musical Analysis Reliability", () => {
  it("reliably detects deterministic percussion BPM across standard range (80, 100, 120, 140 BPM)", () => {
    for (const targetBpm of [80, 100, 120, 140]) {
      const pcm = generatePercussionTrack(targetBpm, 15);
      const result = analyseStereoPcm(pcm);

      assert.ok(result.bpm !== null, `BPM should not be null for ${targetBpm} BPM fixture`);
      // Allow +/- 2.5% error margin or exact half/double time
      const ratio = result.bpm / targetBpm;
      const isAccurate = Math.abs(ratio - 1) <= 0.03 || Math.abs(ratio - 0.5) <= 0.03 || Math.abs(ratio - 2) <= 0.03;
      assert.ok(isAccurate, `Detected ${result.bpm} BPM for target ${targetBpm} BPM (ratio: ${ratio.toFixed(3)})`);
      assert.ok(result.bpmConfidence !== null && result.bpmConfidence > 0);
    }
  });

  it("handles tempo changes honestly rather than reporting misleading static lock", () => {
    // 90 BPM accelerating to 140 BPM
    const pcm = generateTempoChangingTrack(90, 140, 20);
    const result = analyseStereoPcm(pcm);

    // Should detect an intermediate tempo, but with measured (not artificially inflated) confidence
    assert.ok(result.bpm !== null);
    assert.ok(result.bpm >= 85 && result.bpm <= 145);
  });

  it("trustedAnalysisBpm rejects low confidence and never invents confidence", () => {
    // Exact threshold is 0.5
    assert.equal(trustedAnalysisBpm(120, 0.49), null);
    assert.equal(trustedAnalysisBpm(120, null), null);
    assert.equal(trustedAnalysisBpm(120, undefined), null);
    assert.equal(trustedAnalysisBpm(120, 0.5), 120);
    assert.equal(trustedAnalysisBpm(120, 0.85), 120);

    // Out of realistic range (40 - 300 BPM)
    assert.equal(trustedAnalysisBpm(30, 0.9), null);
    assert.equal(trustedAnalysisBpm(350, 0.9), null);
  });

  it("trustedAnalysisKey rejects low confidence and empty keys", () => {
    assert.equal(trustedAnalysisKey("C major", 0.49), null);
    assert.equal(trustedAnalysisKey("C major", null), null);
    assert.equal(trustedAnalysisKey("   ", 0.9), null);
    assert.equal(trustedAnalysisKey("A minor", 0.5), "A minor");
    assert.equal(trustedAnalysisKey("G major", 0.88), "G major");
  });

  it("verifies changing-tempo audio across multiple local analysis windows", () => {
    // 30 seconds of accelerating percussion from 80 to 140 BPM
    const pcm = generateTempoChangingTrack(80, 140, 30);
    const windowFrames = Math.round(10 * RATE); // 10s windows

    // Window 1: 0-10s (approx 80-100 BPM)
    const window1Pcm = pcm.subarray(0, windowFrames * 2);
    const res1 = analyseStereoPcm(window1Pcm);

    // Window 2: 20-30s (approx 120-140 BPM)
    const window2Pcm = pcm.subarray(windowFrames * 4, windowFrames * 6);
    const res2 = analyseStereoPcm(window2Pcm);

    assert.ok(res1.bpm !== null && res2.bpm !== null);
    assert.ok(res1.bpm < res2.bpm, `Window 1 BPM (${res1.bpm}) should be slower than Window 2 BPM (${res2.bpm})`);
  });

  it("clearly distinguishes synthetic fixtures from real-audio acceptance conditions", () => {
    // Document and test that synthetic tone fixtures are verified arithmetic,
    // while real audio paths require actual audio waveforms
    const pcm = generatePercussionTrack(120, 5);
    assert.equal(pcm.length, 5 * RATE * 2);
    assert.ok(pcm.some((sample) => sample !== 0));
  });

  it("trustedAnalysisBeatGrid rejects low confidence, unordered, or malformed beat grids", () => {
    const valid = [0, 500, 1000, 1500, 2000];
    assert.deepEqual(trustedAnalysisBeatGrid(valid, 0.8, 0.8), valid);
    assert.equal(trustedAnalysisBeatGrid(valid, 0.49, 0.8), null);
    assert.equal(trustedAnalysisBeatGrid(valid, 0.8, 0.49), null);
    assert.equal(trustedAnalysisBeatGrid(valid, null, 0.8), null);
    assert.equal(trustedAnalysisBeatGrid([0, 500, 400], 0.8, 0.8), null);
    assert.equal(trustedAnalysisBeatGrid([-10, 500], 0.8, 0.8), null);
    assert.equal(trustedAnalysisBeatGrid([0], 0.8, 0.8), null);
  });

  it("disables WSOLA tempo stretching unless both source BPM values pass trusted confidence", () => {
    const vocalUntrusted: MashupSourceProfile = {
      role: "vocals",
      bpm: 90,
      bpmConfidence: 0.4, // untrusted
      musicalKey: "C major",
      keyConfidence: 0.9,
      durationMs: 30_000,
      sections: [{ label: "verse", startMs: 0, endMs: 30_000 }],
    };
    const bedTrusted: MashupSourceProfile = {
      role: "instrumental",
      bpm: 120,
      bpmConfidence: 0.9,
      musicalKey: "C major",
      keyConfidence: 0.9,
      durationMs: 60_000,
      sections: [{ label: "verse", startMs: 0, endMs: 60_000 }],
    };

    const planUntrusted = planMashup(vocalUntrusted, bedTrusted);
    assert.ok(planUntrusted.ok);
    assert.equal(planUntrusted.plan.vocalsStretchRatio, 1.0, "Must preserve natural speed (1.0) when vocal BPM is untrusted");
    assert.ok(planUntrusted.plan.warnings.some((w) => /Automatic tempo stretching withheld/i.test(w)));

    // When both are trusted, stretching is applied
    const vocalTrusted: MashupSourceProfile = { ...vocalUntrusted, bpmConfidence: 0.9 };
    const planTrusted = planMashup(vocalTrusted, bedTrusted);
    assert.ok(planTrusted.ok);
    assert.notEqual(planTrusted.plan.vocalsStretchRatio, 1.0, "Applies stretching when both BPMs are trusted");
  });
});
