import { isStaleDesktopAnalysis } from "./analysis-provenance";

export const WAVEYARD_MIXING_CONFIDENCE_THRESHOLD = 0.5;

export function hasReliableMixingConfidence(value: number | null | undefined): boolean {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= WAVEYARD_MIXING_CONFIDENCE_THRESHOLD
    && value <= 1;
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
