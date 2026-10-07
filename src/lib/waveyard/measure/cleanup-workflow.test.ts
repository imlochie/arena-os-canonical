/**
 * Cleanup workflow tests — scan → recommend → preview/apply semantics over
 * real DSP. Plus insert persistence normalisation (P1) and PCM decoding
 * honesty (native WAV, real DependencyMissingError when ffmpeg is absent).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normaliseRemixState } from "../remix";
import { scanAudioForProblems } from "./cleanup";
import { recommendationsForFindings, type CleanupOperation } from "./recommend";
import { decodeSourceToStereoPcm, DependencyMissingError } from "./pcm";
import { encodeWav16 } from "../mixer/synth";
import { processWithChain, parseInserts, INSERTS_FORMAT, type InsertChain } from "../mixer/inserts";

const FS = 48000;

function sineWithHum(): Float32Array {
  // 1.5 s, quiet dual-mono + a 50 Hz hum tone well above the noise bed.
  const frames = Math.round(1.5 * FS);
  const pcm = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const t = i / FS;
    const signal = 0.05 * Math.sin(2 * Math.PI * 220 * t) + 0.02 * Math.sin(2 * Math.PI * 50 * t);
    pcm[i * 2] = signal;
    pcm[i * 2 + 1] = signal;
  }
  return pcm;
}

test("recommendations map measured hum to a real notch at the measured frequency", () => {
  const report = scanAudioForProblems(sineWithHum(), FS);
  const hum = report.findings.find((finding) => finding.kind === "hum");
  assert.notEqual(hum, undefined, "scan must find the hum");
  const ops = recommendationsForFindings(report);
  const notch = ops.find((op) => op.processor === "notch");
  assert.notEqual(notch, undefined, "hum must map to a notch");
  assert.equal(notch!.params.freqHz, Number((hum!.evidence as { freqHz: number }).freqHz));
  assert.match(notch!.reason, /Hz hum/);
});

test("recommendations never fabricate repairs for unfixable findings", () => {
  const ops = recommendationsForFindings({
    format: "waveyard-cleanup-v1",
    findings: [
      {
        kind: "stereo-imbalance",
        severity: "warn",
        measured: true,
        summary: "L is 3 dB hotter",
        evidence: { imbalanceDb: 3 },
      },
      {
        kind: "mono-incompatibility",
        severity: "high",
        measured: true,
        summary: "antiphase content",
        evidence: { correlation: -0.8 },
      },
    ],
    summaryText: "",
    measurements: {
      sampleRate: FS, frames: 1, durationSeconds: 0, peakDb: -6, truePeakDb: -6, rmsDb: -12,
      crestDb: 6, dcOffset: 0, lufsIntegrated: null, lufsShortTermMax: null,
      stereoCorrelation: -0.8, stereoWidthDb: null,
      clipped: { regions: 0, clippedSamples: 0, clippedSeconds: 0, worstRegionMs: 0 },
    },
    spectral: { sub: -30, low: -30, lowMid: -30, mid: -30, highMid: -30, high: -30, air: -40 },
    scannedAt: new Date().toISOString(),
  });
  assert.equal(ops.length, 0, "no real processor maps to these findings — none may be offered");
});

test("recommended operations actually attenuate the hum when processed", () => {
  const pcm = sineWithHum();
  const report = scanAudioForProblems(pcm, FS);
  const ops = recommendationsForFindings(report);
  assert.ok(ops.length > 0);
  const chain: InsertChain = ops.map((op, index) => ({
    id: `t-${index}`,
    processor: op.processor as InsertChain[number]["processor"],
    enabled: true,
    wet: 1,
    params: op.params,
  }));
  const humBefore = goertzel(pcm, 50);
  const processed = processWithChain(Float32Array.from(pcm), chain, FS);
  const humAfter = goertzel(processed, 50);
  assert.ok(
    humAfter < humBefore * 0.5,
    `hum must measurably drop (before ${humBefore.toFixed(4)}, after ${humAfter.toFixed(4)})`,
  );
});

function goertzel(pcm: Float32Array, freqHz: number): number {
  const n = pcm.length / 2;
  const k = Math.round((n * freqHz) / FS);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i += 1) {
    s0 = pcm[i * 2] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
}

// ---------------------------------------------------------------------------
// P1: insert persistence normalisation semantics
// ---------------------------------------------------------------------------

function minimalState() {
  return {
    name: "test",
    masterVolume: 0.9,
    tracks: [
      {
        id: "track-1",
        stemAssetId: "11111111-1111-1111-1111-111111111111",
        name: "stem",
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
        clips: [
          {
            id: "clip-1",
            stemAssetId: "11111111-1111-1111-1111-111111111111",
            timelineStartMs: 0,
            durationMs: 1000,
            sourceOffsetMs: 0,
          },
        ],
      },
    ],
  };
}

test("normaliseRemixState keeps persisted inserts when the field is absent", () => {
  const state = normaliseRemixState({ ...minimalState(), tracks: [{ ...minimalState().tracks[0], inserts: undefined }] });
  assert.notEqual(state, null);
  assert.equal(state!.tracks[0].inserts, undefined);
});

test("normaliseRemixState accepts a valid chain and null clears it", () => {
  const chain = [{ id: "a", processor: "notch", enabled: true, wet: 1, params: { freqHz: 60, q: 12 } }];
  const withChain = normaliseRemixState({ ...minimalState(), tracks: [{ ...minimalState().tracks[0], inserts: chain }], masterInserts: chain });
  assert.notEqual(withChain, null);
  assert.equal(withChain!.tracks[0].inserts!.length, 1);
  assert.equal(withChain!.masterInserts!.length, 1);
  const cleared = normaliseRemixState({ ...minimalState(), tracks: [{ ...minimalState().tracks[0], inserts: null }], masterInserts: null });
  assert.deepEqual(cleared!.tracks[0].inserts, []);
  assert.deepEqual(cleared!.masterInserts, []);
});

test("normaliseRemixState rejects invalid insert chains (whole state, not silent clamp)", () => {
  const bad = normaliseRemixState({ ...minimalState(), tracks: [{ ...minimalState().tracks[0], inserts: [{ id: "x", processor: "flanger", enabled: true, wet: 1, params: {} }] }] });
  assert.equal(bad, null, "unknown processor must reject the state");
  const corruptString = normaliseRemixState({ ...minimalState(), masterInserts: "{not json" });
  assert.equal(corruptString, null, "corrupt JSON string must reject the state");
});

test("parseInserts round-trips serialised chains and rejects foreign formats", () => {
  const chain: InsertChain = [{ id: "z", processor: "highpass", enabled: false, wet: 0.5, params: { cutoffHz: 90, q: 0.7071 } }];
  const serialised = JSON.stringify({ format: INSERTS_FORMAT, inserts: chain });
  const parsed = parseInserts(JSON.parse(serialised));
  assert.deepEqual(parsed, chain);
  assert.equal(parseInserts({ format: "something-else", inserts: chain }), null);
});

// ---------------------------------------------------------------------------
// PCM decode honesty
// ---------------------------------------------------------------------------

test("decodeSourceToStereoPcm natively decodes a 16-bit WAV (no ffmpeg needed)", async () => {
  const pcm = sineWithHum();
  const wav = encodeWav16(pcm, FS);
  const dir = await mkdtemp(join(tmpdir(), "arena-pcm-"));
  const path = join(dir, "source.wav");
  try {
    await writeFile(path, wav);
    const decoded = await decodeSourceToStereoPcm(path);
    assert.equal(decoded.sampleRate, FS);
    assert.ok(Math.abs(decoded.pcm.length - pcm.length) <= 2, "length preserved");
    let maxError = 0;
    for (let i = 0; i < Math.min(decoded.pcm.length, pcm.length); i += 1) {
      maxError = Math.max(maxError, Math.abs(decoded.pcm[i] - pcm[i]));
    }
    assert.ok(maxError < (1 / 32768) * 1.6, `16-bit round-trip error ${maxError} within quantisation`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-WAV source without ffmpeg fails honestly with DEPENDENCY_MISSING", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arena-pcm-"));
  const path = join(dir, "compressed.bin");
  try {
    await writeFile(path, Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00])); // ID3 header — not WAV
    await assert.rejects(
      () => decodeSourceToStereoPcm(path),
      (error: unknown) => error instanceof DependencyMissingError && /ffmpeg/.test(error.message),
      "must name ffmpeg as the missing dependency, never silently return nothing",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
