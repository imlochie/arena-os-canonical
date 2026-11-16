import { normaliseSourceEvents, type SourceEvent } from "./musical-events";

export const LOCAL_BASS_ANALYSIS_ENGINE = "arena-js-dsp-bass-lowband";
/**
 * 2.0.0 adds independent pitch tracking to the same analysis.
 *
 * The version is bumped deliberately. Rows written by 1.0.0 contain attacks with
 * no pitch, so they are genuinely stale with respect to what this engine now
 * claims to measure and must be reanalysed rather than read as pitch evidence.
 */
export const LOCAL_BASS_ANALYSIS_ENGINE_VERSION = "2.0.0";

/**
 * Pitch range for isolated bass stems. A four-string bass in standard tuning
 * bottoms out at E1 (41.2 Hz); a five-string low B is 30.9 Hz. The top is set
 * well above any ordinary bass fundamental so thumb-and-harmonic playing and
 * upper-register fills are not silently discarded.
 */
export const BASS_PITCH_MIN_HZ = 30;
export const BASS_PITCH_MAX_HZ = 400;
/** Decimation used for the bass pass: Nyquist ~5.5 kHz still clears the range. */
export const BASS_PITCH_DECIMATION = 2;
/**
 * A tracked pitch segment is only persisted when the tracker was confident.
 * Below this the frame is a guess, and a guess must stay a gap.
 */
export const BASS_PITCH_MIN_CONFIDENCE = 0.6;
/** Shortest segment that counts as a held note rather than an attack transient. */
export const BASS_PITCH_MIN_SEGMENT_MS = 80;

export type BassPitchSegment = {
  startMs: number;
  endMs: number;
  midiNote: number;
  frequencyHz: number;
  confidence: number;
};

/**
 * Validate pitch segments coming back from the worker or the database.
 *
 * Returns null for a malformed payload so callers can report unavailable rather
 * than persisting or judging junk. Out-of-order or overlapping segments are
 * rejected: the bass is monophonic, so its held notes cannot overlap.
 */
export function normaliseBassPitchSegments(input: unknown, durationMs: number): BassPitchSegment[] | null {
  if (!Array.isArray(input)) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const segments: BassPitchSegment[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const startMs = value.startMs;
    const endMs = value.endMs;
    const midiNote = value.midiNote;
    const frequencyHz = value.frequencyHz;
    const confidence = value.confidence;
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) return null;
    if (!Number.isInteger(midiNote) || !Number.isFinite(frequencyHz)) return null;
    if (!Number.isFinite(confidence)) return null;
    if ((startMs as number) < 0 || (endMs as number) <= (startMs as number)) return null;
    if ((endMs as number) > Math.round(durationMs) + 1) return null;
    if ((midiNote as number) < 12 || (midiNote as number) > 84) return null;
    if ((frequencyHz as number) < BASS_PITCH_MIN_HZ || (frequencyHz as number) > BASS_PITCH_MAX_HZ) return null;
    if ((confidence as number) <= 0 || (confidence as number) > 1) return null;
    const previous = segments[segments.length - 1];
    if (previous && (startMs as number) < previous.startMs) return null;
    segments.push({
      startMs: startMs as number,
      endMs: endMs as number,
      midiNote: midiNote as number,
      frequencyHz: frequencyHz as number,
      confidence: confidence as number,
    });
  }
  return segments;
}

/**
 * Frequency for a MIDI note, so persisted Hz can be checked against its label
 * instead of being trusted because it is a number.
 */
export function midiToFrequencyHz(midiNote: number): number {
  return 440 * 2 ** ((midiNote - 69) / 12);
}

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
