export const DESKTOP_ANALYSIS_ENGINE = "arena-js-dsp";
export const DESKTOP_ANALYSIS_ENGINE_VERSION = "1.4.0";
/** Shared local DSP family for desktop-only stem analyses; distinct from the
 * NumPy worker provenance persisted by remote Python workers. */
export const DESKTOP_STEM_ANALYSIS_ENGINE = "arena-js-stem-analysis";
export const DESKTOP_STEM_ANALYSIS_ENGINE_VERSION = "1.0.0";
export const DESKTOP_SECTION_ENGINE = "arena-js-structure";
// 1.4 adds beat-grid phrase-window matching independent of novelty segmentation.
export const DESKTOP_SECTION_ENGINE_VERSION = "1.4.0";

export function isStaleDesktopAnalysis(analysis: {
  analysisEngine: string | null;
  analysisEngineVersion: string | null;
}): boolean {
  return analysis.analysisEngine === DESKTOP_ANALYSIS_ENGINE
    && analysis.analysisEngineVersion !== DESKTOP_ANALYSIS_ENGINE_VERSION;
}

export function desktopAnalysisIdempotencyKey(sourceAssetId: string): string {
  return `analysis:${sourceAssetId}:${DESKTOP_ANALYSIS_ENGINE}:${DESKTOP_ANALYSIS_ENGINE_VERSION}`;
}

export function isCurrentDesktopAnalysis(analysis: {
  analysisEngine: string | null;
  analysisEngineVersion: string | null;
}): boolean {
  return analysis.analysisEngine === DESKTOP_ANALYSIS_ENGINE
    && analysis.analysisEngineVersion === DESKTOP_ANALYSIS_ENGINE_VERSION;
}

export function isCurrentDesktopSectionAnalysis(analysis: {
  analysisEngine: string | null;
  analysisEngineVersion: string | null;
}): boolean {
  return analysis.analysisEngine === DESKTOP_SECTION_ENGINE
    && analysis.analysisEngineVersion === DESKTOP_SECTION_ENGINE_VERSION;
}

export function currentBpmConfidence(analysis: {
  analysisEngine: string | null;
  analysisEngineVersion: string | null;
  bpmConfidence: number | null;
}): number | null {
  return isCurrentDesktopAnalysis(analysis) ? analysis.bpmConfidence : null;
}

export function currentBeatConfidence(analysis: {
  analysisEngine: string | null;
  analysisEngineVersion: string | null;
  beatConfidence: number | null;
}): number | null {
  return isCurrentDesktopAnalysis(analysis) ? analysis.beatConfidence : null;
}

export function currentKeyConfidence(analysis: {
  analysisEngine: string | null;
  analysisEngineVersion: string | null;
  keyConfidence: number | null;
}): number | null {
  return isCurrentDesktopAnalysis(analysis) ? analysis.keyConfidence : null;
}
