/**
 * Cleanup scanner tests — every fixture is synthesized with a KNOWN
 * defect (clipping, DC, hum, phase inversion, silence) so the assertions
 * check real detection, not mocked flows.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { scanAudioForProblems } from "./cleanup";
import type { StereoBuffer } from "../mixer/dsp";

const FS = 48000;

/** Deterministic seeded DUAL-MONO noise (xorshift32) — quiet background hiss. */
function noise(seconds: number, seed = 123456789, amplitude = 0.02): StereoBuffer {
  const frames = Math.round(seconds * FS);
  const buffer = new Float32Array(frames * 2);
  let state = seed;
  for (let i = 0; i < frames; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const v = (((state >>> 0) / 0xffffffff) * 2 - 1) * amplitude;
    buffer[i * 2] = v;
    buffer[i * 2 + 1] = v;
  }
  return buffer;
}

function withHum(buffer: StereoBuffer, freqHz: number, amplitude: number): StereoBuffer {
  const frames = buffer.length >> 1;
  const out = Float32Array.from(buffer);
  for (let i = 0; i < frames; i++) {
    const hum = amplitude * Math.sin((2 * Math.PI * freqHz * i) / FS);
    out[i * 2] += hum;
    out[i * 2 + 1] += hum;
  }
  return out;
}

test("clean dual-mono sine: no defect findings", () => {
  const frames = FS * 3;
  const buffer = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = 0.5 * Math.sin((2 * Math.PI * 440 * i) / FS);
    buffer[i * 2] = v;
    buffer[i * 2 + 1] = v;
  }
  const report = scanAudioForProblems(buffer, FS);
  const defectKinds = report.findings.map((finding) => finding.kind);
  assert.ok(
    !defectKinds.includes("clipping") &&
      !defectKinds.includes("dc-offset") &&
      !defectKinds.includes("hum") &&
      !defectKinds.includes("mono-incompatibility") &&
      !defectKinds.includes("predominantly-silent"),
    `unexpected findings: ${defectKinds.join(", ")}`,
  );
});

test("clipped signal: distinct episodes are counted in the scan report", () => {
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
  const report = scanAudioForProblems(buffer, FS);
  const clipping = report.findings.find((finding) => finding.kind === "clipping");
  assert.notEqual(clipping, undefined);
  assert.equal(clipping!.measured, true);
  assert.equal(clipping!.evidence.regions, 5);
  assert.ok(report.summaryText.includes("clipped region"));
});

test("DC offset is detected", () => {
  const frames = FS;
  const buffer = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = 0.2 * Math.sin((2 * Math.PI * 440 * i) / FS) + 0.05;
    buffer[i * 2] = v;
    buffer[i * 2 + 1] = v;
  }
  const report = scanAudioForProblems(buffer, FS);
  assert.ok(report.findings.some((finding) => finding.kind === "dc-offset"));
});

test("58 Hz hum hidden in quiet noise is detected with its frequency", () => {
  const buffer = withHum(noise(4), 58, 0.01);
  const report = scanAudioForProblems(buffer, FS);
  const hum = report.findings.find((finding) => finding.kind === "hum");
  assert.notEqual(hum, undefined, `findings: ${report.findings.map((f) => f.kind).join(",")}`);
  assert.equal(hum!.evidence.freqHz, 58);
  assert.ok(report.summaryText.includes("58 Hz hum"));
});

test("antiphase stereo flags mono incompatibility at high severity", () => {
  const frames = FS * 2;
  const buffer = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = 0.4 * Math.sin((2 * Math.PI * 440 * i) / FS);
    buffer[i * 2] = v;
    buffer[i * 2 + 1] = -v;
  }
  const report = scanAudioForProblems(buffer, FS);
  const finding = report.findings.find((item) => item.kind === "mono-incompatibility");
  assert.notEqual(finding, undefined);
  assert.equal(finding!.severity, "high");
});

test("loudness over target is measured, not hardcoded", () => {
  const frames = FS * 3;
  const buffer = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = 0.9 * Math.sin((2 * Math.PI * 1000 * i) / FS);
    buffer[i * 2] = v;
    buffer[i * 2 + 1] = v;
  }
  const report = scanAudioForProblems(buffer, FS, { targetLufs: -24 });
  const over = report.findings.find((finding) => finding.kind === "loudness-over-target");
  assert.notEqual(over, undefined);
  assert.ok((over!.evidence.lufs as number) > -24);
  // Same audio against a loud target: no finding.
  const relaxed = scanAudioForProblems(buffer, FS, { targetLufs: 0 });
  assert.equal(
    relaxed.findings.find((finding) => finding.kind === "loudness-over-target"),
    undefined,
  );
});

test("silence is reported honestly", () => {
  const buffer = new Float32Array(FS * 2 * 2);
  const report = scanAudioForProblems(buffer, FS);
  assert.ok(report.findings.some((finding) => finding.kind === "predominantly-silent"));
  assert.ok(report.measurements.lufsIntegrated === null);
});

test("report format is versioned and spectral bands are populated", () => {
  const buffer = withHum(noise(2), 100, 0.004);
  const report = scanAudioForProblems(buffer, FS);
  assert.equal(report.format, "waveyard-cleanup-v1");
  for (const band of ["sub", "low", "lowMid", "mid", "highMid", "high", "air"] as const) {
    assert.ok(Number.isFinite(report.spectral[band]));
  }
});
