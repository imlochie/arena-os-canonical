export const DESKTOP_ANALYSIS_ENGINE = "arena-js-dsp";
export const DESKTOP_ANALYSIS_ENGINE_VERSION = "1.1.0";

export function currentKeyConfidence(analysis: {
  analysisEngine: string | null;
  analysisEngineVersion: string | null;
  keyConfidence: number | null;
}): number | null {
  if (
    analysis.analysisEngine !== DESKTOP_ANALYSIS_ENGINE
    || analysis.analysisEngineVersion !== DESKTOP_ANALYSIS_ENGINE_VERSION
  ) return null;
  return analysis.keyConfidence;
}
