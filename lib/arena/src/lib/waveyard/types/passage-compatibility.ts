export const PASSAGE_FINGERPRINT_ENGINE = "waveyard-passage-fingerprint";
export const PASSAGE_FINGERPRINT_ENGINE_VERSION = "1.0.0";
export const PASSAGE_MATCH_SIMILARITY_THRESHOLD = 0.92;

export type PassageEvidence<T> =
  | { status: "measured"; value: T; method: string; confidence: number | null }
  | { status: "unavailable"; reason: string };

export type PassageFingerprint = {
  schemaVersion: 1;
  engine: typeof PASSAGE_FINGERPRINT_ENGINE;
  engineVersion: typeof PASSAGE_FINGERPRINT_ENGINE_VERSION;
  sourceChecksumSha256: string;
  startBeatIndex: number;
  endBeatIndex: number;
  rhythm: PassageEvidence<number[]>;
  chroma: PassageEvidence<number[]>;
  beatPhase: PassageEvidence<{ subdivisionProfile: number[]; beatPeriodMs: number }>;
  energy: PassageEvidence<{ rmsDb: number }>;
  downbeatConfidence: PassageEvidence<number>;
  vocalActivity: PassageEvidence<{ voicedCoverage: number; meanConfidence: number; analysisId: string; stemAssetId: string; stemChecksumSha256: string }>;
  instrumentalDensity: PassageEvidence<{ activeCoverage: number; stemTypes: string[]; analysisIds: string[] }>;
};

export type PassageCompatibilityDimension = {
  status: "match" | "conflict" | "unavailable" | "context";
  similarity: number | null;
  detail: string;
};

export type PassageCompatibility = {
  anchorSectionId: string;
  donorSectionId: string;
  beatCount: number;
  barCount: number;
  tempoRatio: number;
  transpositionSemitones: number | null;
  eligible: boolean;
  dimensions: {
    tempo: PassageCompatibilityDimension;
    phraseAlignment: PassageCompatibilityDimension;
    rhythm: PassageCompatibilityDimension;
    harmony: PassageCompatibilityDimension;
    beatPhase: PassageCompatibilityDimension;
    energy: PassageCompatibilityDimension;
    vocalActivity: PassageCompatibilityDimension;
    instrumentalDensity: PassageCompatibilityDimension;
    downbeatConfidence: PassageCompatibilityDimension;
  };
  missingEvidence: string[];
};

export type AutomaticRemixCompatibilityPair = PassageCompatibility & {
  anchorSourceName: string;
  donorSourceName: string;
};

export function parsePassageFingerprint(
  input: unknown,
  expected?: { sourceChecksumSha256?: string; startBeatIndex?: number; endBeatIndex?: number },
): PassageFingerprint | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.engine !== PASSAGE_FINGERPRINT_ENGINE
    || value.engineVersion !== PASSAGE_FINGERPRINT_ENGINE_VERSION
    || typeof value.sourceChecksumSha256 !== "string"
    || !Number.isInteger(value.startBeatIndex) || !Number.isInteger(value.endBeatIndex)
    || (value.endBeatIndex as number) <= (value.startBeatIndex as number)) return null;
  if (expected?.sourceChecksumSha256 && value.sourceChecksumSha256 !== expected.sourceChecksumSha256) return null;
  if (expected?.startBeatIndex !== undefined && value.startBeatIndex !== expected.startBeatIndex) return null;
  if (expected?.endBeatIndex !== undefined && value.endBeatIndex !== expected.endBeatIndex) return null;
  const parseEvidence = <T>(raw: unknown, parseValue: (rawValue: unknown) => T | null): PassageEvidence<T> | null => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const evidence = raw as Record<string, unknown>;
    if (evidence.status === "unavailable" && typeof evidence.reason === "string" && evidence.reason.length <= 300)
      return { status: "unavailable", reason: evidence.reason };
    if (evidence.status !== "measured" || typeof evidence.method !== "string" || evidence.method.length > 120
      || !(evidence.confidence === null || (typeof evidence.confidence === "number" && Number.isFinite(evidence.confidence) && evidence.confidence >= 0 && evidence.confidence <= 1))) return null;
    const parsed = parseValue(evidence.value);
    return parsed === null ? null : { status: "measured", value: parsed, method: evidence.method, confidence: evidence.confidence as number | null };
  };
  const numericArray = (raw: unknown, minLength: number, maxLength: number) =>
    Array.isArray(raw) && raw.length >= minLength && raw.length <= maxLength
      && raw.every((item) => typeof item === "number" && Number.isFinite(item))
      ? raw as number[] : null;
  const rhythm = parseEvidence(value.rhythm, (raw) => numericArray(raw, 32, 4096));
  const chroma = parseEvidence(value.chroma, (raw) => numericArray(raw, 48, 48));
  const beatPhase = parseEvidence(value.beatPhase, (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const profile = numericArray(item.subdivisionProfile, 4, 4);
    return profile && typeof item.beatPeriodMs === "number" && Number.isFinite(item.beatPeriodMs) && item.beatPeriodMs > 0
      ? { subdivisionProfile: profile, beatPeriodMs: item.beatPeriodMs } : null;
  });
  const energy = parseEvidence(value.energy, (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const rmsDb = (raw as Record<string, unknown>).rmsDb;
    return typeof rmsDb === "number" && Number.isFinite(rmsDb) && rmsDb >= -160 && rmsDb <= 6 ? { rmsDb } : null;
  });
  const scalar = (raw: unknown) => typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null;
  const vocalActivity = parseEvidence(value.vocalActivity, (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    return scalar(item.voicedCoverage) !== null && scalar(item.meanConfidence) !== null
      && typeof item.analysisId === "string" && typeof item.stemAssetId === "string" && typeof item.stemChecksumSha256 === "string"
      ? { voicedCoverage: item.voicedCoverage as number, meanConfidence: item.meanConfidence as number, analysisId: item.analysisId, stemAssetId: item.stemAssetId, stemChecksumSha256: item.stemChecksumSha256 }
      : null;
  });
  const instrumentalDensity = parseEvidence(value.instrumentalDensity, (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    return scalar(item.activeCoverage) !== null && Array.isArray(item.stemTypes) && item.stemTypes.every((entry) => typeof entry === "string")
      && Array.isArray(item.analysisIds) && item.analysisIds.every((entry) => typeof entry === "string")
      ? { activeCoverage: item.activeCoverage as number, stemTypes: item.stemTypes as string[], analysisIds: item.analysisIds as string[] }
      : null;
  });
  const downbeatConfidence = parseEvidence(value.downbeatConfidence, scalar);
  if (!rhythm || !chroma || !beatPhase || !energy || !vocalActivity || !instrumentalDensity || !downbeatConfidence) return null;
  return {
    schemaVersion: 1,
    engine: PASSAGE_FINGERPRINT_ENGINE,
    engineVersion: PASSAGE_FINGERPRINT_ENGINE_VERSION,
    sourceChecksumSha256: value.sourceChecksumSha256,
    startBeatIndex: value.startBeatIndex as number,
    endBeatIndex: value.endBeatIndex as number,
    rhythm, chroma, beatPhase, energy, downbeatConfidence, vocalActivity, instrumentalDensity,
  };
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || !left.length) return null;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (leftMagnitude < 1e-12 || rightMagnitude < 1e-12) return null;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude)));
}

function shiftedChroma(left: readonly number[], right: readonly number[], semitones: number): number | null {
  if (left.length !== 48 || right.length !== 48) return null;
  const shifted = Array.from({ length: 48 }, (_, index) => {
    const bin = Math.floor(index / 12);
    const pitch = index % 12;
    return right[bin * 12 + ((pitch - semitones + 12) % 12)]!;
  });
  return cosineSimilarity(left, shifted);
}

function dimension(
  status: PassageCompatibilityDimension["status"],
  similarity: number | null,
  detail: string,
): PassageCompatibilityDimension {
  return { status, similarity: similarity === null ? null : Number(similarity.toFixed(4)), detail };
}

/**
 * Compares independently measured passage features. A rhythm match never
 * substitutes for chroma, beat-phase, or provenance evidence.
 */
export function comparePassageCompatibility(input: {
  anchorSectionId: string;
  donorSectionId: string;
  anchor: PassageFingerprint;
  donor: PassageFingerprint;
  anchorBpm: number;
  donorBpm: number;
  anchorBeatConfidence: number;
  donorBeatConfidence: number;
  anchorKeyTrusted: boolean;
  donorKeyTrusted: boolean;
  expectedKeyShift?: number | null;
}): PassageCompatibility {
  const anchorBeats = input.anchor.endBeatIndex - input.anchor.startBeatIndex;
  const donorBeats = input.donor.endBeatIndex - input.donor.startBeatIndex;
  const beatCount = Math.min(anchorBeats, donorBeats);
  const tempoRatio = Number.isFinite(input.donorBpm) && input.donorBpm > 0 && Number.isFinite(input.anchorBpm)
    ? input.anchorBpm / input.donorBpm : 0;
  const bpmEvidenceAvailable = Number.isFinite(input.anchorBpm) && input.anchorBpm > 0
    && Number.isFinite(input.donorBpm) && input.donorBpm > 0
    && input.anchorBeatConfidence >= 0.5 && input.donorBeatConfidence >= 0.5;
  const tempo = !bpmEvidenceAvailable
    ? dimension("unavailable", null, "Trusted BPM and beat-confidence evidence is required for both tracks.")
    : dimension(tempoRatio >= 0.92 && tempoRatio <= 1.08 ? "match" : "conflict", null,
      `Tempo ratio ${tempoRatio.toFixed(3)} (${input.anchorBpm.toFixed(1)} / ${input.donorBpm.toFixed(1)} BPM); allowed range 0.92–1.08.`);
  const phraseAlignment = anchorBeats === donorBeats && anchorBeats >= 8 && anchorBeats % 4 === 0
    ? dimension("match", null, `${anchorBeats} measured beats (${anchorBeats / 4} bars) in each passage; no semantic role is inferred.`)
    : dimension("conflict", null, `Passage lengths are ${anchorBeats} and ${donorBeats} beats; exact 2+ bar phrase lengths must match.`);
  const rhythmScore = input.anchor.rhythm.status === "measured" && input.donor.rhythm.status === "measured"
    ? cosineSimilarity(input.anchor.rhythm.value, input.donor.rhythm.value) : null;
  const rhythm = rhythmScore === null
    ? dimension("unavailable", null, "One or both passages have no usable rhythm fingerprint.")
    : dimension(rhythmScore >= PASSAGE_MATCH_SIMILARITY_THRESHOLD ? "match" : "conflict", rhythmScore,
      `Onset-pattern cosine ${rhythmScore.toFixed(3)}; required ≥ ${PASSAGE_MATCH_SIMILARITY_THRESHOLD.toFixed(2)}.`);

  let bestShift = 0;
  let bestHarmony = -2;
  if (input.anchor.chroma.status === "measured" && input.donor.chroma.status === "measured") {
    for (let shift = -2; shift <= 2; shift += 1) {
      const score = shiftedChroma(input.anchor.chroma.value, input.donor.chroma.value, shift);
      if (score !== null && score > bestHarmony) { bestHarmony = score; bestShift = shift; }
    }
  }
  const harmonyShiftAllowed = bestShift === 0 || (input.anchorKeyTrusted && input.donorKeyTrusted && bestShift === input.expectedKeyShift);
  const transpositionExplanation = input.anchorKeyTrusted && input.donorKeyTrusted
    ? `trusted key estimates ${harmonyShiftAllowed ? "authorize" : "do not authorize"} that shift`
    : "transposition is not authorized because one or both key estimates are untrusted";
  const harmony = bestHarmony < -1
    ? dimension("unavailable", null, "One or both passages have no usable chroma fingerprint.")
    : dimension(bestHarmony >= PASSAGE_MATCH_SIMILARITY_THRESHOLD && harmonyShiftAllowed ? "match" : "conflict", bestHarmony,
      bestHarmony < PASSAGE_MATCH_SIMILARITY_THRESHOLD
        ? `Best pitch-class similarity ${bestHarmony.toFixed(3)}; required ≥ ${PASSAGE_MATCH_SIMILARITY_THRESHOLD.toFixed(2)}.`
        : bestShift === 0
          ? `Pitch-class sequence matches without transposition (${bestHarmony.toFixed(3)}).`
          : `Best match needs ${bestShift > 0 ? "+" : ""}${bestShift} semitones; ${transpositionExplanation}.`);

  const phaseScore = input.anchor.beatPhase.status === "measured" && input.donor.beatPhase.status === "measured"
    ? cosineSimilarity(input.anchor.beatPhase.value.subdivisionProfile, input.donor.beatPhase.value.subdivisionProfile) : null;
  const phase = phaseScore === null
    ? dimension("unavailable", null, "Sub-beat onset phase is missing from one or both passages.")
    : dimension(phaseScore >= PASSAGE_MATCH_SIMILARITY_THRESHOLD ? "match" : "conflict", phaseScore,
      `Sub-beat accent profile similarity ${phaseScore.toFixed(3)}; phase is not rotated to force a match.`);
  const energyDeltaDb = input.anchor.energy.status === "measured" && input.donor.energy.status === "measured"
    ? Math.abs(input.anchor.energy.value.rmsDb - input.donor.energy.value.rmsDb) : null;
  const energy = energyDeltaDb === null
    ? dimension("unavailable", null, "RMS energy is missing from one or both passages.")
    : dimension("context", null, `Source-level RMS differs by ${energyDeltaDb.toFixed(1)} dB; this is context, not a match gate.`);

  const vocal = input.donor.vocalActivity.status === "measured"
    ? dimension("context", input.donor.vocalActivity.value.voicedCoverage,
      `Verified isolated-vocal pitch frames cover ${(input.donor.vocalActivity.value.voicedCoverage * 100).toFixed(0)}% of the donor passage; coverage is shown without an unvalidated suitability threshold.`)
    : dimension("unavailable", null, input.donor.vocalActivity.reason);
  const instruments = input.anchor.instrumentalDensity.status === "measured"
    ? dimension("context", input.anchor.instrumentalDensity.value.activeCoverage,
      `Verified non-vocal stem activity covers ${(input.anchor.instrumentalDensity.value.activeCoverage * 100).toFixed(0)}% of the anchor passage; coverage is shown without an unvalidated suitability threshold.`)
    : dimension("unavailable", null, input.anchor.instrumentalDensity.reason);
  const downbeat = input.anchor.downbeatConfidence.status === "measured" && input.donor.downbeatConfidence.status === "measured"
    ? dimension("context", Math.min(input.anchor.downbeatConfidence.value, input.donor.downbeatConfidence.value), "Downbeat confidence is available but is not used to invent a semantic section role.")
    : dimension("unavailable", null, "The stored beat grids do not carry a separately measured downbeat.")
  ;

  const missingEvidence = [
    ...(tempo.status === "unavailable" ? ["trusted tempo and beat confidence"] : []),
    ...(vocal.status === "unavailable" ? ["donor vocal activity"] : []),
    ...(instruments.status === "unavailable" ? ["anchor non-vocal stem activity"] : []),
    ...(downbeat.status === "unavailable" ? ["downbeat confidence"] : []),
  ];
  const eligible = tempo.status === "match" && phraseAlignment.status === "match"
    && rhythm.status === "match" && harmony.status === "match" && phase.status === "match";
  return {
    anchorSectionId: input.anchorSectionId,
    donorSectionId: input.donorSectionId,
    beatCount,
    barCount: Math.floor(beatCount / 4),
    tempoRatio: Number(tempoRatio.toFixed(4)),
    transpositionSemitones: bestHarmony < -1 ? null : bestShift,
    eligible,
    dimensions: { tempo, phraseAlignment, rhythm, harmony, beatPhase: phase, energy, vocalActivity: vocal, instrumentalDensity: instruments, downbeatConfidence: downbeat },
    missingEvidence,
  };
}

export function unavailablePassageEvidence(reason: string): PassageEvidence<never> {
  return { status: "unavailable", reason };
}
