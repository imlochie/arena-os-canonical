/**
 * Mastering recommendations — deterministic, measured, honest.
 *
 * Maps real measurements to real master-chain processors. Nothing claims a
 * "professionally mastered" result: each recommendation cites its
 * measurement, and the report shows before/after numbers only.
 */

import type { AudioMeasurements } from "../mixer/meters";
import type { SpectralBands } from "./cleanup";
import { validateInsertParams } from "../mixer/inserts";

export const MASTER_LOUDNESS_TARGET_LUFS = -14;

export type MasterOperation = {
  processor: string;
  params: Record<string, number>;
  reason: string;
};

export type MasterReport = {
  measurements: AudioMeasurements;
  spectral: SpectralBands;
  targetLufs: number;
  recommendations: MasterOperation[];
};

export function masterRecommendations(
  measurements: AudioMeasurements,
  spectral: SpectralBands,
  targetLufs = MASTER_LOUDNESS_TARGET_LUFS,
): MasterOperation[] {
  const ops: MasterOperation[] = [];
  const push = (op: MasterOperation) => {
    if (validateInsertParams(op.processor, op.params) === null) return;
    ops.push(op);
  };

  // True peak safety — a real ceiling, only when the measurement asks for it.
  if (measurements.truePeakDb > -0.3) {
    push({
      processor: "softclip",
      params: { ceilingDb: -1 },
      reason: `True peak is ${measurements.truePeakDb.toFixed(2)} dBFS — a −1 dBFS soft ceiling prevents inter-sample overs on lossy codecs.`,
    });
  }

  // Loudness gap — honest attenuation/gain toward the target, bounded.
  if (measurements.lufsIntegrated !== null) {
    const gap = targetLufs - measurements.lufsIntegrated;
    if (Math.abs(gap) >= 1) {
      push({
        processor: "gain",
        params: { gainDb: Math.round(Math.max(-12, Math.min(12, gap)) * 10) / 10 },
        reason: `Integrated loudness is ${measurements.lufsIntegrated.toFixed(1)} LUFS; ${gap > 0 ? "+" : ""}${gap.toFixed(1)} LU toward the ${targetLufs} LUFS target (bounded ±12 dB — a limiter is not claimed).`,
      });
    }
  }

  // Spectral balance — measured tilts only.
  if (spectral.highMid - spectral.lowMid > 4) {
    push({
      processor: "eq-band",
      params: { freqHz: 3500, gainDb: -2, q: 0.8 },
      reason: `2–6 kHz sits ${spectral.highMid.toFixed(1)} dB above the 120 Hz–2 kHz body — a gentle cut rebalances the tilt.`,
    });
  }
  if (spectral.low - spectral.mid > 6) {
    push({
      processor: "highpass",
      params: { cutoffHz: 35, q: 0.7071 },
      reason: `60–120 Hz energy is ${spectral.low.toFixed(1)} dB above the mid body — a 35 Hz high-pass removes inaudible sub weight without touching musical bass.`,
    });
  }

  // Mono compatibility — only when the measurement is actually risky.
  if (measurements.stereoCorrelation !== null && measurements.stereoCorrelation < -0.1) {
    push({
      processor: "width",
      params: { width: 0.9 },
      reason: `Stereo correlation is ${measurements.stereoCorrelation.toFixed(2)} — content cancels in mono. Narrowing to 0.9 improves compatibility.`,
    });
  }

  return ops;
}
