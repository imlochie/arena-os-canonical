import { normaliseSourceEvents, type SourceEvent } from "./musical-events";

export const LOCAL_BASS_ANALYSIS_ENGINE = "arena-js-dsp-bass-lowband";
export const LOCAL_BASS_ANALYSIS_ENGINE_VERSION = "1.0.0";

export type BassAnalysisJobPayload = {
  bassAnalysisId: string;
  projectId: string;
  sourceAssetId: string;
  stemAssetId: string;
  analysisEngine: string;
  analysisEngineVersion: string;
};

export type BassEvent = Omit<SourceEvent, "rhythmicClass"> & {
  nearestBeatIndex: number | null;
  beatOffsetMs: number | null;
};

export function bassAnalysisIdempotencyKey(
  stemAssetId: string,
  engine = LOCAL_BASS_ANALYSIS_ENGINE,
  version = LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
) {
  return `bass-attacks:${stemAssetId}:${engine}:${version}`;
}

export function normaliseBassEvents(input: unknown, durationMs: number): Omit<BassEvent, "nearestBeatIndex" | "beatOffsetMs">[] | null {
  if (!Array.isArray(input)) return null;
  return normaliseSourceEvents(input.map((event) => {
    if (!event || typeof event !== "object") return event;
    const { rhythmicClass: _ignored, ...bassEvent } = event as Record<string, unknown>;
    return bassEvent;
  }), durationMs)?.map(({ timestampMs, strength, confidence }) => ({ timestampMs, strength, confidence })) ?? null;
}

export function bassAnalysisProvenanceReason(input: {
  sourceAssetId: string;
  expectedSourceAssetId: string;
  stemAssetId: string;
  expectedStemAssetId: string;
  sourceChecksumSha256: string;
  expectedSourceChecksumSha256: string;
  stemChecksumSha256: string;
  expectedStemChecksumSha256: string;
  analysisEngine: string;
  analysisEngineVersion: string;
}, expected = { engine: LOCAL_BASS_ANALYSIS_ENGINE, version: LOCAL_BASS_ANALYSIS_ENGINE_VERSION }) {
  if (input.sourceAssetId !== input.expectedSourceAssetId || input.stemAssetId !== input.expectedStemAssetId) return "source_stem_mismatch" as const;
  if (input.sourceChecksumSha256 !== input.expectedSourceChecksumSha256 || input.stemChecksumSha256 !== input.expectedStemChecksumSha256) return "analysis_stale" as const;
  if (input.analysisEngine !== expected.engine || input.analysisEngineVersion !== expected.version) return "analysis_version_mismatch" as const;
  return null;
}
