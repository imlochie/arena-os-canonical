/**
 * Cleanup recommendations — deterministic mapping from MEASURED findings to
 * REAL processors that exist in the insert registry. Every recommendation
 * cites the evidence that produced it. Findings without a real repair get
 * no recommendation (never a fake fix).
 */

import type { CleanupFinding, CleanupReport } from "./cleanup";
import { validateInsertParams } from "../mixer/inserts";

export type CleanupOperation = {
  processor: string;
  params: Record<string, number>;
  addresses: CleanupFinding["kind"] | "user-selected";
  reason: string;
};

export function recommendationsForFindings(report: CleanupReport): CleanupOperation[] {
  const ops: CleanupOperation[] = [];
  const seen = new Set<string>();
  const push = (op: CleanupOperation) => {
    const key = `${op.processor}:${JSON.stringify(op.params)}`;
    if (seen.has(key)) return;
    if (validateInsertParams(op.processor, op.params) === null) return; // only real, valid processors
    seen.add(key);
    ops.push(op);
  };

  for (const finding of report.findings) {
    switch (finding.kind) {
      case "hum": {
        const freq = Number(finding.evidence.freqHz);
        push({
          processor: "notch",
          params: { freqHz: freq, q: 18 },
          addresses: "hum",
          reason: `Notch at the measured ${freq} Hz hum (evidence: ${finding.evidence.levelDb} dBFS tone, ${finding.evidence.contrastDb} dB above neighbors).`,
        });
        break;
      }
      case "dc-offset":
      case "rumble":
        push({
          processor: "highpass",
          params: { cutoffHz: finding.kind === "dc-offset" ? 20 : 45, q: 0.7071 },
          addresses: finding.kind,
          reason:
            finding.kind === "dc-offset"
              ? `High-pass removes DC offset (measured ${(Number(finding.evidence.dcOffset) * 100).toFixed(2)}%).`
              : `High-pass at 45 Hz trims measured sub-rumble (${finding.evidence.subShareDb} dB relative).`,
        });
        break;
      case "clipping":
        push({
          processor: "softclip",
          params: { ceilingDb: -1 },
          addresses: "clipping",
          reason: `Soft ceiling contains the ${finding.evidence.regions} measured clipped region(s) — note: de-clipping is reconstruction and is NOT claimed; this only prevents further digital overs.`,
        });
        break;
      case "sibilance":
        push({
          processor: "eq-band",
          params: { freqHz: 6500, gainDb: -3, q: 4 },
          addresses: "sibilance",
          reason: `De-esser cut in the measured sibilance region (${finding.evidence.highMidShareDb} dB relative in 2–6 kHz).`,
        });
        break;
      case "hf-noise":
        push({
          processor: "lowpass",
          params: { cutoffHz: 15000, q: 0.7071 },
          addresses: "hf-noise",
          reason: `Gentle low-pass reduces measured HF noise above 12 kHz (${finding.evidence.airShareDb} dB relative).`,
        });
        break;
      case "loudness-over-target": {
        const over = Number(finding.evidence.lufs) - Number(finding.evidence.targetLufs);
        push({
          processor: "gain",
          params: { gainDb: -Math.min(12, Math.round(over * 10) / 10) },
          addresses: "loudness-over-target",
          reason: `Attenuate by the measured ${over.toFixed(1)} LU excess toward the ${finding.evidence.targetLufs} LUFS target.`,
        });
        break;
      }
      default:
        // stereo-imbalance, mono-incompatibility, noise-floor,
        // predominantly-silent, near-clip: no honest single-shot repair
        // exists in the registry — reported, not "fixed".
        break;
    }
  }
  return ops;
}
