/**
 * Measurement core tests — calibrated against physical anchors:
 *  - EBU/ITU anchor: dual-mono 1 kHz sine at −23 dBFS PEAK ⇒ −23.0 LUFS
 *  - full-scale dual-mono sine ⇒ ≈ 0 LUFS
 *  - 16 kHz sine @48 k (3 samples/cycle) shows real inter-sample peaks
 *  - clipped / DC-offset / hum fixtures are synthesized, not mocked
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  bandRmsDb,
  clippedRegions,
  dcOffset,
  measureAudio,
  measureLoudness,
  rmsDb,
  samplePeak,
  stereoCorrelation,
  truePeakDb,
  kWeightCoeffs,
} from "./meters";
import type { StereoBuffer } from "./dsp";
import { gainToDb } from "./gain";

const FS = 48000;

function sine(seconds: number, freqHz: number, amplitude: number, dualMono = true): StereoBuffer {
  const frames = Math.round(seconds * FS);
  const buffer = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = amplitude * Math.sin((2 * Math.PI * freqHz * i) / FS);
    buffer[i * 2] = v;
    if (dualMono) buffer[i * 2 + 1] = v;
  }
  return buffer;
}

test("LUFS anchor: dual-mono 1 kHz sine at −23 dBFS peak ⇒ −23.0 LUFS (spec-exact at 48 k)", () => {
  const buffer = sine(5, 1000, 10 ** (-23 / 20));
  const result = measureLoudness(buffer, FS);
  assert.notEqual(result.integrated, null);
  assert.ok(
    Math.abs(result.integrated! - (-23)) < 0.1,
    `integrated was ${result.integrated}`,
  );
});

test("LUFS anchor: full-scale dual-mono 1 kHz sine ⇒ ≈ 0 LUFS", () => {
  const buffer = sine(5, 1000, 1.0);
  const result = measureLoudness(buffer, FS);
  assert.ok(Math.abs(result.integrated!) < 0.1, `was ${result.integrated}`);
});

test("LUFS: silence reports null, never a fabricated number", () => {
  const buffer = new Float32Array(FS * 2 * 2);
  assert.equal(measureLoudness(buffer, FS).integrated, null);
});

test("K-weighting source is reported honestly", () => {
  assert.equal(kWeightCoeffs(48000).source, "bs1770-48k-exact");
  assert.equal(kWeightCoeffs(44100).source, "rbj-prototype");
});

test("true peak catches inter-sample peaks a 16 kHz sine at 48 k", () => {
  const buffer = sine(1, 16000, 0.9);
  const samplePeakDb = gainToDb(samplePeak(buffer));
  const tp = truePeakDb(buffer, FS);
  assert.ok(tp - samplePeakDb > 0.8, `ISP was only ${tp - samplePeakDb} dB`);
  assert.ok(Math.abs(tp - gainToDb(0.9)) < 0.6, `true peak ${tp} vs amplitude ${gainToDb(0.9)}`);
});

test("clipping detection counts distinct episodes (plateaus within an episode merge)", () => {
  // Five clipped bursts (0.1 s) separated by clean tone (0.15 s).
  const frames = FS * 1.25;
  const buffer = new Float32Array(frames * 2);
  const cycle = 0.25 * FS;
  for (let i = 0; i < frames; i++) {
    const inBurst = i % cycle < 0.1 * FS;
    const raw = inBurst ? 2 * Math.sin((2 * Math.PI * 1000 * i) / FS) : 0.4 * Math.sin((2 * Math.PI * 1000 * i) / FS);
    const v = Math.max(-1, Math.min(1, raw));
    buffer[i * 2] = v;
    buffer[i * 2 + 1] = v;
  }
  const stats = clippedRegions(buffer, FS);
  assert.equal(stats.regions, 5);
  assert.ok(stats.clippedSamples > 100);
  assert.ok(stats.clippedSeconds > 0.002);

  // A continuously clipped tone is ONE clipping episode (plateaus merge).
  const cont = new Float32Array(FS * 2);
  for (let i = 0; i < FS; i++) {
    const raw = 2 * Math.sin((2 * Math.PI * 1000 * i) / FS);
    const v = Math.max(-1, Math.min(1, raw));
    cont[i * 2] = v;
    cont[i * 2 + 1] = v;
  }
  assert.equal(clippedRegions(cont, FS).regions, 1);
});

test("clean sine reports zero clipped regions", () => {
  const buffer = sine(1, 440, 0.5);
  assert.equal(clippedRegions(buffer, FS).regions, 0);
});

test("DC offset is measured", () => {
  const buffer = sine(0.5, 440, 0.2);
  for (let i = 0; i < buffer.length; i += 2) buffer[i] += 0.05;
  assert.ok(Math.abs(dcOffset(buffer) - 0.025) < 0.005); // one channel offset by 0.05
});

test("stereo correlation: +1 for dual-mono, −1 for antiphase", () => {
  const mono = sine(0.5, 440, 0.3);
  assert.ok(Math.abs(stereoCorrelation(mono)! - 1) < 1e-6);
  const anti = sine(0.5, 440, 0.3, false);
  for (let i = 1; i < anti.length; i += 2) anti[i] = -anti[i - 1];
  assert.ok(Math.abs(stereoCorrelation(anti)! - (-1)) < 1e-6);
});

test("band energy: a 1 kHz sine dominates the mid band, not the air band", () => {
  const buffer = sine(0.5, 1000, 0.5);
  const overall = rmsDb(buffer);
  assert.ok(bandRmsDb(buffer, FS, 350, 2000) - overall > -2);
  assert.ok(bandRmsDb(buffer, FS, 12000, 18000) - overall < -30);
});

test("measureAudio returns a coherent measurement set", () => {
  const buffer = sine(2, 440, 0.5);
  const m = measureAudio(buffer, FS);
  assert.ok(Math.abs(m.peakDb - gainToDb(0.5)) < 0.05);
  assert.ok(Math.abs(m.rmsDb - gainToDb(0.5 / Math.SQRT2)) < 0.05);
  assert.ok(Math.abs(m.crestDb - 3.01) < 0.05);
  assert.ok(Math.abs(m.stereoCorrelation! - 1) < 1e-6);
  assert.equal(m.clipped.regions, 0);
  assert.ok(m.durationSeconds > 1.99 && m.durationSeconds < 2.01);
  assert.equal(m.sampleRate, FS);
});
