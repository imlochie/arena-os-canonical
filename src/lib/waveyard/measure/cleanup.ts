/**
 * Audio cleanup — SCAN from actual PCM. Every finding carries measured
 * evidence; nothing here is inferred or invented. (Inference belongs to
 * the AI layer, which consumes these measurements and must label its
 * conclusions as OBSERVED / INFERRED / RECOMMENDED.)
 *
 * The workflow contract is SCAN → PREVIEW → APPLY:
 *   scanAudioForProblems() measures (never modifies the original);
 *   repair operations are insert chains / worker jobs applied to derived
 *   copies only.
 */

import {
  bandRmsDb,
  clippedRegions,
  dcOffset,
  measureAudio,
  rmsDb,
  stereoCorrelation,
  type AudioMeasurements,
  CLIP_THRESHOLD,
} from "../mixer/meters";

export { measureAudio };
export type { AudioMeasurements } from "../mixer/meters";
import type { StereoBuffer } from "../mixer/dsp";
import { dspGainToDb } from "../mixer/dsp";

export const CLEANUP_FORMAT = "waveyard-cleanup-v1" as const;

export type CleanupFindingKind =
  | "clipping"
  | "near-clip"
  | "dc-offset"
  | "noise-floor"
  | "hum"
  | "hf-noise"
  | "rumble"
  | "sibilance"
  | "stereo-imbalance"
  | "mono-incompatibility"
  | "loudness-over-target"
  | "predominantly-silent";

export type Severity = "info" | "warn" | "high";

export type CleanupFinding = {
  kind: CleanupFindingKind;
  severity: Severity;
  /** Honest by construction: findings only exist when measured. */
  measured: true;
  summary: string;
  evidence: Record<string, number | string>;
};

export type CleanupReport = {
  format: typeof CLEANUP_FORMAT;
  findings: CleanupFinding[];
  summaryText: string;
  measurements: AudioMeasurements;
  spectral: SpectralBands;
  scannedAt: string;
};

export type SpectralBands = {
  sub: number; // 20–60
  low: number; // 60–120
  lowMid: number; // 120–350
  mid: number; // 350–2000
  highMid: number; // 2000–6000
  high: number; // 6000–12000
  air: number; // 12000–18000 (band-relative dB)
};

export type CleanupOptions = {
  targetLufs?: number;
  targetPeakDb?: number;
};

/** Goertzel magnitude at a frequency — real tone detection, not FFT magic. */
function goertzelMagnitude(buffer: StereoBuffer, sampleRate: number, freqHz: number): number {
  const frames = buffer.length >> 1;
  const k = (2 * Math.PI * freqHz) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const x = (buffer[frame * 2] + buffer[frame * 2 + 1]) * 0.5;
    const s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (frames * frames);
  return Math.sqrt(Math.max(0, power));
}

function frameRmsPercentileDb(
  buffer: StereoBuffer,
  sampleRate: number,
  frameMs: number,
  percentile: number,
): number {
  const frameSize = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const frames = (buffer.length >> 1) / frameSize;
  const values: number[] = [];
  for (let f = 0; f + 1 <= frames; f += 1) {
    let sum = 0;
    let count = 0;
    for (let i = f * frameSize; i < (f + 1) * frameSize && i < (buffer.length >> 1); i += 1) {
      const l = buffer[i * 2];
      const r = buffer[i * 2 + 1];
      sum += l * l + r * r;
      count += 2;
    }
    if (count > 0) values.push(Math.sqrt(sum / count));
  }
  if (values.length === 0) return -Infinity;
  values.sort((a, b) => a - b);
  const index = Math.min(values.length - 1, Math.floor((percentile / 100) * values.length));
  return dspGainToDb(values[index]);
}

export function scanAudioForProblems(
  buffer: StereoBuffer,
  sampleRate: number,
  options: CleanupOptions = {},
): CleanupReport {
  const measurements = measureAudio(buffer, sampleRate);
  const findings: CleanupFinding[] = [];
  const overallRms = rmsDb(buffer);
  const nyquist = sampleRate / 2;

  // --- Clipping / near-clip -------------------------------------------------
  if (measurements.clipped.regions > 0) {
    findings.push({
      kind: "clipping",
      severity: measurements.clipped.worstRegionMs > 10 ? "high" : "warn",
      measured: true,
      summary: `${measurements.clipped.regions} clipped region${measurements.clipped.regions === 1 ? "" : "s"} (${(measurements.clipped.clippedSeconds * 1000).toFixed(0)} ms total, worst ${(measurements.clipped.worstRegionMs).toFixed(0)} ms)`,
      evidence: {
        regions: measurements.clipped.regions,
        clippedSeconds: Number(measurements.clipped.clippedSeconds.toFixed(6)),
        worstRegionMs: Number(measurements.clipped.worstRegionMs.toFixed(2)),
        threshold: CLIP_THRESHOLD,
      },
    });
  }
  const targetPeak = options.targetPeakDb ?? -1;
  if (measurements.peakDb > targetPeak && measurements.clipped.regions === 0) {
    findings.push({
      kind: "near-clip",
      severity: "warn",
      measured: true,
      summary: `peak is ${measurements.peakDb.toFixed(2)} dBFS, ${(measurements.peakDb - targetPeak).toFixed(2)} dB over the ${targetPeak.toFixed(1)} dB target`,
      evidence: { peakDb: Number(measurements.peakDb.toFixed(3)), targetPeakDb: targetPeak },
    });
  }

  // --- DC offset ------------------------------------------------------------
  const dc = dcOffset(buffer);
  if (Math.abs(dc) > 0.002) {
    findings.push({
      kind: "dc-offset",
      severity: Math.abs(dc) > 0.02 ? "warn" : "info",
      measured: true,
      summary: `DC offset of ${(dc * 100).toFixed(2)}% detected`,
      evidence: { dcOffset: Number(dc.toFixed(5)) },
    });
  }

  // --- Noise floor ----------------------------------------------------------
  const noiseFloorDb = frameRmsPercentileDb(buffer, sampleRate, 50, 10);
  if (noiseFloorDb > -45 && noiseFloorDb !== -Infinity) {
    findings.push({
      kind: "noise-floor",
      severity: noiseFloorDb > -30 ? "warn" : "info",
      measured: true,
      summary: `noise floor around ${noiseFloorDb.toFixed(1)} dBFS (10th-percentile 50 ms frames)`,
      evidence: { noiseFloorDb: Number(noiseFloorDb.toFixed(2)) },
    });
  }

  // --- Hum (mains families ±2 Hz + harmonics, compared to neighboring tones) --
  const humCandidates: number[] = [];
  for (let f = 48; f <= 52; f += 1) humCandidates.push(f); // 50 Hz family
  for (let f = 58; f <= 62; f += 1) humCandidates.push(f); // 60 Hz family
  for (let f = 98; f <= 102; f += 1) humCandidates.push(f); // 100 Hz
  for (let f = 118; f <= 122; f += 1) humCandidates.push(f); // 120 Hz
  for (let f = 148; f <= 152; f += 1) humCandidates.push(f); // 150 Hz
  for (let f = 178; f <= 182; f += 1) humCandidates.push(f); // 180 Hz
  let hum: { freqHz: number; levelDb: number; contrastDb: number } | null = null;
  for (const freq of humCandidates) {
    if (freq > nyquist * 0.9) continue;
    const level = goertzelMagnitude(buffer, sampleRate, freq);
    const neighbor =
      (goertzelMagnitude(buffer, sampleRate, freq - 8) +
        goertzelMagnitude(buffer, sampleRate, freq + 8)) /
      2;
    const levelDb = dspGainToDb(level);
    const contrastDb = levelDb - dspGainToDb(neighbor);
    if (levelDb > -65 && contrastDb > 6) {
      if (hum === null || contrastDb > hum.contrastDb) hum = { freqHz: freq, levelDb, contrastDb };
    }
  }
  if (hum !== null) {
    findings.push({
      kind: "hum",
      severity: hum.levelDb > -40 ? "warn" : "info",
      measured: true,
      summary: `${hum.freqHz} Hz hum detected (${hum.levelDb.toFixed(1)} dBFS, ${hum.contrastDb.toFixed(1)} dB above neighboring tones)`,
      evidence: {
        freqHz: hum.freqHz,
        levelDb: Number(hum.levelDb.toFixed(2)),
        contrastDb: Number(hum.contrastDb.toFixed(2)),
      },
    });
  }

  // --- Spectral shares (band-relative to overall RMS) ------------------------
  const airTop = Math.min(18000, nyquist * 0.95);
  const spectral: SpectralBands = {
    sub: bandRmsDb(buffer, sampleRate, 20, 60) - overallRms,
    low: bandRmsDb(buffer, sampleRate, 60, 120) - overallRms,
    lowMid: bandRmsDb(buffer, sampleRate, 120, 350) - overallRms,
    mid: bandRmsDb(buffer, sampleRate, 350, 2000) - overallRms,
    highMid: bandRmsDb(buffer, sampleRate, 2000, 6000) - overallRms,
    high: bandRmsDb(buffer, sampleRate, 6000, 12000) - overallRms,
    air: bandRmsDb(buffer, sampleRate, 12000, airTop) - overallRms,
  };

  if (nyquist > 16000 && spectral.air > -18) {
    findings.push({
      kind: "hf-noise",
      severity: spectral.air > -12 ? "warn" : "info",
      measured: true,
      summary: `high-frequency energy above 12 kHz is ${spectral.air.toFixed(1)} dB relative to overall level`,
      evidence: { airShareDb: Number(spectral.air.toFixed(2)), band: "12000-" + airTop },
    });
  }
  if (spectral.sub > -14) {
    findings.push({
      kind: "rumble",
      severity: spectral.sub > -8 ? "warn" : "info",
      measured: true,
      summary: `low-end rumble (20–60 Hz) is ${spectral.sub.toFixed(1)} dB relative to overall level`,
      evidence: { subShareDb: Number(spectral.sub.toFixed(2)), band: "20-60" },
    });
  }
  if (spectral.highMid > -6) {
    findings.push({
      kind: "sibilance",
      severity: spectral.highMid > -3 ? "warn" : "info",
      measured: true,
      summary: `elevated energy in the 2–6 kHz presence/sibilance region (${spectral.highMid.toFixed(1)} dB relative)`,
      evidence: { highMidShareDb: Number(spectral.highMid.toFixed(2)), band: "2000-6000" },
    });
  }

  // --- Stereo ---------------------------------------------------------------
  const correlation = stereoCorrelation(buffer);
  if (correlation !== null && correlation < 0.2) {
    findings.push({
      kind: "mono-incompatibility",
      severity: correlation < -0.2 ? "high" : "warn",
      measured: true,
      summary: `stereo correlation is ${correlation.toFixed(2)} — ${correlation < -0.2 ? "out-of-phase content will cancel badly in mono" : "mono sum will lose significant level"}`,
      evidence: { correlation: Number(correlation.toFixed(4)) },
    });
  }
  // L/R imbalance from per-channel RMS.
  let leftSum = 0;
  let rightSum = 0;
  for (let i = 0; i < buffer.length; i += 2) {
    leftSum += buffer[i] * buffer[i];
    rightSum += buffer[i + 1] * buffer[i + 1];
  }
  const leftDb = dspGainToDb(Math.sqrt(leftSum / (buffer.length / 2)));
  const rightDb = dspGainToDb(Math.sqrt(rightSum / (buffer.length / 2)));
  if (Math.abs(leftDb - rightDb) > 1.5) {
    findings.push({
      kind: "stereo-imbalance",
      severity: "info",
      measured: true,
      summary: `left/right levels differ by ${Math.abs(leftDb - rightDb).toFixed(1)} dB`,
      evidence: {
        leftDb: Number(leftDb.toFixed(2)),
        rightDb: Number(rightDb.toFixed(2)),
      },
    });
  }

  // --- Loudness vs target ----------------------------------------------------
  if (
    options.targetLufs !== undefined &&
    measurements.lufsIntegrated !== null &&
    measurements.lufsIntegrated > options.targetLufs + 1
  ) {
    findings.push({
      kind: "loudness-over-target",
      severity: "info",
      measured: true,
      summary: `integrated loudness ${measurements.lufsIntegrated.toFixed(1)} LUFS is ${(measurements.lufsIntegrated - options.targetLufs).toFixed(1)} LU over the ${options.targetLufs} LUFS target`,
      evidence: {
        lufs: Number(measurements.lufsIntegrated.toFixed(2)),
        targetLufs: options.targetLufs,
      },
    });
  }

  // --- Silence ---------------------------------------------------------------
  const quietRms = frameRmsPercentileDb(buffer, sampleRate, 50, 90);
  if (quietRms < -70) {
    findings.push({
      kind: "predominantly-silent",
      severity: "info",
      measured: true,
      summary: `signal is predominantly silent (90th-percentile frame level ${quietRms.toFixed(1)} dBFS)`,
      evidence: { percentile90Db: Number(quietRms.toFixed(2)) },
    });
  }

  const summaryText =
    findings.length === 0
      ? "No problems measured in this audio."
      : `Problems found:\n${findings.map((finding) => `- ${finding.summary}`).join("\n")}`;

  return {
    format: CLEANUP_FORMAT,
    findings,
    summaryText,
    measurements,
    spectral,
    scannedAt: new Date().toISOString(),
  };
}

export { clippedRegions };
