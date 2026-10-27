export const SOURCE_EVENT_ANALYSIS_ENGINE = "waveyard-numpy-onsets";
export const SOURCE_EVENT_ANALYSIS_ENGINE_VERSION = "1.0.0";

export const RHYTHMIC_CLASSES = ["kick", "snare", "hat", "other"] as const;
export type RhythmicClass = (typeof RHYTHMIC_CLASSES)[number];

/** Shared source-relative event evidence. Generic source events deliberately
 * retain a null class; isolated drum analysis may add only conservative classes. */
export type SourceEvent = {
  timestampMs: number;
  strength: number;
  confidence: number;
  rhythmicClass: RhythmicClass | null;
};

export type BeatProjection = { nearestBeatIndex: number; beatOffsetMs: number };

function normaliseConfidence(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? Number(value.toFixed(6))
    : null;
}

function normaliseRhythmicClass(value: unknown): RhythmicClass | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && (RHYTHMIC_CLASSES as readonly string[]).includes(value)
    ? value as RhythmicClass
    : undefined;
}

/** Derive display metadata from the existing source grid; never persists a second grid. */
export function nearestBeatProjection(timestampMs: number, beatGridMs: readonly number[] | null | undefined): BeatProjection | null {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || !Array.isArray(beatGridMs) || !beatGridMs.length) return null;
  let closestIndex = 0;
  for (let index = 1; index < beatGridMs.length; index += 1) {
    if (Math.abs(beatGridMs[index] - timestampMs) < Math.abs(beatGridMs[closestIndex] - timestampMs)) closestIndex = index;
  }
  const nearest = beatGridMs[closestIndex];
  return Number.isSafeInteger(nearest) ? { nearestBeatIndex: closestIndex, beatOffsetMs: timestampMs - nearest } : null;
}

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
    const confidence = event.confidence === undefined ? strength : event.confidence;
    const rhythmicClass = normaliseRhythmicClass(event.rhythmicClass);
    if (typeof timestampMs !== "number" || typeof strength !== "number"
      || !Number.isSafeInteger(timestampMs) || !Number.isFinite(strength)
      || timestampMs < 0 || timestampMs > durationMs || strength < 0 || strength > 1
      || normaliseConfidence(confidence) === null || rhythmicClass === undefined)
      return null;
    raw.push({ timestampMs, strength: Number(strength.toFixed(6)), confidence: normaliseConfidence(confidence)!, rhythmicClass });
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
