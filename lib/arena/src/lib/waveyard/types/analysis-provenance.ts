export const DESKTOP_ANALYSIS_ENGINE = "arena-js-dsp";
export const DESKTOP_ANALYSIS_ENGINE_VERSION = "1.2.0";

export function isCurrentDesktopAnalysis(analysis: {
  analysisEngine: string | null;
  analysisEngineVersion: string | null;
}): boolean {
  return analysis.analysisEngine === DESKTOP_ANALYSIS_ENGINE
    && analysis.analysisEngineVersion === DESKTOP_ANALYSIS_ENGINE_VERSION;
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
