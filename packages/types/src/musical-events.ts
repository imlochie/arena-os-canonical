export const SOURCE_EVENT_ANALYSIS_ENGINE = "waveyard-numpy-onsets";
export const SOURCE_EVENT_ANALYSIS_ENGINE_VERSION = "1.0.0";

export type SourceEvent = {
  timestampMs: number;
  strength: number;
};

/**
 * Source-relative event sanitation shared by worker persistence and consumers.
 * Near duplicates use strongest evidence, breaking equal-strength ties by time.
 */
export function eventAnalysisProvenanceReason(input: {
  sourceAssetId: string;
  expectedSourceAssetId: string;
  sourceChecksumSha256: string;
  expectedSourceChecksumSha256: string;
  analysisEngine: string;
  analysisEngineVersion: string;
}) {
  if (input.sourceAssetId !== input.expectedSourceAssetId) return "source_identity_mismatch" as const;
  if (input.sourceChecksumSha256 !== input.expectedSourceChecksumSha256) return "source_checksum_mismatch" as const;
  if (input.analysisEngine !== SOURCE_EVENT_ANALYSIS_ENGINE || input.analysisEngineVersion !== SOURCE_EVENT_ANALYSIS_ENGINE_VERSION)
    return "analysis_version_mismatch" as const;
  return null;
}

export function normaliseSourceEvents(
  input: unknown,
  durationMs: number,
  nearDuplicateMs = 24,
): SourceEvent[] | null {
  if (!Array.isArray(input) || input.length > 100_000 || !Number.isFinite(durationMs) || durationMs < 0
    || !Number.isSafeInteger(nearDuplicateMs) || nearDuplicateMs < 0) return null;
  const raw: SourceEvent[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") return null;
    const event = item as Partial<SourceEvent>;
    const timestampMs = event.timestampMs;
    const strength = event.strength;
    if (typeof timestampMs !== "number" || typeof strength !== "number"
      || !Number.isSafeInteger(timestampMs) || !Number.isFinite(strength)
      || timestampMs < 0 || timestampMs > durationMs || strength < 0 || strength > 1)
      return null;
    raw.push({ timestampMs, strength: Number(strength.toFixed(6)) });
  }
  raw.sort((left, right) => left.timestampMs - right.timestampMs || right.strength - left.strength);
  const events: SourceEvent[] = [];
  for (const event of raw) {
    const previous = events.at(-1);
    if (!previous || event.timestampMs - previous.timestampMs > nearDuplicateMs) {
      events.push(event);
      continue;
    }
    if (event.strength > previous.strength)
      events[events.length - 1] = event;
  }
  return events;
}
