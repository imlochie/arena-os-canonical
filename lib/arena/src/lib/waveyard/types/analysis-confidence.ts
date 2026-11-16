import { isStaleDesktopAnalysis } from "./analysis-provenance";

export const WAVEYARD_MIXING_CONFIDENCE_THRESHOLD = 0.5;
const BPM_CONFIDENCE_WEIGHT = 0.55;
const BEAT_GRID_ALIGNMENT_WEIGHT = 0.45;

export function hasReliableMixingConfidence(value: number | null | undefined): boolean {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= WAVEYARD_MIXING_CONFIDENCE_THRESHOLD
    && value <= 1;
}

/**
 * Recover the phase-fit component persisted inside beatConfidence.
 *
 * Desktop analysis v1.4 stores:
 *   beatConfidence = 0.55 * bpmConfidence + 0.45 * gridAlignmentConfidence
 * Keeping this inversion here lets callers distinguish a weak autocorrelation
 * tempo score from a beat grid that independently fits the audio well. Callers
 * must first verify current desktop-analysis provenance; older/other engines
 * may use a different formula.
 */
export function recoverBeatGridAlignmentConfidence(
  bpmConfidence: number | null | undefined,
  beatConfidence: number | null | undefined,
): number | null {
  if (![bpmConfidence, beatConfidence].every((value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) return null;
  const recovered = (beatConfidence! - BPM_CONFIDENCE_WEIGHT * bpmConfidence!) / BEAT_GRID_ALIGNMENT_WEIGHT;
  // Allow only small persisted rounding error; do not turn inconsistent or
  // legacy confidence values into usable phase evidence.
  if (recovered < -0.003 || recovered > 1.003) return null;
  return Math.round(Math.max(0, Math.min(1, recovered)) * 1000) / 1000;
}

/** Shared forward calculation; keep persisted confidence semantics in sync. */
export function combineBeatGridConfidence(
  bpmConfidence: number | null | undefined,
  alignmentConfidence: number | null | undefined,
  beatCount: number,
): number | null {
  if (!Number.isSafeInteger(beatCount) || beatCount < 0) return null;
  if (beatCount < 3) return 0;
  if (typeof alignmentConfidence !== "number" || !Number.isFinite(alignmentConfidence)) return null;
  const tempoEvidence = Math.max(0, Math.min(1, bpmConfidence ?? 0));
  const gridEvidence = Math.max(0, Math.min(1, alignmentConfidence));
  return Math.round((BPM_CONFIDENCE_WEIGHT * tempoEvidence + BEAT_GRID_ALIGNMENT_WEIGHT * gridEvidence) * 1000) / 1000;
}

export function trustedAnalysisBpm(
  bpm: number | null | undefined,
  confidence: number | null | undefined,
): number | null {
  return hasReliableMixingConfidence(confidence)
    && typeof bpm === "number"
    && Number.isFinite(bpm)
    && bpm >= 40
    && bpm <= 300
    ? bpm
    : null;
}

export function trustedAnalysisKey(
  key: string | null | undefined,
  confidence: number | null | undefined,
): string | null {
  return hasReliableMixingConfidence(confidence) && typeof key === "string" && key.trim().length > 0
    ? key
    : null;
}

export function trustedAnalysisBeatGrid(
  value: unknown,
  bpmConfidence: number | null | undefined,
  beatConfidence: number | null | undefined,
): number[] | null {
  if (!hasReliableMixingConfidence(bpmConfidence) || !hasReliableMixingConfidence(beatConfidence)) return null;
  if (!Array.isArray(value) || value.length < 2) return null;

  let previous = -1;
  for (const beat of value) {
    if (typeof beat !== "number" || !Number.isFinite(beat) || beat < 0 || beat <= previous) return null;
    previous = beat;
  }
  return value;
}

export type CompactAnalysisInput = {
  bpm?: number | null;
  bpmConfidence?: number | null;
  musicalKey?: string | null;
  keyConfidence?: number | null;
  analysisEngine?: string | null;
  analysisEngineVersion?: string | null;
};

export function compactMusicAnalysisLabel(analysis: CompactAnalysisInput | null | undefined): string {
  if (!analysis) return "Tempo unavailable · Key unavailable";
  if (isStaleDesktopAnalysis({
    analysisEngine: analysis.analysisEngine ?? null,
    analysisEngineVersion: analysis.analysisEngineVersion ?? null,
  })) return "Analysis needs refresh";

  const bpm = trustedAnalysisBpm(analysis.bpm, analysis.bpmConfidence);
  const key = trustedAnalysisKey(analysis.musicalKey, analysis.keyConfidence);
  const tempoLabel = bpm === null
    ? analysis.bpm == null ? "Tempo unavailable" : "Tempo uncertain"
    : `≈${bpm.toFixed(1)} BPM`;
  const keyLabel = key ?? (analysis.musicalKey ? "Key uncertain" : "Key unavailable");
  return `${tempoLabel} · ${keyLabel}`;
}
