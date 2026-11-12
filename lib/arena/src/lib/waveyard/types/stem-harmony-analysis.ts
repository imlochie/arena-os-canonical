import { normaliseHarmonyEvents, type HarmonyEvent } from "./harmony-analysis";

export const LOCAL_STEM_HARMONY_ANALYSIS_ENGINE = "arena-js-stem-harmony";
export const LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION = "1.0.0";

export const STEM_HARMONY_STEM_TYPES = ["instrumental", "other", "guitar", "piano"] as const;
export type StemHarmonyStemType = (typeof STEM_HARMONY_STEM_TYPES)[number];

export type StemHarmonyAnalysisJobPayload = {
  stemHarmonyAnalysisId: string;
  projectId: string;
  sourceAssetId: string;
  stemAssetId: string;
  analysisEngine: string;
  analysisEngineVersion: string;
};

export function stemHarmonyAnalysisIdempotencyKey(
  stemAssetId: string,
  engine = LOCAL_STEM_HARMONY_ANALYSIS_ENGINE,
  version = LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION,
) {
  return `stem-harmony:${stemAssetId}:${engine}:${version}`;
}

export function stemHarmonyAnalysisProvenanceReason(input: {
  sourceAssetId: string;
  expectedSourceAssetId: string;
  stemAssetId: string;
  expectedStemAssetId: string;
  stemType: string;
  sourceChecksumSha256: string;
  expectedSourceChecksumSha256: string;
  stemChecksumSha256: string;
  expectedStemChecksumSha256: string;
  analysisEngine: string;
  analysisEngineVersion: string;
}) {
  if (input.sourceAssetId !== input.expectedSourceAssetId || input.stemAssetId !== input.expectedStemAssetId) {
    return "source_stem_mismatch" as const;
  }
  if (!STEM_HARMONY_STEM_TYPES.includes(input.stemType as StemHarmonyStemType)) {
    return "stem_type_mismatch" as const;
  }
  if (input.sourceChecksumSha256 !== input.expectedSourceChecksumSha256
    || input.stemChecksumSha256 !== input.expectedStemChecksumSha256) {
    return "analysis_stale" as const;
  }
  if (input.analysisEngine !== LOCAL_STEM_HARMONY_ANALYSIS_ENGINE
    || input.analysisEngineVersion !== LOCAL_STEM_HARMONY_ANALYSIS_ENGINE_VERSION) {
    return "analysis_version_mismatch" as const;
  }
  return null;
}

export function normaliseStemHarmonyEvents(input: unknown, durationMs: number): HarmonyEvent[] | null {
  return normaliseHarmonyEvents(input, durationMs);
}
