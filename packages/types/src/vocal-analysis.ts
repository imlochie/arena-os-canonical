export const VOCAL_ANALYSIS_ENGINE = "waveyard-numpy-monophonic-pitch";
export const VOCAL_ANALYSIS_ENGINE_VERSION = "1.0.0";

export type VocalPitchFrame = {
  timestampMs: number;
  frequencyHz: number | null;
  midiFloat: number | null;
  nearestMidiNote: number | null;
  confidence: number;
  voiced: boolean;
};

export type VocalPhrase = { startMs: number; endMs: number; confidence: number };

export function frequencyToMidi(frequencyHz: number) {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) return null;
  return 69 + 12 * Math.log2(frequencyHz / 440);
}

export function normaliseVocalPitchFrames(input: unknown, durationMs: number): VocalPitchFrame[] | null {
  if (!Array.isArray(input) || input.length > 500_000 || !Number.isFinite(durationMs) || durationMs < 0) return null;
  const frames: VocalPitchFrame[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const frame = raw as Partial<VocalPitchFrame>;
    const timestampMs = frame.timestampMs;
    const confidence = frame.confidence;
    if (typeof timestampMs !== "number" || !Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > durationMs
      || typeof frame.voiced !== "boolean" || typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
      return null;
    if (!frame.voiced) {
      if (frame.frequencyHz !== null || frame.midiFloat !== null || frame.nearestMidiNote !== null) return null;
      frames.push({ timestampMs, frequencyHz: null, midiFloat: null, nearestMidiNote: null, confidence: Number(confidence.toFixed(6)), voiced: false });
      continue;
    }
    const frequencyHz = frame.frequencyHz;
    const engineMidiFloat = frame.midiFloat;
    const nearestMidiNote = frame.nearestMidiNote;
    if (typeof frequencyHz !== "number" || !Number.isFinite(frequencyHz) || frequencyHz < 50 || frequencyHz > 1_200
      || typeof engineMidiFloat !== "number" || !Number.isFinite(engineMidiFloat) || typeof nearestMidiNote !== "number" || !Number.isInteger(nearestMidiNote) || nearestMidiNote < 20 || nearestMidiNote > 120)
      return null;
    const midiFloat = frequencyToMidi(frequencyHz);
    if (midiFloat === null || Math.abs(midiFloat - engineMidiFloat) > 0.05 || Math.abs(Math.round(midiFloat) - nearestMidiNote) > 0)
      return null;
    frames.push({
      timestampMs,
      frequencyHz: Number(frequencyHz.toFixed(6)),
      midiFloat: Number(engineMidiFloat.toFixed(6)),
      nearestMidiNote,
      confidence: Number(confidence.toFixed(6)),
      voiced: true,
    });
  }
  if (frames.some((frame, index) => index > 0 && frame.timestampMs <= frames[index - 1].timestampMs)) return null;
  return frames;
}

/** Coarse phrase continuity with explicit silence-gap threshold, not linguistic segmentation. */
export function segmentVocalPhrases(frames: VocalPitchFrame[], silenceGapMs = 260): VocalPhrase[] {
  if (!Number.isFinite(silenceGapMs) || silenceGapMs < 0) return [];
  const phrases: VocalPhrase[] = [];
  let start: VocalPitchFrame | null = null;
  let previous: VocalPitchFrame | null = null;
  let confidenceTotal = 0;
  let count = 0;
  const finish = () => {
    if (!start || !previous) return;
    phrases.push({ startMs: start.timestampMs, endMs: previous.timestampMs, confidence: Number((confidenceTotal / Math.max(1, count)).toFixed(6)) });
    start = null; previous = null; confidenceTotal = 0; count = 0;
  };
  for (const frame of frames) {
    if (!frame.voiced) continue;
    if (previous && frame.timestampMs - previous.timestampMs > silenceGapMs) finish();
    if (!start) start = frame;
    previous = frame;
    confidenceTotal += frame.confidence;
    count += 1;
  }
  finish();
  return phrases;
}

export function vocalAnalysisProvenanceReason(input: {
  sourceAssetId: string; expectedSourceAssetId: string;
  stemAssetId: string; expectedStemAssetId: string;
  sourceChecksumSha256: string; expectedSourceChecksumSha256: string;
  stemChecksumSha256: string; expectedStemChecksumSha256: string;
  analysisEngine: string; analysisEngineVersion: string;
}) {
  if (input.sourceAssetId !== input.expectedSourceAssetId || input.stemAssetId !== input.expectedStemAssetId) return "source_stem_mismatch" as const;
  if (input.sourceChecksumSha256 !== input.expectedSourceChecksumSha256 || input.stemChecksumSha256 !== input.expectedStemChecksumSha256) return "analysis_stale" as const;
  if (input.analysisEngine !== VOCAL_ANALYSIS_ENGINE || input.analysisEngineVersion !== VOCAL_ANALYSIS_ENGINE_VERSION) return "analysis_version_mismatch" as const;
  return null;
}
