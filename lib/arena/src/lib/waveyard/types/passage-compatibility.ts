export const PASSAGE_FINGERPRINT_ENGINE = "waveyard-passage-fingerprint";
export const PASSAGE_FINGERPRINT_ENGINE_VERSION = "2.1.0";
export const PASSAGE_MATCH_SIMILARITY_THRESHOLD = 0.92;
export const MINIMUM_PERSISTENT_STEM_CHANGE_DB = 6;

export type PassageVocalRun = { startMs: number; endMs: number; confidence: number };

export type PassageStemActivity = {
  stemType: string;
  stemAssetId: string;
  separationJobId: string;
  stemChecksumSha256: string;
  sectionRmsDb: number;
  boundaryChanges: { beatIndex: number; deltaDb: number }[];
};

/** Local measured signatures used to compare phrase-sized windows inside longer passages. */
export type PassageRollingWindow = {
  startBeatIndex: number;
  endBeatIndex: number;
  rhythm: PassageEvidence<number[]>;
  chroma: PassageEvidence<number[]>;
  beatPhase: PassageEvidence<{ subdivisionProfile: number[]; beatPeriodMs: number }>;
};

export type PassageEvidence<T> =
  | { status: "measured"; value: T; method: string; confidence: number | null }
  | { status: "unavailable"; reason: string };

export type PassageFingerprint = {
  schemaVersion: 2;
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
  vocalActivity: PassageEvidence<{
    voicedCoverage: number;
    meanConfidence: number;
    analysisId: string;
    stemAssetId: string;
    stemChecksumSha256: string;
    pitchContinuityRuns: PassageVocalRun[];
  }>;
  instrumentalDensity: PassageEvidence<{ activeCoverage: number; stemTypes: string[]; analysisIds: string[] }>;
  /** Per-stem PCM evidence; this is structural context, not semantic form. */
  stemActivity: PassageEvidence<PassageStemActivity[]>;
  /** Optional for older persisted fingerprints; current analyses store local rolling windows. */
  rollingWindows?: PassageEvidence<PassageRollingWindow[]>;
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
    stemActivity: PassageCompatibilityDimension;
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
  if (value.schemaVersion !== 2 || value.engine !== PASSAGE_FINGERPRINT_ENGINE
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
  const rollingWindows = value.rollingWindows === undefined
    ? undefined
    : parseEvidence(value.rollingWindows, (raw) => {
      if (!Array.isArray(raw) || raw.length > 256) return null;
      const windows: PassageRollingWindow[] = [];
      let previousStart = -1;
      for (const entry of raw) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const item = entry as Record<string, unknown>;
        if (!Number.isInteger(item.startBeatIndex) || !Number.isInteger(item.endBeatIndex)
          || (item.startBeatIndex as number) < (value.startBeatIndex as number)
          || (item.endBeatIndex as number) > (value.endBeatIndex as number)
          || (item.startBeatIndex as number) < previousStart
          || (item.endBeatIndex as number) - (item.startBeatIndex as number) < 8
          || ((item.endBeatIndex as number) - (item.startBeatIndex as number)) % 4 !== 0) return null;
        const beats = (item.endBeatIndex as number) - (item.startBeatIndex as number);
        const rhythm = parseEvidence(item.rhythm, (vector) =>
          Array.isArray(vector) && vector.length === beats * 4 && vector.length <= 128
            && vector.every((sample) => typeof sample === "number" && Number.isFinite(sample))
            ? vector as number[] : null);
        const chroma = parseEvidence(item.chroma, (vector) => numericArray(vector, 48, 48));
        const phase = parseEvidence(item.beatPhase, (vector) => {
          if (!vector || typeof vector !== "object" || Array.isArray(vector)) return null;
          const phaseValue = vector as Record<string, unknown>;
          const profile = numericArray(phaseValue.subdivisionProfile, 4, 4);
          return profile && typeof phaseValue.beatPeriodMs === "number"
            && Number.isFinite(phaseValue.beatPeriodMs) && phaseValue.beatPeriodMs > 0
            ? { subdivisionProfile: profile, beatPeriodMs: phaseValue.beatPeriodMs }
            : null;
        });
        if (!rhythm || !chroma || !phase) return null;
        windows.push({
          startBeatIndex: item.startBeatIndex as number,
          endBeatIndex: item.endBeatIndex as number,
          rhythm,
          chroma,
          beatPhase: phase,
        });
        previousStart = item.startBeatIndex as number;
      }
      return windows;
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
    if (!Array.isArray(item.pitchContinuityRuns) || item.pitchContinuityRuns.length > 256) return null;
    const pitchContinuityRuns: PassageVocalRun[] = [];
    for (const rawRun of item.pitchContinuityRuns) {
      if (!rawRun || typeof rawRun !== "object" || Array.isArray(rawRun)) return null;
      const run = rawRun as Record<string, unknown>;
      if (!Number.isSafeInteger(run.startMs) || (run.startMs as number) < 0
        || !Number.isSafeInteger(run.endMs) || (run.endMs as number) <= (run.startMs as number)
        || (run.endMs as number) > 86_400_000
        || scalar(run.confidence) === null) return null;
      pitchContinuityRuns.push({
        startMs: run.startMs as number,
        endMs: run.endMs as number,
        confidence: run.confidence as number,
      });
    }
    if (pitchContinuityRuns.some((run, index) => index > 0 && run.startMs < pitchContinuityRuns[index - 1]!.startMs)) return null;
    return scalar(item.voicedCoverage) !== null && scalar(item.meanConfidence) !== null
      && typeof item.analysisId === "string" && typeof item.stemAssetId === "string" && typeof item.stemChecksumSha256 === "string"
      ? {
        voicedCoverage: item.voicedCoverage as number,
        meanConfidence: item.meanConfidence as number,
        analysisId: item.analysisId,
        stemAssetId: item.stemAssetId,
        stemChecksumSha256: item.stemChecksumSha256,
        pitchContinuityRuns,
      }
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
  const stemActivity = parseEvidence(value.stemActivity, (raw) => {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return null;
    const measurements: PassageStemActivity[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const item = entry as Record<string, unknown>;
      if (!Array.isArray(item.boundaryChanges) || item.boundaryChanges.length > 32) return null;
      const boundaryChanges: PassageStemActivity["boundaryChanges"] = [];
      for (const rawChange of item.boundaryChanges) {
        if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) return null;
        const change = rawChange as Record<string, unknown>;
        if (!Number.isInteger(change.beatIndex)
          || (change.beatIndex as number) < (value.startBeatIndex as number)
          || (change.beatIndex as number) >= (value.endBeatIndex as number)
          || typeof change.deltaDb !== "number" || !Number.isFinite(change.deltaDb)
          || change.deltaDb < -120 || change.deltaDb > 120) return null;
        boundaryChanges.push({ beatIndex: change.beatIndex as number, deltaDb: change.deltaDb });
      }
      if (typeof item.stemType !== "string" || item.stemType.length < 1 || item.stemType.length > 128
        || typeof item.stemAssetId !== "string" || item.stemAssetId.length < 1 || item.stemAssetId.length > 128
        || typeof item.separationJobId !== "string" || item.separationJobId.length < 1 || item.separationJobId.length > 128
        || typeof item.stemChecksumSha256 !== "string" || !/^[a-f\d]{64}$/i.test(item.stemChecksumSha256)
        || typeof item.sectionRmsDb !== "number" || !Number.isFinite(item.sectionRmsDb) || item.sectionRmsDb < -120 || item.sectionRmsDb > 6) return null;
      measurements.push({
        stemType: item.stemType,
        stemAssetId: item.stemAssetId,
        separationJobId: item.separationJobId,
        stemChecksumSha256: item.stemChecksumSha256,
        sectionRmsDb: item.sectionRmsDb,
        boundaryChanges,
      });
    }
    return measurements;
  });
  const downbeatConfidence = parseEvidence(value.downbeatConfidence, scalar);
  if (!rhythm || !chroma || !beatPhase || !energy || !vocalActivity || !instrumentalDensity || !downbeatConfidence || !stemActivity
    || (value.rollingWindows !== undefined && !rollingWindows)) return null;
  return {
    schemaVersion: 2,
    engine: PASSAGE_FINGERPRINT_ENGINE,
    engineVersion: PASSAGE_FINGERPRINT_ENGINE_VERSION,
    sourceChecksumSha256: value.sourceChecksumSha256,
    startBeatIndex: value.startBeatIndex as number,
    endBeatIndex: value.endBeatIndex as number,
    rhythm, chroma, beatPhase, energy, downbeatConfidence, vocalActivity, instrumentalDensity, stemActivity,
    ...(rollingWindows ? { rollingWindows } : {}),
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

function resampleNormalisedSequence(values: readonly number[], length: number): number[] {
  if (length <= 0 || values.length === 0) return [];
  if (values.length === 1) return Array.from({ length }, () => values[0]!);
  return Array.from({ length }, (_, index) => {
    const position = length === 1 ? 0 : (index * (values.length - 1)) / (length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(values.length - 1, lower + 1);
    const fraction = position - lower;
    return values[lower]! * (1 - fraction) + values[upper]! * fraction;
  });
}

/**
 * Rhythm vectors have four samples per beat. When two whole-bar passages have
 * different lengths, compare their time-normalised shapes for ranking while
 * retaining their actual duration mismatch as separate evidence.
 */
function normalisedRhythmSimilarity(
  left: readonly number[],
  right: readonly number[],
  leftBeats: number,
  rightBeats: number,
): number | null {
  if (leftBeats < 8 || rightBeats < 8
    || leftBeats % 4 !== 0 || rightBeats % 4 !== 0
    || left.length !== leftBeats * 4 || right.length !== rightBeats * 4) return null;
  const length = Math.max(left.length, right.length);
  return cosineSimilarity(
    resampleNormalisedSequence(left, length),
    resampleNormalisedSequence(right, length),
  );
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
  const phraseLengthSimilarity = Math.max(anchorBeats, donorBeats) > 0
    ? Math.min(anchorBeats, donorBeats) / Math.max(anchorBeats, donorBeats)
    : null;
  const tempoRatio = Number.isFinite(input.donorBpm) && input.donorBpm > 0 && Number.isFinite(input.anchorBpm)
    ? input.anchorBpm / input.donorBpm : 0;
  const bpmEvidenceAvailable = Number.isFinite(input.anchorBpm) && input.anchorBpm > 0
    && Number.isFinite(input.donorBpm) && input.donorBpm > 0
    && input.anchorBeatConfidence >= 0.5 && input.donorBeatConfidence >= 0.5;
  const tempo = !bpmEvidenceAvailable
    ? dimension("unavailable", null, "Trusted BPM and beat-confidence evidence is required for both tracks.")
    : dimension(tempoRatio >= 0.92 && tempoRatio <= 1.08 ? "match" : "conflict", null,
      `Tempo ratio ${tempoRatio.toFixed(3)} (${input.anchorBpm.toFixed(1)} / ${input.donorBpm.toFixed(1)} BPM); allowed range 0.92–1.08.`);
  const validBarWindows = anchorBeats >= 8 && donorBeats >= 8
    && anchorBeats % 4 === 0 && donorBeats % 4 === 0;
  const phraseAlignment = !validBarWindows
    ? dimension("conflict", phraseLengthSimilarity, `Passage lengths are ${anchorBeats} and ${donorBeats} beats; both need at least 2 complete bars for normalized comparison.`)
    : anchorBeats === donorBeats
      ? dimension("match", 1, `${anchorBeats} measured beats (${anchorBeats / 4} bars) in each passage; no semantic role is inferred.`)
      : dimension("context", phraseLengthSimilarity,
        `Passage lengths differ (${anchorBeats} vs ${donorBeats} beats; ${phraseLengthSimilarity?.toFixed(3)} duration similarity). Rhythm shapes are time-normalized for relative ranking; this is not an exact phrase match.`);
  const rhythmScore = input.anchor.rhythm.status === "measured" && input.donor.rhythm.status === "measured"
    ? normalisedRhythmSimilarity(input.anchor.rhythm.value, input.donor.rhythm.value, anchorBeats, donorBeats) : null;
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
    ? (() => {
      const runs = input.donor.vocalActivity.value.pitchContinuityRuns;
      const times = runs.slice(0, 3).map((run) =>
        `${(run.startMs / 1000).toFixed(1)}–${(run.endMs / 1000).toFixed(1)} s`,
      );
      const timing = times.length ? ` First runs: ${times.join(", ")}${runs.length > times.length ? ", …" : ""}.` : " No voiced pitch-continuity run was detected in this passage.";
      return dimension("context", input.donor.vocalActivity.value.voicedCoverage,
        `Verified isolated-vocal analysis measured ${(input.donor.vocalActivity.value.voicedCoverage * 100).toFixed(0)}% voiced coverage and ${runs.length} pitch-continuity runs.${timing} These are not lyric or word boundaries; coverage is context, not a suitability threshold.`);
    })()
    : dimension("unavailable", null, input.donor.vocalActivity.reason);
  const instruments = input.anchor.instrumentalDensity.status === "measured"
    ? dimension("context", input.anchor.instrumentalDensity.value.activeCoverage,
      `Verified non-vocal stem activity covers ${(input.anchor.instrumentalDensity.value.activeCoverage * 100).toFixed(0)}% of the anchor passage; coverage is shown without an unvalidated suitability threshold.`)
    : dimension("unavailable", null, input.anchor.instrumentalDensity.reason);
  const describeStemActivity = (fingerprint: PassageFingerprint, side: string) => {
    if (fingerprint.stemActivity.status !== "measured") return null;
    const changes = fingerprint.stemActivity.value
      .flatMap((stem) => stem.boundaryChanges.map((change) =>
        `${stem.stemType} at beat ${change.beatIndex} ${change.deltaDb > 0 ? "+" : ""}${change.deltaDb.toFixed(1)} dB`));
    return changes.length
      ? `${side}: ${changes.join(", ")}`
      : `${side}: ${fingerprint.stemActivity.value.length} isolated stem(s) measured; none had a sustained ≥${MINIMUM_PERSISTENT_STEM_CHANGE_DB} dB shift at this boundary`;
  };
  const stemActivityEvidence = [
    describeStemActivity(input.anchor, "Anchor"),
    describeStemActivity(input.donor, "Donor"),
  ].filter((value): value is string => value !== null);
  const stemActivity = stemActivityEvidence.length
    ? dimension("context", null, `${stemActivityEvidence.join("; ")}. PCM change is structural context, not a semantic role or compatibility gate.`)
    : dimension("unavailable", null, "No current-checksum-matched separated-stem PCM activity is available for these passages.");
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
    dimensions: { tempo, phraseAlignment, rhythm, harmony, beatPhase: phase, energy, vocalActivity: vocal, instrumentalDensity: instruments, stemActivity, downbeatConfidence: downbeat },
    missingEvidence,
  };
}

export function unavailablePassageEvidence(reason: string): PassageEvidence<never> {
  return { status: "unavailable", reason };
}
