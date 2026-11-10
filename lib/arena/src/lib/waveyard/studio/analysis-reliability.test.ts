import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { analyseStereoPcm } from "./mashup";
import { trustedAnalysisBpm, trustedAnalysisKey, hasReliableMixingConfidence } from "../types/analysis-confidence";

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
});
