import type { SourceSectionCandidate } from "@workspace/arena/lib/waveyard/types/source-sections";
import {
  PASSAGE_FINGERPRINT_ENGINE,
  PASSAGE_FINGERPRINT_ENGINE_VERSION,
  MINIMUM_PERSISTENT_STEM_CHANGE_DB,
  type PassageStemActivity,
  type PassageFingerprint,
  type PassageRollingWindow,
  type PassageVocalRun,
  unavailablePassageEvidence,
} from "../types/passage-compatibility";
import { ANALYSIS_PCM_RATE, chromaFromPcm } from "./analysis-engine";

const SUBDIVISIONS_PER_BEAT = 4;
const MINIMUM_PHRASE_BEATS = 8;
const MINIMUM_REPEAT_SIMILARITY = 0.92;
const PHRASE_WINDOW_LENGTHS = [32, 16, 8] as const;
const HARMONIC_BINS_PER_SECTION = 4;
const MINIMUM_CHROMA_VARIATION = 1e-5;
const MINIMUM_SECTION_ENERGY_CHANGE_DB = 3;
const PERSISTENT_STEM_BAR_CHANGE_DB = 3;
const MAXIMUM_STABLE_WINDOW_VARIATION_DB = 3;

export type StemActivityProfile = Pick<
  PassageStemActivity,
  "stemType" | "stemAssetId" | "separationJobId" | "stemChecksumSha256"
> & {
  rmsDbByBar: (number | null)[];
};

export type PassageVocalActivityEvidence = {
  analysisId: string;
  stemAssetId: string;
  stemChecksumSha256: string;
  activityIntervals: readonly PassageVocalRun[];
  pitchContinuityRuns: readonly PassageVocalRun[];
};

export type StemActivityBoundaryChange = {
  beatIndex: number;
  stemType: string;
  deltaDb: number;
  evidenceStrength: number;
};

export type VocalActivityBoundaryChange = {
  beatIndex: number;
  deltaCoverage: number;
  evidenceStrength: number;
};

/** Detect only sustained vocal-entry/dropout changes across two-bar windows.
 * This is an arrangement event, never a verse/chorus classifier. */
export function detectVocalActivityBoundaryChanges(
  intervals: readonly PassageVocalRun[],
  beatGridMs: readonly number[],
): VocalActivityBoundaryChange[] {
  if (beatGridMs.length < 20 || beatGridMs.some((time) => !Number.isFinite(time) || time < 0)) return [];
  const bars = Math.floor(beatGridMs.length / 4);
  const finalBeatInterval = beatGridMs.length > 1
    ? beatGridMs[beatGridMs.length - 1]! - beatGridMs[beatGridMs.length - 2]!
    : 0;
  const beatBoundaryMs = (index: number) => index < beatGridMs.length
    ? beatGridMs[index]
    : index === beatGridMs.length && finalBeatInterval > 0
      ? beatGridMs[beatGridMs.length - 1]! + finalBeatInterval
      : undefined;
  const sortedIntervals = intervals
    .filter((interval) => Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs)
      && interval.endMs > interval.startMs)
    .slice()
    .sort((left, right) => left.startMs - right.startMs);
  let intervalCursor = 0;
  const activityByBar: number[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    const startMs = beatBoundaryMs(bar * 4);
    const endMs = beatBoundaryMs((bar + 1) * 4);
    if (startMs === undefined || endMs === undefined || endMs <= startMs) return [];
    let coveredMs = 0;
    let rangeStartMs = -1;
    let rangeEndMs = -1;
    while (intervalCursor < sortedIntervals.length && sortedIntervals[intervalCursor]!.endMs <= startMs) {
      intervalCursor += 1;
    }
    for (let index = intervalCursor; index < sortedIntervals.length; index += 1) {
      const interval = sortedIntervals[index]!;
      if (interval.startMs >= endMs) break;
      if (interval.endMs <= startMs) continue;
      const range = {
        startMs: Math.max(startMs, interval.startMs),
        endMs: Math.min(endMs, interval.endMs),
      };
      if (rangeStartMs < 0) {
        rangeStartMs = range.startMs;
        rangeEndMs = range.endMs;
      } else if (range.startMs <= rangeEndMs) {
        rangeEndMs = Math.max(rangeEndMs, range.endMs);
      } else {
        coveredMs += rangeEndMs - rangeStartMs;
        rangeStartMs = range.startMs;
        rangeEndMs = range.endMs;
      }
    }
    if (rangeStartMs >= 0) coveredMs += rangeEndMs - rangeStartMs;
    activityByBar.push(Math.max(0, Math.min(1, coveredMs / (endMs - startMs))));
  }

  const changes: VocalActivityBoundaryChange[] = [];
  for (let bar = 2; bar <= bars - 2; bar += 1) {
    const before = (activityByBar[bar - 2]! + activityByBar[bar - 1]!) / 2;
    const after = (activityByBar[bar]! + activityByBar[bar + 1]!) / 2;
    const deltaCoverage = after - before;
    const sustainedEntry = before <= 0.25 && after >= 0.6;
    const sustainedDropout = before >= 0.65 && after <= 0.25;
    if (!sustainedEntry && !sustainedDropout) continue;
    changes.push({
      beatIndex: bar * 4,
      deltaCoverage: Number(deltaCoverage.toFixed(3)),
      evidenceStrength: Number(Math.min(0.9, Math.abs(deltaCoverage)).toFixed(3)),
    });
  }
  return changes;
}

/** Creates conservative bar-aligned sections and adds sustained stem/vocal-change events. */
export function desktopSectionCandidates(
  beatGridMs: number[],
  envelope: Float32Array,
  frameMs: number,
  pcm?: Float32Array,
  precomputedPhraseMatches?: readonly RepeatedPhraseMatch[],
  stemActivityBoundaryChanges: readonly StemActivityBoundaryChange[] = [],
  vocalActivityIntervals?: readonly PassageVocalRun[],
): SourceSectionCandidate[] | null {
  if (beatGridMs.length < 8) return null;
  const noveltyAt = (ms: number) => {
    const frame = Math.min(envelope.length - 1, Math.max(0, Math.round(ms / frameMs)));
    return envelope[frame] ?? 0;
  };
  const barLength = 4;
  const barCount = Math.floor(beatGridMs.length / barLength);
  if (barCount < 2) return null;
  const edgeScore = (barIndex: number) => {
    const beat = barIndex * barLength;
    const at = beatGridMs[beat];
    if (at === undefined) return 0;
    const halfBeat = beat + 1 < beatGridMs.length ? (beatGridMs[beat + 1]! - at) / 2 : 250;
    return noveltyAt(Math.max(0, at - halfBeat)) + noveltyAt(at) + noveltyAt(at + halfBeat);
  };
  const meanScore = Array.from({ length: barCount - 1 }, (_, index) => edgeScore(index + 1))
    .reduce((total, value) => total + value, 0) / Math.max(1, barCount - 1);
  const boundaries: number[] = [0];
  for (let bar = 1; bar < barCount; bar += 1) {
    const score = edgeScore(bar);
    if (score >= edgeScore(bar - 1) && score >= edgeScore(bar + 1) && score > meanScore)
      boundaries.push(bar * barLength);
  }
  const stemChangesByBeat = new Map<number, StemActivityBoundaryChange>();
  for (const change of stemActivityBoundaryChanges) {
    const existing = stemChangesByBeat.get(change.beatIndex);
    if (!existing || Math.abs(change.deltaDb) > Math.abs(existing.deltaDb))
      stemChangesByBeat.set(change.beatIndex, change);
  }
  const vocalChangesByBeat = new Map(
    detectVocalActivityBoundaryChanges(vocalActivityIntervals ?? [], beatGridMs)
      .map((change) => [change.beatIndex, change] as const),
  );
  const onsetBoundaries = [...boundaries];
  for (const beatIndex of [...stemChangesByBeat.keys(), ...vocalChangesByBeat.keys()]) {
    const bar = beatIndex / barLength;
    if (!Number.isInteger(bar) || bar <= 1 || bar >= barCount - 1 || boundaries.includes(beatIndex)) continue;
    // Avoid creating one-bar fragments beside already-supported boundaries.
    if (onsetBoundaries.some((boundary) => Math.abs(boundary - beatIndex) < 2 * barLength)) continue;
    boundaries.push(beatIndex);
  }
  boundaries.push(barCount * barLength);
  const orderedBoundaries = [...new Set(boundaries)].sort((left, right) => left - right);
  if (orderedBoundaries.length < 2) return null;

  const candidates: SourceSectionCandidate[] = [];
  for (let index = 0; index < orderedBoundaries.length - 1; index += 1) {
    const startBeatIndex = orderedBoundaries[index]!;
    const endBeatIndex = orderedBoundaries[index + 1]!;
    const stemChange = stemChangesByBeat.get(startBeatIndex);
    const vocalChange = vocalChangesByBeat.get(startBeatIndex);
    const onsetStrength = meanScore > 0
      ? Math.min(1, edgeScore(startBeatIndex / barLength) / (meanScore * 2.5))
      : 0.25;
    candidates.push({
      startBeatIndex,
      endBeatIndex,
      label: stemChange ? "stem-change" : vocalChange ? "vocal-change" : "section",
      labelConfidence: stemChange?.evidenceStrength ?? vocalChange?.evidenceStrength ?? 0,
      structuralConfidence: Math.round(Math.max(0.05, Math.min(1, Math.max(onsetStrength, stemChange?.evidenceStrength ?? 0, vocalChange?.evidenceStrength ?? 0))) * 1000) / 1000,
    });
  }
  const detectedPhraseMatches = precomputedPhraseMatches
    ?? detectRepeatedPhraseMatches(beatGridMs, envelope, frameMs, pcm);
  const phraseMatches = detectedPhraseMatches.filter((match) =>
    ![...stemChangesByBeat.keys(), ...vocalChangesByBeat.keys()].some((boundary) =>
      boundary > match.startBeatIndex && boundary < match.endBeatIndex,
    ),
  );
  const phraseAwareSections = applyRepeatedPhraseMatches(candidates, phraseMatches);
  const withRepeats = labelRepeatedRhythmSections(
    phraseAwareSections,
    beatGridMs,
    envelope,
    frameMs,
    pcm,
    vocalActivityIntervals,
  );
  const withEnergy = pcm ? labelSectionEnergyChanges(withRepeats, beatGridMs, pcm) : withRepeats;
  return withEnergy.map((candidate) => {
    const stemChange = stemChangesByBeat.get(candidate.startBeatIndex);
    const vocalChange = vocalChangesByBeat.get(candidate.startBeatIndex);
    if (stemChange) return { ...candidate, label: "stem-change", labelConfidence: stemChange.evidenceStrength };
    return vocalChange
      ? { ...candidate, label: "vocal-change", labelConfidence: vocalChange.evidenceStrength }
      : candidate;
  });
}

function rmsToDb(squaredEnergy: number, sampleCount: number): number | null {
  if (sampleCount < 1 || !Number.isFinite(squaredEnergy) || squaredEnergy < 0) return null;
  const rms = Math.sqrt(squaredEnergy / sampleCount);
  return Number.isFinite(rms) ? Math.max(-120, 20 * Math.log10(Math.max(rms, 1e-6))) : null;
}

/** Measures each full bar from one decoded, source-provenance-matched stem. */
export function buildStemActivityProfile(
  pcm: Float32Array,
  beatGridMs: number[],
  metadata: Pick<StemActivityProfile, "stemType" | "stemAssetId" | "separationJobId" | "stemChecksumSha256">,
): StemActivityProfile | null {
  if (!pcm.length || beatGridMs.length < 8 || beatGridMs.some((beat) => !Number.isFinite(beat) || beat < 0)) return null;
  const barCount = Math.floor(beatGridMs.length / 4);
  const rmsDbByBar: (number | null)[] = [];
  for (let bar = 0; bar < barCount; bar += 1) {
    const startMs = beatGridMs[bar * 4];
    const endMs = beatGridMs[(bar + 1) * 4];
    if (startMs === undefined || endMs === undefined || endMs <= startMs) {
      rmsDbByBar.push(null);
      continue;
    }
    const startSample = Math.max(0, Math.floor((startMs * ANALYSIS_PCM_RATE) / 1000));
    const endSample = Math.min(pcm.length, Math.floor((endMs * ANALYSIS_PCM_RATE) / 1000));
    if (endSample <= startSample || endSample < Math.floor((endMs * ANALYSIS_PCM_RATE) / 1000)) {
      rmsDbByBar.push(null);
      continue;
    }
    let squaredEnergy = 0;
    for (let sample = startSample; sample < endSample; sample += 1) {
      const value = pcm[sample] ?? 0;
      squaredEnergy += value * value;
    }
    rmsDbByBar.push(rmsToDb(squaredEnergy, endSample - startSample));
  }
  return { ...metadata, rmsDbByBar };
}

function meanRmsDb(values: readonly (number | null)[]): number | null {
  const measured = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!measured.length) return null;
  const meanPower = measured.reduce((total, value) => total + 10 ** (value / 10), 0) / measured.length;
  return Number.isFinite(meanPower) && meanPower > 0 ? 10 * Math.log10(meanPower) : null;
}

/**
 * Finds only sustained bar-aligned stem changes: the two bars after a boundary
 * must both remain at least 3 dB away from the two-bar pre-boundary level, and
 * their combined shift must reach 6 dB. This is arrangement evidence, never a
 * verse/chorus label or proof of cross-song compatibility.
 */
export function detectStemActivityBoundaryChanges(
  profiles: readonly StemActivityProfile[],
): StemActivityBoundaryChange[] {
  const changes: StemActivityBoundaryChange[] = [];
  for (const profile of profiles) {
    for (let bar = 2; bar + 1 < profile.rmsDbByBar.length; bar += 1) {
      const firstBeforeDb = profile.rmsDbByBar[bar - 2];
      const lastBeforeDb = profile.rmsDbByBar[bar - 1];
      const beforeDb = meanRmsDb(profile.rmsDbByBar.slice(bar - 2, bar));
      const firstAfterDb = profile.rmsDbByBar[bar];
      const secondAfterDb = profile.rmsDbByBar[bar + 1];
      if (firstBeforeDb === null || lastBeforeDb === null || beforeDb === null || firstAfterDb === null || secondAfterDb === null) continue;
      // A one-bar fill makes the preceding baseline unstable; do not mistake
      // the return from that fill for a lasting arrangement transition.
      if (Math.abs(lastBeforeDb - firstBeforeDb) > MAXIMUM_STABLE_WINDOW_VARIATION_DB
        || Math.abs(secondAfterDb - firstAfterDb) > MAXIMUM_STABLE_WINDOW_VARIATION_DB) continue;
      const deltaDb = meanRmsDb([firstAfterDb, secondAfterDb]);
      if (deltaDb === null) continue;
      const netChangeDb = deltaDb - beforeDb;
      if (Math.abs(netChangeDb) < MINIMUM_PERSISTENT_STEM_CHANGE_DB) continue;
      const direction = Math.sign(netChangeDb);
      if ((firstAfterDb - beforeDb) * direction < PERSISTENT_STEM_BAR_CHANGE_DB
        || (secondAfterDb - beforeDb) * direction < PERSISTENT_STEM_BAR_CHANGE_DB) continue;
      const beatIndex = bar * 4;
      const change = {
        beatIndex,
        stemType: profile.stemType,
        deltaDb: Number(netChangeDb.toFixed(2)),
        evidenceStrength: Number(Math.min(1, Math.abs(netChangeDb) / 18).toFixed(3)),
      };
      changes.push(change);
    }
  }
  return changes.sort((left, right) => left.beatIndex - right.beatIndex || left.stemType.localeCompare(right.stemType));
}

/** Keeps the measured stem context alongside a persisted source passage. */
export function passageStemActivityEvidence(
  profiles: readonly StemActivityProfile[],
  startBeatIndex: number,
  endBeatIndex: number,
  boundaryChanges: readonly StemActivityBoundaryChange[],
): PassageFingerprint["stemActivity"] {
  const firstBar = Math.floor(startBeatIndex / 4);
  const afterLastBar = Math.floor(endBeatIndex / 4);
  const measurements: PassageStemActivity[] = profiles.flatMap((profile) => {
    const sectionRmsDb = meanRmsDb(profile.rmsDbByBar.slice(firstBar, afterLastBar));
    return sectionRmsDb === null ? [] : [{
      stemType: profile.stemType,
      stemAssetId: profile.stemAssetId,
      separationJobId: profile.separationJobId,
      stemChecksumSha256: profile.stemChecksumSha256,
      sectionRmsDb: Number(sectionRmsDb.toFixed(2)),
      boundaryChanges: boundaryChanges
        .filter((change) => change.stemType === profile.stemType
          && change.beatIndex >= startBeatIndex && change.beatIndex < endBeatIndex)
        .slice(0, 32)
        .map(({ beatIndex, deltaDb }) => ({ beatIndex, deltaDb })),
    }];
  });
  return measurements.length
    ? {
      status: "measured",
      value: measurements,
      method: "isolated-stem PCM RMS by source beat-grid bar; boundary change compares sustained two-bar windows",
      confidence: null,
    }
    : unavailablePassageEvidence("No complete, source-checksum-matched separated-stem PCM was available for this passage.");
}

function median(values: number[]): number {
  if (!values.length) return 500;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function sectionRhythmSignature(
  startBeatIndex: number,
  endBeatIndex: number,
  beatGridMs: number[],
  envelope: Float32Array,
  frameMs: number,
): number[] | null {
  const beatCount = endBeatIndex - startBeatIndex;
  if (
    beatCount < MINIMUM_PHRASE_BEATS
    || beatCount % 4 !== 0
    || startBeatIndex < 0
    || endBeatIndex > beatGridMs.length
    || !Number.isFinite(frameMs)
    || frameMs <= 0
    || envelope.length === 0
  ) return null;

  const fallbackBeatMs = median(
    beatGridMs.slice(1).map((time, index) => time - beatGridMs[index]).filter((interval) => Number.isFinite(interval) && interval > 0),
  );
  const samples: number[] = [];
  for (let beatIndex = startBeatIndex; beatIndex < endBeatIndex; beatIndex += 1) {
    const beatStartMs = beatGridMs[beatIndex];
    const beatEndMs = beatGridMs[beatIndex + 1] ?? beatStartMs + fallbackBeatMs;
    if (!Number.isFinite(beatStartMs) || !Number.isFinite(beatEndMs) || beatEndMs <= beatStartMs) return null;

    for (let subdivision = 0; subdivision < SUBDIVISIONS_PER_BEAT; subdivision += 1) {
      const binStartMs = beatStartMs + ((beatEndMs - beatStartMs) * subdivision) / SUBDIVISIONS_PER_BEAT;
      const binEndMs = beatStartMs + ((beatEndMs - beatStartMs) * (subdivision + 1)) / SUBDIVISIONS_PER_BEAT;
      const firstFrame = Math.max(0, Math.floor(binStartMs / frameMs));
      const afterLastFrame = Math.min(envelope.length, Math.max(firstFrame + 1, Math.ceil(binEndMs / frameMs)));
      if (firstFrame >= envelope.length || afterLastFrame <= firstFrame) return null;

      let peak = 0;
      for (let frame = firstFrame; frame < afterLastFrame; frame += 1) {
        peak = Math.max(peak, envelope[frame] ?? 0);
      }
      samples.push(peak);
    }
  }

  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  const centered = samples.map((value) => value - mean);
  const magnitude = Math.sqrt(centered.reduce((total, value) => total + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude < 1e-8) return null;
  return centered.map((value) => value / magnitude);
}

function signatureSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  return left.reduce((total, value, index) => total + value * right[index], 0);
}

export function sectionHarmonicSignature(
  pcm: Float32Array,
  startBeatIndex: number,
  endBeatIndex: number,
  beatGridMs: number[],
): number[] | null {
  const beatCount = endBeatIndex - startBeatIndex;
  if (beatCount < MINIMUM_PHRASE_BEATS || beatCount % HARMONIC_BINS_PER_SECTION !== 0) return null;

  const fallbackBeatMs = median(
    beatGridMs.slice(1).map((time, index) => time - beatGridMs[index]).filter((interval) => Number.isFinite(interval) && interval > 0),
  );
  const beatTimeMs = (index: number) => {
    if (index < 0 || index > beatGridMs.length) return null;
    if (index < beatGridMs.length) return beatGridMs[index];
    const last = beatGridMs.at(-1);
    return last === undefined ? null : last + fallbackBeatMs;
  };

  const signature: number[] = [];
  for (let bin = 0; bin < HARMONIC_BINS_PER_SECTION; bin += 1) {
    const startBeat = startBeatIndex + (beatCount * bin) / HARMONIC_BINS_PER_SECTION;
    const endBeat = startBeatIndex + (beatCount * (bin + 1)) / HARMONIC_BINS_PER_SECTION;
    const startMs = beatTimeMs(startBeat);
    const endMs = beatTimeMs(endBeat);
    if (startMs === null || endMs === null || endMs <= startMs) return null;

    const startSample = Math.max(0, Math.floor((startMs * ANALYSIS_PCM_RATE) / 1000));
    const endSample = Math.min(pcm.length, Math.ceil((endMs * ANALYSIS_PCM_RATE) / 1000));
    if (endSample - startSample < 8192) return null;

    const chroma = chromaFromPcm(pcm.subarray(startSample, endSample));
    if (chroma.length !== 12 || chroma.some((value) => !Number.isFinite(value) || value < 0)) return null;
    const mean = chroma.reduce((total, value) => total + value, 0) / chroma.length;
    const centered = chroma.map((value) => value - mean);
    const magnitude = Math.sqrt(centered.reduce((total, value) => total + value * value, 0));
    if (!Number.isFinite(magnitude) || magnitude < MINIMUM_CHROMA_VARIATION) return null;
    signature.push(...centered.map((value) => value / magnitude));
  }

  const magnitude = Math.sqrt(signature.reduce((total, value) => total + value * value, 0));
  return magnitude > 0 ? signature.map((value) => value / magnitude) : null;
}

/** Builds local two-bar comparisons across a whole passage without semantic labels. */
export function buildRollingPassageWindows(
  startBeatIndex: number,
  endBeatIndex: number,
  beatGridMs: number[],
  envelope: Float32Array,
  frameMs: number,
  pcm: Float32Array,
  confidence: number | null,
): PassageRollingWindow[] {
  const windowBeats = 8;
  const minimumHopBeats = 4;
  const availableStarts = Math.max(0, Math.floor((endBeatIndex - startBeatIndex - windowBeats) / minimumHopBeats) + 1);
  if (availableStarts === 0) return [];
  const hopBeats = minimumHopBeats * Math.max(1, Math.ceil(availableStarts / 256));
  const fallbackBeatMs = median(
    beatGridMs.slice(1).map((time, index) => time - beatGridMs[index]!)
      .filter((interval) => Number.isFinite(interval) && interval > 0),
  );
  const windows: PassageRollingWindow[] = [];
  for (
    let windowStart = startBeatIndex;
    windowStart + windowBeats <= endBeatIndex && windows.length < 256;
    windowStart += hopBeats
  ) {
    const windowEnd = windowStart + windowBeats;
    const rhythm = sectionRhythmSignature(windowStart, windowEnd, beatGridMs, envelope, frameMs);
    const chroma = sectionHarmonicSignature(pcm, windowStart, windowEnd, beatGridMs);
    const intervals = Array.from({ length: windowBeats }, (_, offset) => {
      const current = beatGridMs[windowStart + offset];
      const next = beatGridMs[windowStart + offset + 1];
      return current !== undefined && next !== undefined && next > current ? next - current : null;
    }).filter((interval): interval is number => interval !== null);
    const beatPeriodMs = intervals.length ? median(intervals) : fallbackBeatMs;
    const phase = [0, 0, 0, 0];
    if (frameMs > 0 && Number.isFinite(beatPeriodMs) && beatPeriodMs > 0) {
      for (let beat = windowStart; beat < windowEnd; beat += 1) {
        const beatStart = beatGridMs[beat];
        const beatEnd = beatGridMs[beat + 1] ?? (beatStart === undefined ? undefined : beatStart + beatPeriodMs);
        if (beatStart === undefined || beatEnd === undefined || beatEnd <= beatStart) continue;
        for (let subdivision = 0; subdivision < 4; subdivision += 1) {
          const from = Math.max(0, Math.floor((beatStart + (beatEnd - beatStart) * subdivision / 4) / frameMs));
          const to = Math.min(envelope.length, Math.max(from + 1, Math.ceil((beatStart + (beatEnd - beatStart) * (subdivision + 1) / 4) / frameMs)));
          for (let frame = from; frame < to; frame += 1)
            phase[subdivision] = Math.max(phase[subdivision]!, envelope[frame] ?? 0);
        }
      }
    }
    const phaseMagnitude = Math.sqrt(phase.reduce((total, value) => total + value * value, 0));
    const phaseEvidence = phaseMagnitude > 1e-8 && Number.isFinite(beatPeriodMs)
      ? {
        status: "measured" as const,
        value: {
          subdivisionProfile: phase.map((value) => value / phaseMagnitude),
          beatPeriodMs,
        },
        method: "local onset energy by beat subdivision across an eight-beat window",
        confidence,
      }
      : unavailablePassageEvidence("Local beat-phase evidence is unavailable for this window.");
    windows.push({
      startBeatIndex: windowStart,
      endBeatIndex: windowEnd,
      rhythm: rhythm
        ? { status: "measured", value: rhythm, method: "four onset-envelope subdivisions per beat in an eight-beat window", confidence }
        : unavailablePassageEvidence("Local onset rhythm has insufficient variation."),
      chroma: chroma
        ? { status: "measured", value: chroma, method: "four time-ordered 12-bin chroma windows in an eight-beat window", confidence }
        : unavailablePassageEvidence("Local chroma lacks sufficient tonal variation."),
      beatPhase: phaseEvidence,
    });
  }
  return windows;
}

function beatBoundaryMs(index: number, beatGridMs: number[]): number | null {
  if (index < 0 || index > beatGridMs.length || beatGridMs.length === 0) return null;
  if (index < beatGridMs.length) return beatGridMs[index];
  const fallbackBeatMs = median(
    beatGridMs.slice(1).map((time, beatIndex) => time - beatGridMs[beatIndex]).filter((interval) => Number.isFinite(interval) && interval > 0),
  );
  return beatGridMs.at(-1)! + fallbackBeatMs;
}

export function sectionRmsDb(
  pcm: Float32Array,
  startBeatIndex: number,
  endBeatIndex: number,
  beatGridMs: number[],
): number | null {
  const startMs = beatBoundaryMs(startBeatIndex, beatGridMs);
  const endMs = beatBoundaryMs(endBeatIndex, beatGridMs);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  const startSample = Math.max(0, Math.floor((startMs * ANALYSIS_PCM_RATE) / 1000));
  const endSample = Math.min(pcm.length, Math.ceil((endMs * ANALYSIS_PCM_RATE) / 1000));
  if (endSample - startSample < 8192) return null;

  let squaredEnergy = 0;
  for (let sample = startSample; sample < endSample; sample += 1) {
    const value = pcm[sample] ?? 0;
    squaredEnergy += value * value;
  }
  const rms = Math.sqrt(squaredEnergy / (endSample - startSample));
  return Number.isFinite(rms) && rms > 1e-8 ? 20 * Math.log10(rms) : null;
}

export function passageVocalActivityEvidence(
  input: PassageVocalActivityEvidence | undefined,
  startMs: number | null,
  endMs: number | null,
): PassageFingerprint["vocalActivity"] {
  if (!input || startMs === null || endMs === null || endMs <= startMs) {
    return unavailablePassageEvidence("No current-checksum-matched isolated-vocal activity analysis was available.");
  }
  const clipRuns = (source: readonly PassageVocalRun[]) => source
    .filter((run) => run.endMs > startMs && run.startMs < endMs)
    .slice(0, 256)
    .map((run) => ({
      startMs: Math.max(startMs, run.startMs),
      endMs: Math.min(endMs, run.endMs),
      confidence: run.confidence,
    }))
    .filter((run) => run.endMs > run.startMs)
    .sort((left, right) => left.startMs - right.startMs);
  const measureCoverage = (runs: readonly PassageVocalRun[]) => {
    const clipped = runs
    .map((run) => ({ startMs: Math.max(startMs, run.startMs), endMs: Math.min(endMs, run.endMs) }))
    .filter((run) => run.endMs > run.startMs)
    .sort((left, right) => left.startMs - right.startMs);
    let coveredMs = 0;
    let rangeStartMs = -1;
    let rangeEndMs = -1;
    for (const range of clipped) {
      if (rangeStartMs < 0) {
        rangeStartMs = range.startMs;
        rangeEndMs = range.endMs;
      } else if (range.startMs <= rangeEndMs) {
        rangeEndMs = Math.max(rangeEndMs, range.endMs);
      } else {
        coveredMs += rangeEndMs - rangeStartMs;
        rangeStartMs = range.startMs;
        rangeEndMs = range.endMs;
      }
    }
    if (rangeStartMs >= 0) coveredMs += rangeEndMs - rangeStartMs;
    return Math.max(0, Math.min(1, coveredMs / (endMs - startMs)));
  };
  const activityIntervals = clipRuns(input.activityIntervals);
  const pitchContinuityRuns = clipRuns(input.pitchContinuityRuns);
  const meanOf = (runs: readonly PassageVocalRun[]) => runs.length
    ? Number((runs.reduce((total, run) => total + run.confidence, 0) / runs.length).toFixed(6))
    : 0;
  const meanActivityStrength = meanOf(activityIntervals);
  const meanPitchConfidence = meanOf(pitchContinuityRuns);
  return {
    status: "measured",
    value: {
      activityCoverage: measureCoverage(activityIntervals),
      meanActivityStrength,
      pitchCoverage: measureCoverage(pitchContinuityRuns),
      meanPitchConfidence,
      analysisId: input.analysisId,
      stemAssetId: input.stemAssetId,
      stemChecksumSha256: input.stemChecksumSha256,
      activityIntervals,
      pitchContinuityRuns,
    },
    method: "Source/stem-checksum-current vocal RMS activity and pitch continuity; neither denotes lyrics",
    confidence: null,
  };
}

/** Builds only features measured from the source PCM and versioned beat grid. */
export function buildPassageFingerprint(input: {
  sourceChecksumSha256: string;
  startBeatIndex: number;
  endBeatIndex: number;
  beatGridMs: number[];
  beatConfidence: number | null;
  envelope: Float32Array;
  frameMs: number;
  pcm: Float32Array;
  stemActivityProfiles?: readonly StemActivityProfile[];
  stemActivityBoundaryChanges?: readonly StemActivityBoundaryChange[];
  vocalActivity?: PassageVocalActivityEvidence;
}): PassageFingerprint {
  const { startBeatIndex, endBeatIndex, beatGridMs, envelope, frameMs, pcm } = input;
  const rhythmSignature = sectionRhythmSignature(startBeatIndex, endBeatIndex, beatGridMs, envelope, frameMs);
  const chromaSignature = sectionHarmonicSignature(pcm, startBeatIndex, endBeatIndex, beatGridMs);
  const rollingWindows = buildRollingPassageWindows(
    startBeatIndex,
    endBeatIndex,
    beatGridMs,
    envelope,
    frameMs,
    pcm,
    input.beatConfidence,
  );
  const rmsDb = sectionRmsDb(pcm, startBeatIndex, endBeatIndex, beatGridMs);
  const intervals = beatGridMs.slice(startBeatIndex + 1, endBeatIndex)
    .map((time, index) => time - beatGridMs[startBeatIndex + index]!)
    .filter((interval) => Number.isFinite(interval) && interval > 0)
    .sort((left, right) => left - right);
  const beatPeriodMs = intervals[Math.floor(intervals.length / 2)] ?? null;
  const phaseProfile = [0, 0, 0, 0];
  if (beatPeriodMs !== null && frameMs > 0 && envelope.length > 0) {
    for (let beat = startBeatIndex; beat < endBeatIndex; beat += 1) {
      const startMs = beatGridMs[beat];
      if (!Number.isFinite(startMs)) continue;
      const endMs = beatGridMs[beat + 1] ?? startMs + beatPeriodMs;
      if (!Number.isFinite(endMs) || endMs <= startMs) continue;
      for (let subdivision = 0; subdivision < 4; subdivision += 1) {
        const from = Math.max(0, Math.floor((startMs + (endMs - startMs) * subdivision / 4) / frameMs));
        const to = Math.min(envelope.length, Math.max(from + 1, Math.ceil((startMs + (endMs - startMs) * (subdivision + 1) / 4) / frameMs)));
        let peak = 0;
        for (let frame = from; frame < to; frame += 1) peak = Math.max(peak, envelope[frame] ?? 0);
        phaseProfile[subdivision] += peak;
      }
    }
  }
  const phaseMagnitude = Math.sqrt(phaseProfile.reduce((total, value) => total + value * value, 0));
  if (phaseMagnitude > 1e-8) {
    for (let index = 0; index < phaseProfile.length; index += 1) phaseProfile[index] = phaseProfile[index]! / phaseMagnitude;
  }
  const unavailable = "Not measured by this source-only structural pass.";
  return {
    schemaVersion: 3,
    engine: PASSAGE_FINGERPRINT_ENGINE,
    engineVersion: PASSAGE_FINGERPRINT_ENGINE_VERSION,
    sourceChecksumSha256: input.sourceChecksumSha256,
    startBeatIndex,
    endBeatIndex,
    rhythm: rhythmSignature
      ? { status: "measured", value: rhythmSignature, method: "four onset-envelope subdivisions per beat", confidence: input.beatConfidence }
      : unavailablePassageEvidence("Passage is too short or has insufficient onset variation for a rhythm fingerprint."),
    chroma: chromaSignature
      ? { status: "measured", value: chromaSignature, method: "four time-ordered 12-bin chroma windows", confidence: input.beatConfidence }
      : unavailablePassageEvidence("Passage is too short or lacks sufficient chroma variation for a harmonic fingerprint."),
    beatPhase: phaseMagnitude > 1e-8 && beatPeriodMs !== null
      ? { status: "measured", value: { subdivisionProfile: phaseProfile, beatPeriodMs }, method: "onset energy aggregated by beat subdivision", confidence: input.beatConfidence }
      : unavailablePassageEvidence("Beat-phase profile is unavailable because beat-aligned onset energy could not be measured."),
    energy: rmsDb === null
      ? unavailablePassageEvidence("Source passage RMS is unavailable (empty or effectively silent audio).")
      : { status: "measured", value: { rmsDb }, method: "source PCM section RMS", confidence: null },
    downbeatConfidence: unavailablePassageEvidence("The persisted beat grid does not independently identify downbeats."),
    vocalActivity: passageVocalActivityEvidence(
      input.vocalActivity,
      beatBoundaryMs(startBeatIndex, beatGridMs),
      beatBoundaryMs(endBeatIndex, beatGridMs),
    ),
    instrumentalDensity: unavailablePassageEvidence("Separated non-vocal stem activity is not part of source-only structural analysis."),
    stemActivity: passageStemActivityEvidence(
      input.stemActivityProfiles ?? [],
      startBeatIndex,
      endBeatIndex,
      input.stemActivityBoundaryChanges ?? [],
    ),
    rollingWindows: rollingWindows.length
      ? {
        status: "measured",
        value: rollingWindows,
        method: "checksum-bound local eight-beat rhythm, chroma, and beat-phase windows with four-beat hops",
        confidence: input.beatConfidence,
      }
      : unavailablePassageEvidence("The passage is shorter than eight measured beats or lacks rolling-window evidence."),
  };
}

/** Average section loudness difference; positive means a rise into the section. */
export function sectionEnergyChangeDb(
  previous: Pick<SourceSectionCandidate, "startBeatIndex" | "endBeatIndex"> | null,
  current: Pick<SourceSectionCandidate, "startBeatIndex" | "endBeatIndex">,
  beatGridMs: number[],
  pcm: Float32Array,
): number | null {
  if (!previous) return null;
  const previousDb = sectionRmsDb(pcm, previous.startBeatIndex, previous.endBeatIndex, beatGridMs);
  const currentDb = sectionRmsDb(pcm, current.startBeatIndex, current.endBeatIndex, beatGridMs);
  if (previousDb === null || currentDb === null) return null;
  return currentDb - previousDb;
}

function repeatLabel(index: number, kind: "rhythm" | "pattern" | "vocal-pattern"): string {
  let value = index;
  let label = "";
  do {
    label = String.fromCharCode(97 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return `${kind}-repeat-${label}`;
}

function vocalActivityMask(
  candidate: Pick<SourceSectionCandidate, "startBeatIndex" | "endBeatIndex">,
  beatGridMs: number[],
  intervals: readonly PassageVocalRun[],
): number[] | null {
  const beatCount = candidate.endBeatIndex - candidate.startBeatIndex;
  const binCount = beatCount * SUBDIVISIONS_PER_BEAT;
  if (beatCount < MINIMUM_PHRASE_BEATS || binCount > 512 || !intervals.length) return null;
  const rangeStartMs = beatBoundaryMs(candidate.startBeatIndex, beatGridMs);
  const rangeEndMs = beatBoundaryMs(candidate.endBeatIndex, beatGridMs);
  if (rangeStartMs === null || rangeEndMs === null || rangeEndMs <= rangeStartMs) return null;
  const clipped = intervals
    .filter((interval) => Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs)
      && Number.isFinite(interval.confidence) && interval.confidence >= 0.5
      && interval.endMs > interval.startMs && interval.endMs > rangeStartMs && interval.startMs < rangeEndMs)
    .map((interval) => ({
      startMs: Math.max(rangeStartMs, interval.startMs),
      endMs: Math.min(rangeEndMs, interval.endMs),
    }))
    .sort((left, right) => left.startMs - right.startMs);
  const merged: { startMs: number; endMs: number }[] = [];
  for (const interval of clipped) {
    const previous = merged.at(-1);
    if (previous && interval.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, interval.endMs);
    else merged.push({ ...interval });
  }
  const pointAtBeat = (beat: number): number | null => {
    const lowerBeat = Math.floor(beat);
    const fraction = beat - lowerBeat;
    const start = beatBoundaryMs(lowerBeat, beatGridMs);
    const end = beatBoundaryMs(lowerBeat + 1, beatGridMs);
    return start === null || end === null || end <= start ? null : start + (end - start) * fraction;
  };
  const mask: number[] = [];
  let intervalIndex = 0;
  for (let bin = 0; bin < binCount; bin += 1) {
    const startMs = pointAtBeat(candidate.startBeatIndex + bin / SUBDIVISIONS_PER_BEAT);
    const endMs = pointAtBeat(candidate.startBeatIndex + (bin + 1) / SUBDIVISIONS_PER_BEAT);
    if (startMs === null || endMs === null || endMs <= startMs) return null;
    while (intervalIndex < merged.length && merged[intervalIndex]!.endMs <= startMs) intervalIndex += 1;
    let coveredMs = 0;
    for (let index = intervalIndex; index < merged.length && merged[index]!.startMs < endMs; index += 1) {
      coveredMs += Math.max(0, Math.min(endMs, merged[index]!.endMs) - Math.max(startMs, merged[index]!.startMs));
    }
    mask.push(coveredMs / (endMs - startMs) >= 0.12 ? 1 : 0);
  }
  return mask;
}

function vocalMaskAgreement(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1;
  const activeCount = (mask: readonly number[]) => mask.reduce((sum, active) => sum + active, 0);
  if (activeCount(left) < 4 || activeCount(right) < 4) return -1;
  const mismatched = left.reduce((sum, active, index) => sum + Number(active !== right[index]), 0);
  return 1 - mismatched / left.length;
}

function similarityMatrix(signatures: readonly (number[] | null)[]): number[][] {
  return signatures.map((left) => signatures.map((right) =>
    left && right ? signatureSimilarity(left, right) : -1,
  ));
}

function findCliqueGroups(
  similarities: number[][],
  eligibleIndices: readonly number[],
  minimumSimilarity: number,
): { indices: number[]; score: number }[] {
  const remaining = new Set(eligibleIndices);
  const groups: { indices: number[]; score: number }[] = [];

  while (remaining.size >= 2) {
    let bestClique: number[] = [];
    for (const first of remaining) {
      const clique = [first];
      for (const candidate of remaining) {
        if (candidate === first) continue;
        if (clique.every((member) => similarities[member][candidate] >= minimumSimilarity)) {
          clique.push(candidate);
        }
      }
      if (clique.length > bestClique.length) bestClique = clique;
    }

    if (bestClique.length < 2) break;
    const score = Math.min(
      ...bestClique.flatMap((left, index) =>
        bestClique.slice(index + 1).map((right) => similarities[left][right]),
      ),
    );
    groups.push({ indices: bestClique, score });
    bestClique.forEach((index) => remaining.delete(index));
  }

  return groups;
}

export type RepeatedPhraseMatch = {
  startBeatIndex: number;
  endBeatIndex: number;
  label: string;
  labelConfidence: number;
};

/** Splits existing source sections around measured phrase matches without overlap. */
export function applyRepeatedPhraseMatches(
  candidates: readonly SourceSectionCandidate[],
  matches: readonly RepeatedPhraseMatch[],
): SourceSectionCandidate[] {
  const accepted: RepeatedPhraseMatch[] = [];
  for (const match of [...matches].sort((left, right) => left.startBeatIndex - right.startBeatIndex)) {
    if (
      !Number.isInteger(match.startBeatIndex)
      || !Number.isInteger(match.endBeatIndex)
      || match.endBeatIndex - match.startBeatIndex < MINIMUM_PHRASE_BEATS
      || (match.endBeatIndex - match.startBeatIndex) % 4 !== 0
      || !/^((pattern|rhythm)-repeat)-[a-z]+$/.test(match.label)
      || !Number.isFinite(match.labelConfidence)
      || match.labelConfidence < MINIMUM_REPEAT_SIMILARITY
      || match.labelConfidence > 1
      || accepted.some((previous) =>
        match.startBeatIndex < previous.endBeatIndex && match.endBeatIndex > previous.startBeatIndex,
      )
    ) continue;
    accepted.push(match);
  }
  if (!accepted.length) return [...candidates];

  const boundaries = [...new Set([
    ...candidates
      .flatMap((candidate) => [candidate.startBeatIndex, candidate.endBeatIndex])
      .filter((boundary) => !accepted.some((match) =>
        boundary > match.startBeatIndex && boundary < match.endBeatIndex,
      )),
    ...accepted.flatMap((match) => [match.startBeatIndex, match.endBeatIndex]),
  ])].sort((left, right) => left - right);
  const matchByRange = new Map(
    accepted.map((match) => [`${match.startBeatIndex}:${match.endBeatIndex}`, match]),
  );
  const partitioned: SourceSectionCandidate[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startBeatIndex = boundaries[index]!;
    const endBeatIndex = boundaries[index + 1]!;
    const overlapping = candidates.filter((candidate) =>
      candidate.startBeatIndex < endBeatIndex && candidate.endBeatIndex > startBeatIndex,
    );
    if (!overlapping.length) continue;
    const exact = overlapping.find((candidate) =>
      candidate.startBeatIndex === startBeatIndex && candidate.endBeatIndex === endBeatIndex,
    );
    const match = matchByRange.get(`${startBeatIndex}:${endBeatIndex}`);
    const base = exact ?? overlapping[0]!;
    partitioned.push({
      ...base,
      startBeatIndex,
      endBeatIndex,
      label: match?.label ?? (exact ? base.label : "section"),
      labelConfidence: match?.labelConfidence ?? (exact ? base.labelConfidence : 0),
      structuralConfidence: match
        ? Math.min(match.labelConfidence, ...overlapping.map((candidate) => candidate.structuralConfidence))
        : Math.min(...overlapping.map((candidate) => candidate.structuralConfidence)),
    });
  }
  return partitioned;
}

/**
 * Finds repeated two-, four-, and eight-bar phrases independently of novelty
 * segmentation. Windows are beat-grid aligned at half-window hops; accepted
 * matches cannot overlap, and longer matches take precedence. A pattern repeat
 * requires both rhythm and four-bin chroma similarity; when chroma is absent
 * or disagrees, only rhythmic evidence may be labelled. These are recurrence
 * labels, not semantic song roles or cross-song matches.
 */
export function detectRepeatedPhraseMatches(
  beatGridMs: number[],
  envelope: Float32Array,
  frameMs: number,
  pcm?: Float32Array,
): RepeatedPhraseMatch[] {
  const matches: RepeatedPhraseMatch[] = [];
  const occupied: { startBeatIndex: number; endBeatIndex: number }[] = [];
  let patternLabelIndex = 0;
  let rhythmLabelIndex = 0;
  for (const windowBeats of PHRASE_WINDOW_LENGTHS) {
    const windows: {
      startBeatIndex: number;
      endBeatIndex: number;
      rhythm: number[];
      harmonic: number[] | null;
    }[] = [];
    const hopBeats = windowBeats / 2;
    for (let startBeatIndex = 0; startBeatIndex + windowBeats <= beatGridMs.length; startBeatIndex += hopBeats) {
      const endBeatIndex = startBeatIndex + windowBeats;
      const rhythm = sectionRhythmSignature(startBeatIndex, endBeatIndex, beatGridMs, envelope, frameMs);
      if (!rhythm) continue;
      windows.push({
        startBeatIndex,
        endBeatIndex,
        rhythm,
        harmonic: pcm
          ? sectionHarmonicSignature(pcm, startBeatIndex, endBeatIndex, beatGridMs)
          : null,
      });
    }
    if (windows.length < 2) continue;

    const rhythmSimilarities = windows.map(() => windows.map(() => -1));
    const patternSimilarities = windows.map(() => windows.map(() => -1));
    for (let left = 0; left < windows.length; left += 1) {
      for (let right = left + 1; right < windows.length; right += 1) {
        const leftWindow = windows[left]!;
        const rightWindow = windows[right]!;
        if (leftWindow.endBeatIndex > rightWindow.startBeatIndex) continue;
        const rhythmScore = signatureSimilarity(leftWindow.rhythm, rightWindow.rhythm);
        rhythmSimilarities[left]![right] = rhythmScore;
        rhythmSimilarities[right]![left] = rhythmScore;
        if (
          rhythmScore < MINIMUM_REPEAT_SIMILARITY
          || !leftWindow.harmonic
          || !rightWindow.harmonic
        ) continue;
        const harmonicScore = signatureSimilarity(leftWindow.harmonic, rightWindow.harmonic);
        if (harmonicScore < MINIMUM_REPEAT_SIMILARITY) continue;
        const score = Math.min(rhythmScore, harmonicScore);
        patternSimilarities[left]![right] = score;
        patternSimilarities[right]![left] = score;
      }
    }

    const acceptGroups = (
      groups: { indices: number[]; score: number }[],
      similarities: number[][],
      kind: "rhythm" | "pattern",
    ) => {
      const acceptedIndices = new Set<number>();
      for (const group of [...groups].sort((left, right) =>
        right.indices.length - left.indices.length || right.score - left.score,
      )) {
        const selected = group.indices.filter((index) => {
          const window = windows[index]!;
          return !occupied.some((range) =>
            window.startBeatIndex < range.endBeatIndex && window.endBeatIndex > range.startBeatIndex,
          );
        });
        if (selected.length < 2) continue;
        const score = Math.min(
          ...selected.flatMap((left, index) =>
            selected.slice(index + 1).map((right) => similarities[left]![right]!),
          ),
        );
        if (score < MINIMUM_REPEAT_SIMILARITY) continue;
        const labelIndex = kind === "pattern" ? patternLabelIndex++ : rhythmLabelIndex++;
        const label = repeatLabel(labelIndex, kind);
        for (const index of selected) {
          const window = windows[index]!;
          matches.push({
            startBeatIndex: window.startBeatIndex,
            endBeatIndex: window.endBeatIndex,
            label,
            labelConfidence: Math.round(score * 1000) / 1000,
          });
          occupied.push({
            startBeatIndex: window.startBeatIndex,
            endBeatIndex: window.endBeatIndex,
          });
          acceptedIndices.add(index);
        }
      }
      return acceptedIndices;
    };

    const allIndices = windows.map((_window, index) => index);
    const patternGroups = findCliqueGroups(patternSimilarities, allIndices, MINIMUM_REPEAT_SIMILARITY);
    const acceptedPatternIndices = acceptGroups(patternGroups, patternSimilarities, "pattern");
    const rhythmOnlyIndices = allIndices.filter((index) => !acceptedPatternIndices.has(index));
    const rhythmGroups = findCliqueGroups(rhythmSimilarities, rhythmOnlyIndices, MINIMUM_REPEAT_SIMILARITY);
    acceptGroups(rhythmGroups, rhythmSimilarities, "rhythm");
  }
  return matches.sort((left, right) => left.startBeatIndex - right.startBeatIndex);
}

/**
 * Marks repeated beat-grid-aligned structure within one source. When original
 * PCM is available, a pattern label requires both a repeated onset fingerprint
 * and a repeated four-bin harmonic profile. If that stronger evidence is not
 * available, the function may still report a rhythm-only repeat. Neither label
 * claims verse/chorus meaning or cross-song equivalence.
 */
export function labelRepeatedRhythmSections(
  candidates: readonly SourceSectionCandidate[],
  beatGridMs: number[],
  envelope: Float32Array,
  frameMs: number,
  pcm?: Float32Array,
  vocalActivityIntervals: readonly PassageVocalRun[] = [],
): SourceSectionCandidate[] {
  if (candidates.length < 2) return candidates.map((candidate) => ({ ...candidate }));

  const eligibleIndices = candidates.flatMap((candidate, index) =>
    candidate.label === "section" && candidate.labelConfidence <= 0 ? [index] : [],
  );
  const rhythmSignatures = candidates.map((candidate) =>
    candidate.label === "section" && candidate.labelConfidence <= 0
      ? sectionRhythmSignature(candidate.startBeatIndex, candidate.endBeatIndex, beatGridMs, envelope, frameMs)
      : null,
  );
  const labeled = candidates.map((candidate) => ({ ...candidate }));
  const rhythmSimilarities = similarityMatrix(rhythmSignatures);
  const repeatedPatternGroups = pcm
    ? (() => {
      const harmonicSignatures = candidates.map((candidate, index) =>
        rhythmSignatures[index]
          ? sectionHarmonicSignature(pcm, candidate.startBeatIndex, candidate.endBeatIndex, beatGridMs)
          : null,
      );
      const harmonicSimilarities = similarityMatrix(harmonicSignatures);
      const patternSimilarities = rhythmSimilarities.map((rhythmRow, left) =>
        rhythmRow.map((rhythmScore, right) => {
          const harmonicScore = harmonicSimilarities[left][right];
          return rhythmScore >= MINIMUM_REPEAT_SIMILARITY && harmonicScore >= MINIMUM_REPEAT_SIMILARITY
            ? Math.min(rhythmScore, harmonicScore)
            : -1;
        }),
      );
      return findCliqueGroups(patternSimilarities, eligibleIndices, MINIMUM_REPEAT_SIMILARITY);
    })()
    : [];

  const patternIndices = new Set(repeatedPatternGroups.flatMap(({ indices }) => indices));
  repeatedPatternGroups.forEach(({ indices, score }, groupIndex) => {
    for (const index of indices) {
      labeled[index] = {
        ...labeled[index],
        label: repeatLabel(groupIndex, "pattern"),
        labelConfidence: Math.round(Math.min(1, score) * 1000) / 1000,
      };
    }
  });
  if (vocalActivityIntervals.length > 0 && repeatedPatternGroups.length > 0) {
    repeatedPatternGroups.forEach(({ indices, score }, groupIndex) => {
      const masks = indices.map((index) => vocalActivityMask(labeled[index]!, beatGridMs, vocalActivityIntervals));
      if (masks.some((mask) => mask === null)) return;
      const reference = masks[0]!;
      const agreement = Math.min(...masks.slice(1).map((mask) => vocalMaskAgreement(reference, mask!)));
      // A repeated activity contour is additional evidence about arrangement, not
      // transcript similarity or a semantic chorus/verse decision.
      if (agreement < 0.9) return;
      for (const index of indices) {
        labeled[index] = {
          ...labeled[index],
          label: repeatLabel(groupIndex, "vocal-pattern"),
          labelConfidence: Math.round(Math.min(score, agreement) * 1000) / 1000,
        };
      }
    });
  }

  const rhythmOnlyIndices = eligibleIndices.filter((index) => !patternIndices.has(index) && rhythmSignatures[index]);
  const repeatedRhythmGroups = findCliqueGroups(rhythmSimilarities, rhythmOnlyIndices, MINIMUM_REPEAT_SIMILARITY);
  repeatedRhythmGroups.forEach(({ indices, score }, groupIndex) => {
    for (const index of indices) {
      labeled[index] = {
        ...labeled[index],
        label: repeatLabel(groupIndex, "rhythm"),
        labelConfidence: Math.round(Math.min(1, score) * 1000) / 1000,
      };
    }
  });

  return labeled;
}

/** Describes only sustained loudness changes between adjacent detected sections. */
export function labelSectionEnergyChanges(
  candidates: readonly SourceSectionCandidate[],
  beatGridMs: number[],
  pcm: Float32Array,
): SourceSectionCandidate[] {
  return candidates.map((candidate, index) => {
    if (index === 0 || candidate.label !== "section" || candidate.labelConfidence > 0) return { ...candidate };
    const changeDb = sectionEnergyChangeDb(candidates[index - 1], candidate, beatGridMs, pcm);
    if (changeDb === null || Math.abs(changeDb) < MINIMUM_SECTION_ENERGY_CHANGE_DB) return { ...candidate };
    return {
      ...candidate,
      label: changeDb > 0 ? "energy-rise" : "energy-drop",
      // This is normalized signal-change strength, not a probability of a
      // semantic role. The UI names it accordingly.
      labelConfidence: Math.round(Math.min(1, Math.abs(changeDb) / 6) * 1000) / 1000,
    };
  });
}
