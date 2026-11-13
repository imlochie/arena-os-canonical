/**
 * The mashup brain — song × song (vision: "Waveyard's main goal will always
 * be making mashups and extending songs").
 *
 * planMashup composes the app's EXISTING analysis primitives into a full,
 * explained decision: which tempo wins, how the vocal is stretched and
 * pitched, where it enters, and why every choice was made. renderMashup
 * turns the plan into real PCM using the elastic primitives (WSOLA stretch,
 * sinc pitch shift) — the same math the session layer uses.
 *
 * Authority rules (the user's, verbatim: "if my work is better to my ears
 * we keep that"): a plan is a PROPOSAL. Nothing here mutates a source, and
 * the render is stateless — the user's own arrangement is never touched.
 */

import { pitchShift, timeStretch } from "../elastic";
import type { StereoBuffer } from "../mixer/dsp";
import { keyCompatibility } from "../library/session-logic";
import { semitoneShift } from "../types/musical-key";
import { analysePcm, type AnalysisResult } from "../worker-local/analysis-engine";
import { trustedAnalysisBeatGrid, trustedAnalysisBpm, trustedAnalysisKey } from "../types/analysis-confidence";
import { comparePassageCompatibility, type PassageFingerprint, type PassageRollingWindow } from "../types/passage-compatibility";
import {
  HARMONY_TEMPLATE_MIN_MARGIN,
  harmonyPitchClasses,
  type HarmonyEvent,
} from "../types/harmony-analysis";
import type { VocalActivityInterval, VocalPhrase, VocalPitchFrame } from "../types/vocal-analysis";
import { currentEvidenceValue, type MusicalEvidencePacket } from "./musical-evidence";

export const MASHUP_PLANNER_ENGINE = "waveyard-mashup-planner-v7";
export const MASHUP_RENDER_ENGINE = "waveyard-mashup-render-v1";

export type MashupSection = {
  id?: string;
  label: string;
  startMs: number;
  endMs: number;
  startBeatIndex?: number;
  endBeatIndex?: number;
  passageFingerprint?: PassageFingerprint | null;
};

export type MashupTransientEvent = {
  timestampMs: number;
  strength: number;
  confidence: number;
};

export type MashupSourceProfile = {
  role: "vocals" | "instrumental";
  sourceAssetId?: string;
  sourceChecksumSha256?: string;
  bpm: number | null;
  bpmConfidence?: number | null;
  musicalKey: string | null;
  keyConfidence?: number | null;
  beatGridMs?: number[] | null;
  beatConfidence?: number | null;
  durationMs: number;
  sections: MashupSection[];
  stems?: Array<{ id: string; stemType: string }>;
  /** Checksum-current isolated-vocal phrase intervals; not lyric transcription. */
  vocalPhrases?: VocalPhrase[];
  /** Checksum-current coarse energy intervals from the isolated vocal stem; not words. */
  vocalActivityIntervals?: VocalActivityInterval[];
  /** Checksum-current monophonic pitch observations from the isolated vocal stem. */
  vocalPitchFrames?: VocalPitchFrame[];
  /** Checksum-current source-relative chord timeline. */
  harmonyEvents?: HarmonyEvent[];
  /** Identifies whether chord evidence came from an isolated bed stem or the full source mix. */
  harmonyEvidenceSource?: "separated-stem" | "source-mix";
  harmonyEvidenceStemType?: string;
  /** Measured from the current isolated bed stems; classes are intentionally absent. */
  drumEvents?: MashupTransientEvent[];
  /** Low-band attacks measured from the current isolated bass stem, not note labels. */
  bassEvents?: MashupTransientEvent[];
  /** Provenance/availability notes for transient evidence loaded by the route. */
  grooveWarnings?: string[];
  /** Canonical evidence snapshot; legacy flat fields remain for test fixtures and older callers. */
  evidence?: MusicalEvidencePacket;
};

export type MashupSegment = {
  /** Placement on the mashup (bed) timeline. */
  mashupStartMs: number;
  mashupEndMs: number;
  /** Span of the source audio this segment carries (before stretch). */
  vocalsFromMs: number;
  vocalsToMs: number;
  /** Trapezoid fade in/out on the segment (ms). */
  crossfadeMs: number;
  rationale: string;
  /** Stem role for multi-stem arrangement (defaults to "vocals"). */
  stemType?: string;
  sourceRole?: "vocals" | "instrumental";
};

/** Traceable evidence for one voiced unit's chosen bed placement. */
export type MashupArrangementPlacement = {
  /** Absolute donor source window this placement carries (before stretch). */
  donorFromMs: number;
  donorToMs: number;
  /** Absolute bed timeline position. */
  bedStartMs: number;
  /** Renormalised weighted score of the contributing channels. */
  unitScore: number;
  /** Measured vocal-to-bed chord-tone agreement, when computable. */
  vocalChordFit: number | null;
  chordFrames: number;
  /** Measured drum/bass onset overlap over the unit onsets, when available. */
  drumBassOnsetFit: number | null;
  /** Hypothesis from the bed section label at the placement; not ground truth. */
  bedSectionRole: "intro" | "body" | "climax" | "breakdown" | "outro" | "unlabeled";
  evidence: string[];
};

export type MashupArrangement = {
  engine: typeof MASHUP_PLANNER_ENGINE;
  /** continuous-overlay keeps the full vocal body contiguously; segmented assigns voiced units across the bed. */
  mode: "continuous-overlay" | "segmented";
  /** Which mode was selected for this plan. */
  selected: "continuous-overlay" | "segmented";
  /** Objective score of the segmented arrangement, in the shared per-unit space. */
  segmentedScore: number;
  /** Objective score of the continuous overlay starting at the chosen entry. */
  overlayScore: number;
  /** (segmented - overlay) / max(1, |overlay|); null when no arrangement evidence existed. */
  improvementRatio: number | null;
  unitsTotal: number;
  unitsPlaced: number;
  unitsSkipped: number;
  evidence: {
    chordTimeline: boolean;
    drumTransients: boolean;
    bassAttacks: boolean;
    beatGrid: boolean;
    sectionRoles: boolean;
  };
  rationale: string[];
  warnings: string[];
  placements: MashupArrangementPlacement[];
};

export type MashupPlan = {
  engine: typeof MASHUP_PLANNER_ENGINE;
  /** The bed's tempo — the instrumental always wins the tempo war. */
  masterBpm: number;
  /** timeStretch ratio for the vocal (output length / input length). */
  vocalsStretchRatio: number;
  /** Semitones to pitch the vocal into the bed's key. */
  vocalsPitchSemitones: number;
  keyRelationship: "same" | "fifth" | "relative" | "other" | "unknown";
  segments: MashupSegment[];
  /** Structured full-track arrangement decision when the passage search found no match. */
  arrangement?: MashupArrangement | null;
  /** Candidate evaluation per voice-bearing donor section, including its selected bed and full feasible ranking. */
  passageSearch?: MashupPassageSearch;
  durationMs: number;
  rationale: string[];
  warnings: string[];
};

export type MashupPassageSearch = {
  evaluatedDonorPassageCount: number;
  rankableDonorPassageCount: number;
  evaluations: Array<{
    donorSectionId: string;
    vocalSourceSha256: string | null;
    donorStartMs: number;
    donorEndMs: number;
    voicedPhraseCount: number;
      vocalIntervalKind?: "activity" | "pitch-continuity" | "combined";
    status: "ranked" | "no-candidate";
    selected: boolean;
    bestBedSectionId: string | null;
    bedStartMs: number | null;
    bedEndMs: number | null;
    plannedEntryMs: number | null;
    relativeScore: number | null;
    minimumFeatureConfidence: number | null;
    /** Full feasible bed ranking in the existing selection order; no scoring behavior changes. */
    rankedBedCandidates?: Array<{
      rank: number;
      bedSourceSha256: string | null;
      bedSectionId: string;
      bedStartMs: number;
      bedEndMs: number;
      plannedEntryMs: number;
      relativeScore: number;
      minimumFeatureConfidence: number;
      transientTiebreakScore: number;
      similarities: {
        duration: number;
        rhythm: number | null;
        harmony: number | null;
        beatPhase: number | null;
        vocalChordFit: number | null;
        vocalChordCoverage: number | null;
      };
      selected: boolean;
    }>;
    reason: string;
  }>;
  selectedDonorSectionId: string | null;
  selectedBedSectionId: string | null;
};

export type MashupPlanResult =
  | { ok: true; plan: MashupPlan }
  | { ok: false; reason: string };

const LOCK_TOLERANCE = 0.03;
const CROSSFADE_MS = 250;
/** Bed attenuation while vocals are active (the classic mashup pocket). */
const DUCK_DEPTH = 0.28;

function isIntro(label: string): boolean {
  return /intro/i.test(label);
}
function isOutro(label: string): boolean {
  return /outro/i.test(label);
}

/**
 * Stretch ratio that syncs a vocal at vocalBpm to a bed at bedBpm.
 * When the raw ratio is an essentially-exact double/half relationship
 * (±1%), the vocal stays at natural speed: a 140 BPM vocal over a 70 BPM
 * bed is already grid-consistent in double-time, and a 2× WSOLA stretch
 * would only degrade it. Anything else stretches to match the bed's tempo,
 * clamped to 0.5–2.
 */
export function warpRatioForTempos(vocalBpm: number, bedBpm: number): number {
  if (vocalBpm <= 0 || bedBpm <= 0) return 1;
  const raw = vocalBpm / bedBpm;
  if (Math.abs(raw - 1) <= 0.01) return 1;
  if (Math.abs(raw - 0.5) <= 0.01 || Math.abs(raw - 2) <= 0.01) return 1;
  return Math.min(2, Math.max(0.5, raw));
}

/**
 * Estimates a musically sensible tempo (BPM) from section timestamps or duration
 * when formal tempo analysis is missing. Sections give bar/phrase cadence; otherwise
 * common pop/electronic tempo ranges (100–128 BPM) guide duration-to-beat fitting.
 */
/**
 * Downsamples interleaved stereo 44.1 kHz PCM to mono 22.05 kHz for analysis.
 */
export function downsampleToAnalysisPcm(stereo44k: Float32Array): Float32Array {
  const frames44k = Math.floor(stereo44k.length / 2);
  const frames22k = Math.floor(frames44k / 2);
  const out = new Float32Array(frames22k);
  for (let i = 0; i < frames22k; i++) {
    const srcIndex = i * 4;
    out[i] = (stereo44k[srcIndex] + stereo44k[srcIndex + 1]) * 0.5;
  }
  return out;
}

/**
 * Runs native DSP musical analysis on stereo audio PCM when metadata is absent.
 */
export function analyseStereoPcm(stereo44k: Float32Array): AnalysisResult {
  const mono = downsampleToAnalysisPcm(stereo44k);
  return analysePcm(mono);
}

export function estimateFallbackTempo(profile: MashupSourceProfile): { bpm: number; confidence: number; source: "sections" | "default" } {
  if (profile.sections && profile.sections.length >= 2) {
    const intervals: number[] = [];
    for (let i = 0; i < profile.sections.length - 1; i++) {
      const diff = profile.sections[i + 1].startMs - profile.sections[i].startMs;
      if (diff > 2000 && diff < 60000) intervals.push(diff);
    }
    if (intervals.length > 0) {
      intervals.sort((a, b) => a - b);
      const medianMs = intervals[Math.floor(intervals.length / 2)];
      // Assume median section is roughly 8 or 16 bars (32 or 64 beats in 4/4)
      for (const beats of [32, 16, 64, 8]) {
        const candidateBpm = (beats * 60_000) / medianMs;
        if (candidateBpm >= 75 && candidateBpm <= 160) {
          // Section timing is phrase cadence, never verified beat timing. Set confidence to 0.0.
          return { bpm: Math.round(candidateBpm * 10) / 10, confidence: 0.0, source: "sections" };
        }
      }
    }
  }

  // Never invent a duration-derived BPM guess presented as musical synchronization.
  return { bpm: 120, confidence: 0.0, source: "default" };
}

/** The vocal's pitch move into the bed's key. Relative major/minor shares
 *  the same scale — the correct move is NO shift, not a tonic shift. */
export function pitchMoveForKeys(
  vocalKey: string | null,
  bedKey: string | null,
): { semitones: number; relationship: "same" | "fifth" | "relative" | "other" | "unknown" } {
  const compatibility = keyCompatibility(vocalKey, bedKey);
  if (!compatibility.compatible || compatibility.shiftSemitones === null) {
    if (compatibility.relationship === "unknown") return { semitones: 0, relationship: "unknown" };
    return { semitones: compatibility.shiftSemitones ?? 0, relationship: "other" };
  }
  if (compatibility.relationship === "relative") {
    return { semitones: 0, relationship: "relative" };
  }
  const shift = semitoneShift(vocalKey, bedKey) ?? 0;
  return { semitones: shift, relationship: compatibility.relationship };
}

/** First non-intro bed section = where vocals traditionally enter. */
function bedEntryMs(bed: MashupSourceProfile, barMs: number): { at: number; why: string } {
  const bodySections = bed.sections.filter((section) => !isIntro(section.label) && !isOutro(section.label));
  if (bodySections.length > 0) {
    const first = bodySections[0];
    return { at: Math.max(0, first.startMs), why: `vocals enter at the bed's first body section (“${first.label}” at ${(first.startMs / 1000).toFixed(1)}s)` };
  }
  if (bed.sections.length > 0) {
    return { at: 0, why: "the bed has no labeled body sections — vocals enter at the top" };
  }
  return { at: Math.round(barMs), why: "no section analysis for the bed — vocals enter after one bar" };
}

function alignBedEntryToMeasuredBeat(
  bed: MashupSourceProfile,
  requestedEntryMs: number,
  masterBpm: number,
): { at: number; why: string | null } {
  const grid = trustedAnalysisBeatGrid(bed.beatGridMs, bed.bpmConfidence, bed.beatConfidence);
  if (!grid || trustedAnalysisBpm(bed.bpm, bed.bpmConfidence) === null || !Number.isFinite(masterBpm) || masterBpm <= 0) {
    return { at: requestedEntryMs, why: null };
  }

  // A beat grid does not establish meter or downbeat phase. Align only to a
  // measured beat; do not call this a bar/downbeat without that evidence.
  const alignedMs = grid.find((beatMs) => beatMs >= requestedEntryMs - 20);
  if (alignedMs === undefined) return { at: requestedEntryMs, why: null };
  const roundedMs = Math.round(alignedMs);
  if (roundedMs < requestedEntryMs - 20 || roundedMs >= bed.durationMs) return { at: requestedEntryMs, why: null };
  return {
    at: roundedMs,
    why: `the padded vocal crop enters on a measured bed beat at ${(roundedMs / 1000).toFixed(2)}s`,
  };
}

function qualifiedVocalActivityIntervals(vocals: MashupSourceProfile): VocalActivityInterval[] {
  return (vocals.vocalActivityIntervals ?? [])
    .filter((interval) => Number.isSafeInteger(interval.startMs)
      && Number.isSafeInteger(interval.endMs)
      && interval.startMs >= 0
      && interval.endMs > interval.startMs
      && interval.endMs <= vocals.durationMs
      && Number.isFinite(interval.confidence)
      && interval.confidence >= 0.5
      && interval.confidence <= 1)
    .sort((left, right) => left.startMs - right.startMs);
}

function qualifiedVocalPitchRuns(
  vocals: MashupSourceProfile,
  body: { fromMs: number; toMs: number },
): VocalPhrase[] {
  return (vocals.vocalPhrases ?? [])
    .filter((phrase) => Number.isSafeInteger(phrase.startMs)
      && Number.isSafeInteger(phrase.endMs)
      && phrase.startMs >= body.fromMs
      && phrase.startMs < body.toMs
      && phrase.endMs > body.fromMs
      && phrase.endMs <= body.toMs
      && Number.isFinite(phrase.confidence)
      && phrase.confidence >= 0.5
      && phrase.confidence <= 1)
    .sort((left, right) => left.startMs - right.startMs);
}

function vocalTimingIntervals(
  vocals: MashupSourceProfile,
  body: { fromMs: number; toMs: number },
): {
  intervals: Array<VocalActivityInterval | VocalPhrase>;
  kind: "activity" | "pitch-continuity" | "combined";
} {
  const activity = qualifiedVocalActivityIntervals(vocals)
    .filter((interval) => interval.startMs < body.toMs && interval.endMs > body.fromMs)
    .map((interval) => ({
      ...interval,
      startMs: Math.max(body.fromMs, interval.startMs),
      endMs: Math.min(body.toMs, interval.endMs),
    }));
  const pitchRuns = qualifiedVocalPitchRuns(vocals, body);
  if (activity.length > 0 && pitchRuns.length > 0) {
    // Use precise pitch-continuity onsets where they exist, and retain coarse
    // activity-only intervals so unpitched vocals are not silently discarded.
    const unpitchedActivity = activity.filter((interval) =>
      !pitchRuns.some((phrase) => phrase.startMs < interval.endMs && phrase.endMs > interval.startMs));
    return {
      intervals: [...pitchRuns, ...unpitchedActivity].sort((left, right) => left.startMs - right.startMs),
      kind: "combined",
    };
  }
  if (activity.length > 0) return { intervals: activity, kind: "activity" };
  return { intervals: pitchRuns, kind: "pitch-continuity" };
}

/** Build a padded crop from current isolated-vocal energy or pitch evidence. */
function vocalBodySpan(vocals: MashupSourceProfile): {
  fromMs: number;
  toMs: number;
  why: string;
  vocalActivityEvidence: boolean;
} {
  const activityIntervals = qualifiedVocalActivityIntervals(vocals);
  if (activityIntervals.length > 0) {
    const from = activityIntervals[0]!.startMs;
    const to = activityIntervals.at(-1)!.endMs;
    return {
      fromMs: Math.max(0, from - 250),
      toMs: Math.min(vocals.durationMs, to + 250),
      why: `measured coarse vocal activity spans ${(from / 1000).toFixed(1)}s–${(to / 1000).toFixed(1)}s; a 250ms safety pad is kept on both ends`,
      vocalActivityEvidence: true,
    };
  }
  const phrases = qualifiedVocalPitchRuns(vocals, { fromMs: 0, toMs: vocals.durationMs });
  // Section labels are analyzer output, not human verse/chorus ground truth.
  // Include vocal activity in every measured section, including sections that
  // happen to carry an "intro" or "outro" label.
  const active = vocals.sections.filter((section) =>
    Number.isSafeInteger(section.startMs)
    && Number.isSafeInteger(section.endMs)
    && section.startMs >= 0
    && section.endMs > section.startMs);
  if (active.length > 0) {
    const sectionFrom = active[0].startMs;
    const sectionTo = Math.min(vocals.durationMs, active[active.length - 1].endMs);
    const bodyPhrases = phrases.filter((phrase) => phrase.startMs >= sectionFrom && phrase.endMs <= sectionTo);
    if (bodyPhrases.length > 0) {
      const from = bodyPhrases[0].startMs;
      const to = bodyPhrases[bodyPhrases.length - 1].endMs;
      const paddedFrom = Math.max(0, from - 250);
      const paddedTo = Math.min(vocals.durationMs, to + 250);
      return {
        fromMs: paddedFrom,
        toMs: paddedTo,
        why: `measured voiced activity spans ${(from / 1000).toFixed(1)}s–${(to / 1000).toFixed(1)}s; a 250ms safety pad is kept on both ends`,
        vocalActivityEvidence: true,
      };
    }
    return {
      fromMs: sectionFrom,
      toMs: sectionTo,
      why: `vocal body spans ${active.length} section${active.length === 1 ? "" : "s"} (${(sectionFrom / 1000).toFixed(1)}s–${(sectionTo / 1000).toFixed(1)}s)`,
      vocalActivityEvidence: false,
    };
  }
  if (phrases.length > 0) {
    const from = phrases[0].startMs;
    const to = phrases[phrases.length - 1].endMs;
    const paddedFrom = Math.max(0, from - 250);
    const paddedTo = Math.min(vocals.durationMs, to + 250);
    return {
      fromMs: paddedFrom,
      toMs: paddedTo,
      why: `measured voiced activity spans ${(from / 1000).toFixed(1)}s–${(to / 1000).toFixed(1)}s; a 250ms safety pad is kept on both ends`,
      vocalActivityEvidence: true,
    };
  }
  return {
    fromMs: 0,
    toMs: vocals.durationMs,
    why: "no current vocal activity or pitch timing — the full vocal source is used",
    vocalActivityEvidence: false,
  };
}

const GROOVE_MATCH_TOLERANCE_MS = 90;
const MIN_VOICE_RUNS_FOR_TRANSIENT_TIEBREAK = 3;
const PASSAGE_RANK_TIE_EPSILON = 0.005;

function nearestTransientScore(timestampMs: number, events: MashupTransientEvent[]): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle]!.timestampMs < timestampMs) low = middle + 1;
    else high = middle;
  }
  let best = 0;
  for (const index of [low - 1, low]) {
    const event = events[index];
    if (!event) continue;
    const distance = Math.abs(event.timestampMs - timestampMs);
    if (distance > GROOVE_MATCH_TOLERANCE_MS) continue;
    const confidence = Number.isFinite(event.confidence) ? Math.max(0, Math.min(1, event.confidence)) : 0;
    best = Math.max(best, confidence * (1 - distance / GROOVE_MATCH_TOLERANCE_MS));
  }
  return best;
}

function scoreEntryAgainstTransients(
  entryMs: number,
  vocalOnsetOffsetsMs: number[],
  stretchRatio: number,
  drumEvents: MashupTransientEvent[],
  bassEvents: MashupTransientEvent[],
): { score: number; drumMatches: number; bassMatches: number } {
  const availableSources = [drumEvents, bassEvents].filter((events) => events.length > 0);
  if (availableSources.length === 0 || vocalOnsetOffsetsMs.length === 0)
    return { score: 0, drumMatches: 0, bassMatches: 0 };

  let score = 0;
  let drumMatches = 0;
  let bassMatches = 0;
  for (const offsetMs of vocalOnsetOffsetsMs) {
    const targetMs = entryMs + offsetMs * stretchRatio;
    const drumScore = nearestTransientScore(targetMs, drumEvents);
    const bassScore = nearestTransientScore(targetMs, bassEvents);
    if (drumScore > 0) drumMatches += 1;
    if (bassScore > 0) bassMatches += 1;
    score += (drumScore + bassScore) / availableSources.length;
  }
  return {
    score: score / vocalOnsetOffsetsMs.length,
    drumMatches,
    bassMatches,
  };
}

function passageFeatureConfidence(
  fingerprint: PassageFingerprint,
  feature: "rhythm" | "chroma" | "beatPhase",
): number | null {
  const evidence = fingerprint[feature];
  if (evidence.status !== "measured" || evidence.confidence === null || !Number.isFinite(evidence.confidence)) return null;
  return Math.max(0, Math.min(1, evidence.confidence));
}

type VocalChordToneFit = {
  similarity: number;
  coverage: number;
  confidence: number;
  matchedFrames: number;
};

function lowerBoundPitchFrame(frames: readonly VocalPitchFrame[], timestampMs: number): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle]!.timestampMs < timestampMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function chordAt(events: readonly HarmonyEvent[], timestampMs: number): HarmonyEvent | null {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle]!.startMs <= timestampMs) low = middle + 1;
    else high = middle;
  }
  const event = events[low - 1];
  return event && timestampMs < event.endMs ? event : null;
}

/**
 * Compare measured isolated-vocal notes with the bed's current chord timeline
 * after the plan's pitch shift and local tempo mapping. This is a ranking cue,
 * not a dissonance classifier: passing tones and intentionally unresolved notes
 * are not declared wrong.
 */
export function scoreVocalChordToneFit(input: {
  vocalFrames: readonly VocalPitchFrame[] | undefined;
  bedChords: readonly HarmonyEvent[] | undefined;
  donorStartMs: number;
  donorEndMs: number;
  bedStartMs: number;
  bedEndMs: number;
  stretchRatio: number;
  pitchShiftSemitones: number;
}): VocalChordToneFit | null {
  const { vocalFrames, bedChords, donorStartMs, donorEndMs, bedStartMs, bedEndMs, stretchRatio, pitchShiftSemitones } = input;
  if (!vocalFrames?.length || !bedChords?.length
    || !Number.isSafeInteger(donorStartMs) || !Number.isSafeInteger(donorEndMs) || donorEndMs <= donorStartMs
    || !Number.isSafeInteger(bedStartMs) || !Number.isSafeInteger(bedEndMs) || bedEndMs <= bedStartMs
    || !Number.isFinite(stretchRatio) || stretchRatio <= 0
    || !Number.isInteger(pitchShiftSemitones)) return null;

  const selected: VocalPitchFrame[] = [];
  for (let index = lowerBoundPitchFrame(vocalFrames, donorStartMs);
    index < vocalFrames.length && vocalFrames[index]!.timestampMs < donorEndMs;
    index += 1) {
    const frame = vocalFrames[index]!;
    if (frame.voiced && frame.nearestMidiNote !== null && frame.confidence >= 0.6 && frame.confidence <= 1) selected.push(frame);
  }
  if (selected.length < 6) return null;

  let eligibleWeight = 0;
  let chordToneWeight = 0;
  let matchedFrames = 0;
  let matchedConfidenceWeight = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const frame = selected[index]!;
    const bedTime = bedStartMs + (frame.timestampMs - donorStartMs) * stretchRatio;
    if (bedTime >= bedEndMs) continue;
    const chord = chordAt(bedChords, bedTime);
    const chordPitchClasses = chord && chord.confidence >= HARMONY_TEMPLATE_MIN_MARGIN
      ? harmonyPitchClasses(chord)
      : null;
    if (!chord || !chordPitchClasses) continue;
    const weight = frame.confidence;
    const pitchClass = ((frame.nearestMidiNote! + pitchShiftSemitones) % 12 + 12) % 12;
    eligibleWeight += weight;
    if (chordPitchClasses.includes(pitchClass)) chordToneWeight += weight;
    matchedConfidenceWeight += weight;
    matchedFrames += 1;
  }

  const coverage = matchedFrames / selected.length;
  if (matchedFrames < 6 || coverage < 0.5 || eligibleWeight <= 0) return null;
  return {
    similarity: chordToneWeight / eligibleWeight,
    coverage,
    confidence: coverage * (matchedConfidenceWeight / matchedFrames),
    matchedFrames,
  };
}

function rankPassagePair(
  comparison: ReturnType<typeof comparePassageCompatibility>,
  donor: PassageFingerprint,
  bed: PassageFingerprint,
  donorBpm: number | null,
  bedBpm: number | null,
  tempoTrusted: boolean,
  vocalChordFit: VocalChordToneFit | null,
): {
  score: number;
  details: string[];
  minimumFeatureConfidence: number;
  similarities: {
    duration: number;
    rhythm: number | null;
    harmony: number | null;
    beatPhase: number | null;
    vocalChordFit: number | null;
    vocalChordCoverage: number | null;
  };
} | null {
  const dimensions = comparison.dimensions;
  if (dimensions.phraseAlignment.status !== "match" && dimensions.phraseAlignment.status !== "context") return null;
  const measuredFeatureConfidences = [
    Math.min(
      passageFeatureConfidence(donor, "rhythm") ?? 0,
      passageFeatureConfidence(bed, "rhythm") ?? 0,
    ),
    Math.min(
      passageFeatureConfidence(donor, "chroma") ?? 0,
      passageFeatureConfidence(bed, "chroma") ?? 0,
    ),
    Math.min(
      passageFeatureConfidence(donor, "beatPhase") ?? 0,
      passageFeatureConfidence(bed, "beatPhase") ?? 0,
    ),
  ];
  if (measuredFeatureConfidences.some((confidence) => confidence <= 0)) return null;
  const features: Array<{ label: string; score: number; weight: number }> = [];
  const addSimilarity = (
    label: string,
    similarity: number | null,
    confidence: number | null,
    weight: number,
  ) => {
    if (similarity === null || !Number.isFinite(similarity) || confidence === null || confidence <= 0) return;
    features.push({
      label,
      score: Math.max(0, Math.min(1, similarity)),
      weight: weight * confidence,
    });
  };
  addSimilarity("rhythm", dimensions.rhythm.similarity, Math.min(
    passageFeatureConfidence(donor, "rhythm") ?? 0,
    passageFeatureConfidence(bed, "rhythm") ?? 0,
  ), 0.32);
  addSimilarity("harmony", dimensions.harmony.similarity, Math.min(
    passageFeatureConfidence(donor, "chroma") ?? 0,
    passageFeatureConfidence(bed, "chroma") ?? 0,
  ), 0.32);
  addSimilarity("beat phase", dimensions.beatPhase.similarity, Math.min(
    passageFeatureConfidence(donor, "beatPhase") ?? 0,
    passageFeatureConfidence(bed, "beatPhase") ?? 0,
  ), 0.20);
  if (vocalChordFit) addSimilarity(
    "vocal chord-tone agreement",
    vocalChordFit.similarity,
    vocalChordFit.confidence,
    0.12,
  );

  const donorBeats = donor.endBeatIndex - donor.startBeatIndex;
  const bedBeats = bed.endBeatIndex - bed.startBeatIndex;
  if (donorBeats > 0 && bedBeats > 0 && dimensions.phraseAlignment.similarity !== null) {
    features.push({
      label: "duration similarity",
      score: dimensions.phraseAlignment.similarity,
      weight: 0.10,
    });
  }
  if (tempoTrusted && donorBpm && bedBpm && donorBpm > 0 && bedBpm > 0) {
    features.push({
      label: "tempo",
      score: Math.exp(-Math.abs(Math.log(donorBpm / bedBpm))),
      weight: 0.06,
    });
  }
  const musicalFeatures = features.filter((feature) => ["rhythm", "harmony", "beat phase"].includes(feature.label));
  if (musicalFeatures.length < 3) return null;
  const totalWeight = features.reduce((total, feature) => total + feature.weight, 0);
  const score = features.reduce((total, feature) => total + feature.score * feature.weight, 0) / totalWeight;
  const details = features.map((feature) => `${feature.label} similarity ${feature.score.toFixed(3)}`);
  if (vocalChordFit) {
    details.push(
      `placed vocal body: ${vocalChordFit.matchedFrames} voiced pitch frames covered ${Math.round(vocalChordFit.coverage * 100)}% by measured bed chords (not just the discovery window)`,
    );
  }
  return {
    score,
    details,
    minimumFeatureConfidence: Math.min(...measuredFeatureConfidences),
    similarities: {
      duration: dimensions.phraseAlignment.similarity ?? 0,
      rhythm: dimensions.rhythm.similarity,
      harmony: dimensions.harmony.similarity,
      beatPhase: dimensions.beatPhase.similarity,
      vocalChordFit: vocalChordFit?.similarity ?? null,
      vocalChordCoverage: vocalChordFit?.coverage ?? null,
    },
  };
}

function fingerprintForRollingWindow(
  fingerprint: PassageFingerprint,
  window: PassageRollingWindow,
): PassageFingerprint {
  return {
    ...fingerprint,
    startBeatIndex: window.startBeatIndex,
    endBeatIndex: window.endBeatIndex,
    rhythm: window.rhythm,
    chroma: window.chroma,
    beatPhase: window.beatPhase,
  };
}

function beatGridBoundaryMs(beatGrid: number[] | null | undefined, beatIndex: number): number | null {
  if (!beatGrid || beatIndex < 0 || beatIndex > beatGrid.length || !Number.isInteger(beatIndex)) return null;
  const exact = beatGrid[beatIndex];
  if (exact !== undefined && Number.isFinite(exact)) return exact;
  if (beatIndex !== beatGrid.length || beatGrid.length < 2) return null;
  const intervals = beatGrid.slice(1).map((time, index) => time - beatGrid[index]!)
    .filter((interval) => Number.isFinite(interval) && interval > 0)
    .sort((left, right) => left - right);
  return intervals.length ? beatGrid.at(-1)! + intervals[Math.floor(intervals.length / 2)]! : null;
}

function evenlySpaced<T>(values: readonly T[], maximum: number): T[] {
  if (values.length <= maximum) return [...values];
  if (maximum <= 1) return values.length ? [values[0]!] : [];
  return Array.from({ length: maximum }, (_, index) =>
    values[Math.round(index * (values.length - 1) / (maximum - 1))]!,
  );
}

function rankedPassageEntry(
  vocals: MashupSourceProfile,
  bed: MashupSourceProfile,
  body: ReturnType<typeof vocalBodySpan>,
  baselineEntryMs: number,
  masterBpm: number,
  stretchRatio: number,
  vocalPitchShiftSemitones: number,
): {
  match: { at: number; why: string; score: number; donorSectionId: string; bedSectionId: string } | null;
  reason: string;
  search: MashupPassageSearch;
} {
  const vocalPitchFrames = [...(vocals.vocalPitchFrames ?? [])]
    .filter((frame) => Number.isSafeInteger(frame.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const bedHarmonyEvents = [...(bed.harmonyEvents ?? [])]
    .filter((event) => Number.isSafeInteger(event.startMs)
      && Number.isSafeInteger(event.endMs)
      && event.startMs >= 0
      && event.endMs > event.startMs
      && Number.isFinite(event.confidence)
      && event.confidence >= 0
      && event.confidence <= 1)
    .sort((left, right) => left.startMs - right.startMs);
  const vocalTiming = vocalTimingIntervals(vocals, body);
  const vocalIntervals = vocalTiming.intervals;

  const donorBpm = typeof vocals.bpm === "number" && Number.isFinite(vocals.bpm) && vocals.bpm > 0
    ? vocals.bpm : null;
  const bedBpm = typeof bed.bpm === "number" && Number.isFinite(bed.bpm) && bed.bpm > 0
    ? bed.bpm : null;
  const comparisonDonorBpm = donorBpm ?? masterBpm;
  const comparisonBedBpm = bedBpm ?? masterBpm;
  const tempoTrusted = trustedAnalysisBpm(vocals.bpm, vocals.bpmConfidence) !== null
    && trustedAnalysisBpm(bed.bpm, bed.bpmConfidence) !== null;
  const donorKey = trustedAnalysisKey(vocals.musicalKey, vocals.keyConfidence);
  const bedKey = trustedAnalysisKey(bed.musicalKey, bed.keyConfidence);
  const expectedKeyShift = donorKey && bedKey ? semitoneShift(donorKey, bedKey) : null;
  const vocalSpanMs = Math.max(0, body.toMs - body.fromMs) * stretchRatio;
  const baselineVocalCoverageMs = Math.min(vocalSpanMs, Math.max(0, bed.durationMs - baselineEntryMs));

  // A rolling window discovers an offset, but that offset moves the entire
  // retained vocal body. Score the material we will actually place, rather
  // than letting four locally consonant seconds speak for the whole song.
  // Existing measured-chord coverage gates and ranking weights are unchanged.
  const placementChordFits = new Map<number, VocalChordToneFit | null>();
  const chordFitForPlacement = (entryMs: number): VocalChordToneFit | null => {
    if (placementChordFits.has(entryMs)) return placementChordFits.get(entryMs)!;
    const fit = scoreVocalChordToneFit({
      vocalFrames: vocalPitchFrames,
      bedChords: bedHarmonyEvents,
      donorStartMs: body.fromMs,
      donorEndMs: Math.min(body.toMs, Math.floor(body.fromMs + (bed.durationMs - entryMs) / stretchRatio)),
      bedStartMs: entryMs,
      bedEndMs: bed.durationMs,
      stretchRatio,
      pitchShiftSemitones: vocalPitchShiftSemitones,
    });
    // Cache offsets, not section-pair identities: many overlapping windows
    // propose exactly the same placement. Bound retention on very long songs.
    if (placementChordFits.size >= 1024) placementChordFits.delete(placementChordFits.keys().next().value!);
    placementChordFits.set(entryMs, fit);
    return fit;
  };
  const rankAtEntry = (
    comparison: ReturnType<typeof comparePassageCompatibility>,
    donorFingerprint: PassageFingerprint,
    bedFingerprint: PassageFingerprint,
    entryMs: number,
  ) => {
    const args = [comparison, donorFingerprint, bedFingerprint, donorBpm, bedBpm,
      tempoTrusted && stretchRatio >= 0.5 && stretchRatio <= 2] as const;
    const base = rankPassagePair(...args, null);
    if (!base) return null; // Do not scan a whole vocal for an unrankable pair.
    const fit = chordFitForPlacement(entryMs);
    return fit ? rankPassagePair(...args, fit) : base;
  };

  const bedPassages = bed.sections.filter((section) =>
    section.passageFingerprint
    && Number.isSafeInteger(section.startMs)
    && section.startMs >= 0
    && Number.isSafeInteger(section.endMs)
    && section.endMs > section.startMs);
  const donorPassages = vocals.sections
    .filter((section) => Number.isSafeInteger(section.startMs)
      && Number.isSafeInteger(section.endMs)
      && section.startMs >= 0
      && section.endMs > section.startMs)
    .map((section) => ({
      section,
      intervals: vocalIntervals.filter((interval) =>
        interval.startMs >= section.startMs && interval.startMs < section.endMs),
    }))
    .filter((passage) => passage.intervals.length > 0);

  const evaluations: MashupPassageSearch["evaluations"] = [];
  const candidates: Array<{
    at: number;
    why: string;
    musicalScore: number;
    minimumFeatureConfidence: number;
    similarities: {
      duration: number;
      rhythm: number | null;
      harmony: number | null;
      beatPhase: number | null;
      vocalChordFit: number | null;
      vocalChordCoverage: number | null;
    };
    transientScore: number;
    donorSectionId: string;
    bedSectionId: string;
    bedSourceSha256: string | null;
    bedStartMs: number;
    bedEndMs: number;
  }> = [];
  let phraseLengthMismatchCount = 0;
  let missingCoreEvidenceCount = 0;
  let contentLossCount = 0;
  let unplaceableEntryCount = 0;

  for (const donorPassage of donorPassages) {
    const { section: donorSection, intervals } = donorPassage;
    const donorSectionId = donorSection.id
      ?? `${vocals.sourceAssetId ?? "vocals"}:${donorSection.startBeatIndex ?? donorSection.startMs}`;
    const donorFingerprint = donorSection.passageFingerprint;
    if (!donorFingerprint) {
      evaluations.push({
        donorSectionId,
        vocalSourceSha256: vocals.sourceChecksumSha256 ?? null,
        donorStartMs: donorSection.startMs,
        donorEndMs: donorSection.endMs,
        voicedPhraseCount: intervals.length,
        vocalIntervalKind: vocalTiming.kind,
        status: "no-candidate",
        selected: false,
        bestBedSectionId: null,
        bedStartMs: null,
        bedEndMs: null,
        plannedEntryMs: null,
        relativeScore: null,
        minimumFeatureConfidence: null,
        rankedBedCandidates: [],
        reason: "this voice-bearing donor section has no current checksum-bound passage fingerprint",
      });
      continue;
    }

    const sectionCandidates: typeof candidates = [];
    let passagePairCount = 0;
    let sectionPhraseLengthMismatchCount = 0;
    let sectionMissingCoreEvidenceCount = 0;
    let sectionContentLossCount = 0;
    let sectionUnplaceableEntryCount = 0;
    for (const bedSection of bedPassages) {
      if (!bedSection.passageFingerprint
        || bedSection.endMs <= bedSection.startMs) continue;
      const donorRollingWindows = donorFingerprint.rollingWindows?.status === "measured"
        ? donorFingerprint.rollingWindows.value
        : [];
      const bedRollingWindows = bedSection.passageFingerprint.rollingWindows?.status === "measured"
        ? bedSection.passageFingerprint.rollingWindows.value
        : [];
      if (donorRollingWindows.length && bedRollingWindows.length && vocals.beatGridMs && bed.beatGridMs) {
        const localWindowCandidates: typeof candidates = [];
        let localPairCount = 0;
        const voicedDonorWindows = donorRollingWindows.filter((window) => {
          const startMs = beatGridBoundaryMs(vocals.beatGridMs, window.startBeatIndex);
          const endMs = beatGridBoundaryMs(vocals.beatGridMs, window.endBeatIndex);
          return startMs !== null && endMs !== null
            && intervals.some((interval) => interval.startMs < endMs && interval.endMs > startMs);
        });
        const searchDonorWindows = evenlySpaced(voicedDonorWindows, 128);
        const searchBedWindows = evenlySpaced(bedRollingWindows, 128);
        for (const donorWindow of searchDonorWindows) {
          const donorWindowStartMs = beatGridBoundaryMs(vocals.beatGridMs, donorWindow.startBeatIndex);
          const donorWindowEndMs = beatGridBoundaryMs(vocals.beatGridMs, donorWindow.endBeatIndex);
          if (donorWindowStartMs === null || donorWindowEndMs === null) continue;
          const localDonorFingerprint = fingerprintForRollingWindow(donorFingerprint, donorWindow);
          for (const bedWindow of searchBedWindows) {
            if (localPairCount >= 16_384) break;
            const bedWindowStartMs = beatGridBoundaryMs(bed.beatGridMs, bedWindow.startBeatIndex);
            const bedWindowEndMs = beatGridBoundaryMs(bed.beatGridMs, bedWindow.endBeatIndex);
            if (bedWindowStartMs === null || bedWindowEndMs === null
              || bedWindowStartMs < bedSection.startMs || bedWindowEndMs > bedSection.endMs) continue;
            localPairCount += 1;
            const localBedFingerprint = fingerprintForRollingWindow(bedSection.passageFingerprint, bedWindow);
            const comparison = comparePassageCompatibility({
              anchorSectionId: bedSection.id ?? `${bed.sourceAssetId ?? "bed"}:${bedWindow.startBeatIndex}`,
              donorSectionId,
              anchor: localBedFingerprint,
              donor: localDonorFingerprint,
              anchorBpm: comparisonBedBpm,
              donorBpm: comparisonDonorBpm,
              anchorBeatConfidence: bed.beatConfidence ?? 0,
              donorBeatConfidence: vocals.beatConfidence ?? 0,
              anchorKeyTrusted: bedKey !== null,
              donorKeyTrusted: donorKey !== null,
              expectedKeyShift,
            });
            const donorWindowOffsetMs = (donorWindowStartMs - body.fromMs) * stretchRatio;
            const entryMs = Math.round(bedWindowStartMs - donorWindowOffsetMs);
            if (entryMs < 0) {
              unplaceableEntryCount += 1;
              sectionUnplaceableEntryCount += 1;
              continue;
            }
            const candidateCoverageMs = Math.min(vocalSpanMs, Math.max(0, bed.durationMs - entryMs));
            if (candidateCoverageMs < baselineVocalCoverageMs - 1) {
              contentLossCount += 1;
              sectionContentLossCount += 1;
              continue;
            }
            const ranking = rankAtEntry(
              comparison,
              localDonorFingerprint,
              localBedFingerprint,
              entryMs,
            );
            if (!ranking) continue;
            const onsetOffsets = intervals.map((interval) => interval.startMs - body.fromMs);
            const transientScore = onsetOffsets.length >= MIN_VOICE_RUNS_FOR_TRANSIENT_TIEBREAK
              ? scoreEntryAgainstTransients(entryMs, onsetOffsets, stretchRatio, bed.drumEvents ?? [], bed.bassEvents ?? []).score
              : 0;
            const comparisonSummary = [
              comparison.dimensions.phraseAlignment.detail,
              comparison.dimensions.rhythm.detail,
              comparison.dimensions.harmony.detail,
              comparison.dimensions.beatPhase.detail,
            ].join("; ");
            localWindowCandidates.push({
              at: entryMs,
              why: `aligned an eight-beat local voiced-activity window (${donorWindowStartMs}–${donorWindowEndMs}ms) with bed window ${bedWindowStartMs}–${bedWindowEndMs}ms inside section ${bedSection.id ?? bedSection.startMs}; full donor vocal coverage is retained; this is structural/audio-feature matching, not lyric timing or a semantic phrase label; relative score ${ranking.score.toFixed(3)} (${ranking.details.join(", ")}); ${comparisonSummary}; transient alignment only breaks near-ties`,
              musicalScore: ranking.score,
              minimumFeatureConfidence: ranking.minimumFeatureConfidence,
              similarities: ranking.similarities,
              transientScore,
              donorSectionId,
              bedSectionId: bedSection.id ?? `${bed.sourceAssetId ?? "bed"}:${bedSection.startMs}`,
              bedSourceSha256: bedSection.passageFingerprint.sourceChecksumSha256 ?? null,
              bedStartMs: bedWindowStartMs,
              bedEndMs: bedWindowEndMs,
            });
          }
          if (localPairCount >= 16_384) break;
        }
        if (localWindowCandidates.length) {
          passagePairCount += localPairCount;
          sectionCandidates.push(...localWindowCandidates
            .sort((left, right) => right.musicalScore - left.musicalScore || right.transientScore - left.transientScore || left.at - right.at)
            .slice(0, 8));
          continue;
        }
      }
      passagePairCount += 1;
      const comparison = comparePassageCompatibility({
        anchorSectionId: bedSection.id ?? `${bed.sourceAssetId ?? "bed"}:${bedSection.startBeatIndex ?? bedSection.startMs}`,
        donorSectionId,
        anchor: bedSection.passageFingerprint,
        donor: donorFingerprint,
        anchorBpm: comparisonBedBpm,
        donorBpm: comparisonDonorBpm,
        anchorBeatConfidence: bed.beatConfidence ?? 0,
        donorBeatConfidence: vocals.beatConfidence ?? 0,
        anchorKeyTrusted: bedKey !== null,
        donorKeyTrusted: donorKey !== null,
        expectedKeyShift,
      });
      // Align this whole-track offset to the bed passage, so later verses/hooks
      // are evaluated without discarding the vocal material before them.
      const donorPassageOffsetMs = (donorSection.startMs - body.fromMs) * stretchRatio;
      const entryMs = Math.round(bedSection.startMs - donorPassageOffsetMs);
      if (entryMs < 0) {
        unplaceableEntryCount += 1;
        sectionUnplaceableEntryCount += 1;
        continue;
      }
      const candidateCoverageMs = Math.min(vocalSpanMs, Math.max(0, bed.durationMs - entryMs));
      if (candidateCoverageMs < baselineVocalCoverageMs - 1) {
        contentLossCount += 1;
        sectionContentLossCount += 1;
        continue;
      }
      const ranking = rankAtEntry(
        comparison,
        donorFingerprint,
        bedSection.passageFingerprint,
        entryMs,
      );
      if (!ranking) {
        if (comparison.dimensions.phraseAlignment.status === "conflict") {
          phraseLengthMismatchCount += 1;
          sectionPhraseLengthMismatchCount += 1;
        } else {
          missingCoreEvidenceCount += 1;
          sectionMissingCoreEvidenceCount += 1;
        }
        continue;
      }

      const onsetOffsets = intervals.map((interval) => interval.startMs - body.fromMs);
      const transientScore = onsetOffsets.length >= MIN_VOICE_RUNS_FOR_TRANSIENT_TIEBREAK
        ? scoreEntryAgainstTransients(entryMs, onsetOffsets, stretchRatio, bed.drumEvents ?? [], bed.bassEvents ?? []).score
        : 0;
      const comparisonSummary = [
        comparison.dimensions.phraseAlignment.detail,
        comparison.dimensions.rhythm.detail,
        comparison.dimensions.harmony.detail,
        comparison.dimensions.beatPhase.detail,
      ].join("; ");
      sectionCandidates.push({
        at: entryMs,
        why: `aligned voice-bearing donor section ${donorSectionId} (${donorSection.startMs}–${donorSection.endMs}ms, ${intervals.length} ${vocalTiming.kind === "activity"
          ? "coarse activity intervals"
          : vocalTiming.kind === "pitch-continuity" ? "pitch-continuity runs" : "combined activity intervals and pitch-continuity runs"}) with bed section ${bedSection.id ?? bedSection.startMs} (${bedSection.startMs}–${bedSection.endMs}ms); whole vocal material is retained; relative score ${ranking.score.toFixed(3)} (${ranking.details.join(", ")}); ${comparisonSummary}; transient alignment only breaks near-ties`,
        musicalScore: ranking.score,
        minimumFeatureConfidence: ranking.minimumFeatureConfidence,
        similarities: ranking.similarities,
        transientScore,
        donorSectionId,
        bedSectionId: bedSection.id ?? `${bed.sourceAssetId ?? "bed"}:${bedSection.startMs}`,
        bedSourceSha256: bedSection.passageFingerprint.sourceChecksumSha256 ?? null,
        bedStartMs: bedSection.startMs,
        bedEndMs: bedSection.endMs,
      });
    }

    const scoreSorted = sectionCandidates.sort((left, right) =>
      right.musicalScore - left.musicalScore || left.at - right.at,
    );
    const highestMusicalScore = scoreSorted[0]?.musicalScore;
    const best = highestMusicalScore === undefined
      ? undefined
      : scoreSorted
        .filter((candidate) => highestMusicalScore - candidate.musicalScore <= PASSAGE_RANK_TIE_EPSILON)
        .sort((left, right) => right.transientScore - left.transientScore || left.at - right.at)[0];
    if (best) candidates.push(best);
    const rankedCandidates = best
      ? [best, ...scoreSorted.filter((candidate) => candidate !== best)]
      : scoreSorted;
    evaluations.push({
      donorSectionId,
      vocalSourceSha256: donorFingerprint.sourceChecksumSha256 ?? null,
      donorStartMs: donorSection.startMs,
      donorEndMs: donorSection.endMs,
      voicedPhraseCount: intervals.length,
      vocalIntervalKind: vocalTiming.kind,
      status: best ? "ranked" : "no-candidate",
      selected: false,
      bestBedSectionId: best?.bedSectionId ?? null,
      bedStartMs: best?.bedStartMs ?? null,
      bedEndMs: best?.bedEndMs ?? null,
      plannedEntryMs: best?.at ?? null,
      relativeScore: best?.musicalScore ?? null,
      minimumFeatureConfidence: best?.minimumFeatureConfidence ?? null,
      rankedBedCandidates: rankedCandidates.map((candidate, index) => ({
        rank: index + 1,
        bedSourceSha256: candidate.bedSourceSha256,
        bedSectionId: candidate.bedSectionId,
        bedStartMs: candidate.bedStartMs,
        bedEndMs: candidate.bedEndMs,
        plannedEntryMs: candidate.at,
        relativeScore: candidate.musicalScore,
        minimumFeatureConfidence: candidate.minimumFeatureConfidence,
        transientTiebreakScore: candidate.transientScore,
        similarities: candidate.similarities,
        selected: candidate === best,
      })),
      reason: best
        ? `${passagePairCount} bed passage pairs evaluated; best candidate scored ${best.musicalScore.toFixed(3)}`
        : passagePairCount === 0
          ? "no current checksum-bound bed passage fingerprints are available"
        : sectionUnplaceableEntryCount > 0 && sectionContentLossCount === 0
          ? "matching bed sections occur too early to place the complete donor vocal body"
          : sectionContentLossCount > 0 && sectionPhraseLengthMismatchCount === 0 && sectionMissingCoreEvidenceCount === 0
            ? "all structurally ranked entries would reduce vocal coverage compared with the safe fallback"
            : sectionPhraseLengthMismatchCount > 0 && sectionMissingCoreEvidenceCount === 0
              ? "no whole-bar passage pair could be compared across measured bed passages"
              : "no bed passage pair had comparable whole-bar durations and all three measured rhythm, harmony, and beat-phase inputs",
    });
  }

  const scoreSorted = candidates.sort((left, right) =>
    right.musicalScore - left.musicalScore || left.at - right.at,
  );
  const highestMusicalScore = scoreSorted[0]?.musicalScore;
  const best = highestMusicalScore === undefined
    ? undefined
    : scoreSorted
      .filter((candidate) => highestMusicalScore - candidate.musicalScore <= PASSAGE_RANK_TIE_EPSILON)
      .sort((left, right) => right.transientScore - left.transientScore || left.at - right.at)[0];
  const selectedEvaluation = best
    ? evaluations.find((evaluation) => evaluation.donorSectionId === best.donorSectionId)
    : undefined;
  if (selectedEvaluation) selectedEvaluation.selected = true;

  const search: MashupPassageSearch = {
    evaluatedDonorPassageCount: donorPassages.length,
    rankableDonorPassageCount: evaluations.filter((evaluation) => evaluation.status === "ranked").length,
    evaluations,
    selectedDonorSectionId: best?.donorSectionId ?? null,
    selectedBedSectionId: best?.bedSectionId ?? null,
  };
  const reason = !vocalIntervals.length
    ? "no confidence-qualified vocal activity or pitch runs are available for passage evaluation"
    : !donorPassages.length
      ? "no source section contains a confidence-qualified vocal activity or pitch run"
      : best
        ? `${search.rankableDonorPassageCount} of ${search.evaluatedDonorPassageCount} voice-bearing donor sections had a candidate; the best relative score was ${best.musicalScore.toFixed(3)}`
        : evaluations.some((evaluation) => evaluation.reason.includes("no current checksum-bound bed"))
          ? "no checksum-current bed passage fingerprints are available"
          : unplaceableEntryCount > 0 && contentLossCount === 0
            ? "matching bed sections occur too early to place the complete donor vocal body"
          : contentLossCount > 0 && phraseLengthMismatchCount === 0 && missingCoreEvidenceCount === 0
            ? "all ranked passage entries would reduce vocal coverage compared with the safe fallback"
            : phraseLengthMismatchCount > 0 && missingCoreEvidenceCount === 0
              ? "no voice-bearing donor passage had a whole-bar bed window with measured evidence"
              : "no voice-bearing donor passage pair had comparable whole-bar durations plus measured rhythm, harmony, and beat-phase evidence";
  return {
    match: best
      ? { at: best.at, why: best.why, score: best.musicalScore, donorSectionId: best.donorSectionId, bedSectionId: best.bedSectionId }
      : null,
    reason,
    search,
  };
}

// ------------------------------------------------------------------
// Full-track arrangement — the arrangement decision must use the whole
// recording, not only the opening passage or a single global offset. The
// optimizer combines only evidence the app already persists: voiced
// activity/pitch intervals from the isolated vocal stem, the bed's measured
// chord timeline, measured bed drum/bass onsets, the bed's beat grid, and
// the bed's unverified section-role labels. No new analysis system and no
// semantic (verse/chorus/lyric) claims are introduced.
//
// Voiced material is merged into units separated by at least
// ARRANGEMENT_UNIT_MERGE_GAP_MS of silence. Unit ORDER IS ALWAYS PRESERVED,
// units are never reordered, duplicated or cropped, and the renderer
// receives ordinary segments — the save/reopen/edit/restore/export paths are
// unchanged. The segmented plan is selected only when it beats the
// continuous overlay on the shared per-unit objective by a clear margin;
// otherwise the overlay is kept and the comparison is recorded in the plan.
// ------------------------------------------------------------------

const ARRANGEMENT_MAX_UNITS = 120;
const ARRANGEMENT_UNIT_MERGE_GAP_MS = 750;
const ARRANGEMENT_MIN_UNIT_MS = 150;
const ARRANGEMENT_MAX_SLOTS = 600;

type ArrangementUnit = {
  fromMs: number;
  toMs: number;
  /** Bounded unit-relative onset points used only for transient fitting. */
  onsetOffsetsMs: number[];
};

export function mergedArrangementUnits(
  vocals: MashupSourceProfile,
  body: { fromMs: number; toMs: number },
): ArrangementUnit[] {
  const timing = vocalTimingIntervals(vocals, body);
  const ordered = [...timing.intervals]
    .map((interval) => ({
      startMs: Math.max(body.fromMs, interval.startMs),
      endMs: Math.min(body.toMs, interval.endMs),
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  if (ordered.length === 0) return [];
  const merged: Array<{ fromMs: number; toMs: number; onsetOffsetsMs: number[] }> = [];
  for (const interval of ordered) {
    const last = merged[merged.length - 1];
    if (last && interval.startMs - last.toMs <= ARRANGEMENT_UNIT_MERGE_GAP_MS) {
      last.toMs = Math.max(last.toMs, interval.endMs);
    } else {
      merged.push({ fromMs: interval.startMs, toMs: interval.endMs, onsetOffsetsMs: [] });
    }
  }
  for (const interval of ordered) {
    // Linear scan is fine: the unit list is already merged and ordered.
    const unit = merged.find((candidate) => interval.startMs >= candidate.fromMs && interval.startMs < candidate.toMs);
    if (!unit) continue;
    const relative = Math.round(interval.startMs - unit.fromMs);
    if (!unit.onsetOffsetsMs.includes(relative) && unit.onsetOffsetsMs.length < 8) {
      unit.onsetOffsetsMs.push(relative);
    }
  }
  // Bound the scoring matrix by repeatedly merging the smallest-gap neighbours.
  while (merged.length > ARRANGEMENT_MAX_UNITS) {
    let minGap = Number.POSITIVE_INFINITY;
    let mergeAt = -1;
    for (let index = 0; index < merged.length - 1; index += 1) {
      const gap = merged[index + 1]!.fromMs - merged[index]!.toMs;
      if (gap < minGap) { minGap = gap; mergeAt = index; }
    }
    if (mergeAt < 0) break;
    merged[mergeAt]!.toMs = merged[mergeAt + 1]!.toMs;
    merged[mergeAt]!.onsetOffsetsMs = [0];
    merged.splice(mergeAt + 1, 1);
  }
  return merged
    .map((unit) => ({ ...unit, onsetOffsetsMs: unit.onsetOffsetsMs.length ? unit.onsetOffsetsMs : [0] }))
    .filter((unit) => unit.toMs - unit.fromMs >= ARRANGEMENT_MIN_UNIT_MS);
}

type ArrangementBedContext = {
  harmonyEvents: HarmonyEvent[];
  drumEvents: MashupTransientEvent[];
  bassEvents: MashupTransientEvent[];
  sections: MashupSection[];
  durationMs: number;
  barMs: number;
  stretchRatio: number;
  pitchShiftSemitones: number;
  vocalPitchFrames: readonly VocalPitchFrame[];
};

type ArrangementFeatureScore = {
  score: number;
  vocalChordFit: number | null;
  chordFrames: number;
  drumBassOnsetFit: number | null;
  bedSectionRole: MashupArrangementPlacement["bedSectionRole"];
  evidence: string[];
};

function bedSectionRoleAt(
  sections: MashupSection[],
  timeMs: number,
): MashupArrangementPlacement["bedSectionRole"] {
  const section = sections.find((candidate) =>
    Number.isSafeInteger(candidate.startMs) && Number.isSafeInteger(candidate.endMs)
    && timeMs >= candidate.startMs && timeMs < candidate.endMs);
  if (!section) return "unlabeled";
  const label = section.label.toLowerCase();
  if (/intro/.test(label)) return "intro";
  if (/outro|fade/.test(label)) return "outro";
  if (/breakdown|break|instrumental|solo/.test(label)) return "breakdown";
  if (/verse|chorus|pre-?chorus|post-?chorus|refrain|hook|bridge/.test(label)) return "climax";
  return "unlabeled";
}

const ARRANGEMENT_ROLE_SCORE: Record<MashupArrangementPlacement["bedSectionRole"], number> = {
  intro: 0.35,
  unlabeled: 0.62,
  breakdown: 0.55,
  climax: 0.85,
  body: 0.75,
  outro: 0.4,
};

function arrangementSlotEvidence(bed: MashupSourceProfile): { slots: number[]; gridTrusted: boolean } {
  const grid = trustedAnalysisBeatGrid(bed.beatGridMs, bed.bpmConfidence, bed.beatConfidence);
  if (grid && grid.length >= 8) {
    let slots = grid.filter((beat) => Number.isFinite(beat) && beat >= 0 && beat <= bed.durationMs);
    if (slots.length > ARRANGEMENT_MAX_SLOTS) slots = evenlySpaced(slots, ARRANGEMENT_MAX_SLOTS);
    if (slots.length >= 3) return { slots, gridTrusted: true };
  }
  const boundaries = [...new Set(
    bed.sections.flatMap((section) => [section.startMs, section.endMs]),
  )]
    .filter((timeMs) => Number.isSafeInteger(timeMs) && timeMs >= 0 && timeMs <= bed.durationMs)
    .sort((left, right) => left - right);
  if (boundaries.length >= 3 && boundaries.length <= ARRANGEMENT_MAX_SLOTS) {
    return { slots: boundaries, gridTrusted: false };
  }
  const ticks: number[] = [];
  for (let timeMs = 0; timeMs <= bed.durationMs; timeMs += 2_000) ticks.push(timeMs);
  if (ticks[ticks.length - 1] !== bed.durationMs) ticks.push(bed.durationMs);
  return { slots: ticks, gridTrusted: false };
}

function arrangementFeatureScore(
  unit: ArrangementUnit,
  bedStartMs: number,
  context: ArrangementBedContext,
): ArrangementFeatureScore {
  const unitSpanStretchedMs = (unit.toMs - unit.fromMs) * context.stretchRatio;
  const bedEndMs = Math.min(context.durationMs, bedStartMs + unitSpanStretchedMs);
  const chord = context.harmonyEvents.length > 0
    ? scoreVocalChordToneFit({
      vocalFrames: context.vocalPitchFrames,
      bedChords: context.harmonyEvents,
      donorStartMs: unit.fromMs,
      donorEndMs: unit.toMs,
      bedStartMs,
      bedEndMs,
      stretchRatio: context.stretchRatio,
      pitchShiftSemitones: context.pitchShiftSemitones,
    })
    : null;
  const transient = context.drumEvents.length > 0 || context.bassEvents.length > 0
    ? scoreEntryAgainstTransients(
      bedStartMs,
      unit.onsetOffsetsMs,
      context.stretchRatio,
      context.drumEvents,
      context.bassEvents,
    ).score
    : null;
  const bedSectionRole = bedSectionRoleAt(context.sections, bedStartMs);
  const roleScore = ARRANGEMENT_ROLE_SCORE[bedSectionRole];

  const channels: Array<{ score: number; weight: number; label: string }> = [];
  if (chord) {
    channels.push({
      score: chord.similarity,
      weight: 0.5,
      label: `vocal-to-bed chord-tone agreement ${(chord.similarity * 100).toFixed(0)}% across ${chord.matchedFrames} voiced frames`,
    });
  }
  if (transient !== null) {
    channels.push({
      score: Math.max(0, Math.min(1, transient)),
      weight: 0.35,
      label: `drum/bass onset overlap ${(transient * 100).toFixed(0)}% over ${unit.onsetOffsetsMs.length} voiced onset(s)`,
    });
  }
  channels.push({ score: roleScore, weight: 0.15, label: `bed section role hypothesis (${bedSectionRole}) — not a semantic label` });
  const totalWeight = channels.reduce((total, channel) => total + channel.weight, 0);
  const score = channels.reduce((total, channel) => total + channel.score * channel.weight, 0) / totalWeight;
  return {
    score,
    vocalChordFit: chord?.similarity ?? null,
    chordFrames: chord?.matchedFrames ?? 0,
    drumBassOnsetFit: transient === null ? null : Math.max(0, Math.min(1, transient)),
    bedSectionRole,
    evidence: channels.map((channel) => channel.label),
  };
}

function arrangementSlotIndex(slots: number[], timeMs: number): number {
  let low = 0;
  let high = slots.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (slots[middle]! < timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function arrangementGapPenalty(gapMs: number, barMs: number): number {
  if (gapMs <= 1_500) return 0;
  const bars = gapMs / Math.max(1, barMs);
  return Math.min(0.6, bars * 0.03);
}

type ArrangementSolution = {
  /** Bed slot index per unit, in unit order; slots[i] === -1 means the unit was dropped. */
  slotIndices: number[];
  total: number;
};

/**
 * Monotone assignment of voiced units to bed slots, maximising the shared
 * per-unit objective with a small penalty for long instrumental gaps. Units
 * are never reordered. A unit may be dropped (value 0) only when no feasible
 * placement exists before the end of the bed.
 */
function solveArrangementMonotonic(
  units: Array<{ unit: ArrangementUnit; spanStretchedMs: number }>,
  slots: number[],
  scores: Float64Array[],
  bedDurationMs: number,
  barMs: number,
): ArrangementSolution {
  const unitCount = units.length;
  const slotCount = slots.length;
  const negative = Number.NEGATIVE_INFINITY;
  const dp: Float64Array[] = Array.from({ length: unitCount + 1 }, () => new Float64Array(slotCount).fill(0));
  const globalBest: Float64Array = new Float64Array(unitCount + 1).fill(0);
  const globalBestSlot: Int32Array = new Int32Array(unitCount + 1).fill(-1);
  const choice: Int32Array[] = Array.from({ length: unitCount }, () => new Int32Array(slotCount).fill(-2));
  globalBest[unitCount] = 0;
  for (let i = unitCount - 1; i >= 0; i -= 1) {
    const { spanStretchedMs } = units[i]!;
    let rowBest = negative;
    let rowBestSlot = -1;
    for (let j = 0; j < slotCount; j += 1) {
      const base = scores[i]![j];
      const startMs = slots[j]!;
      const endMs = startMs + spanStretchedMs;
      let placeValue = negative;
      let placeChoice = -1;
      if (Number.isFinite(base) && endMs <= bedDurationMs + 1) {
        if (i === unitCount - 1) {
          // The final placed unit has no successor: "end of chain" is a valid,
          // penalty-free continuation of the sequence.
          placeValue = base;
          placeChoice = -1;
        } else {
          const nextStart = arrangementSlotIndex(slots, endMs);
          let best = negative;
          let bestK = -1;
          for (let k = nextStart; k < slotCount; k += 1) {
            const candidate = dp[i + 1]![k]!;
            if (candidate === negative) continue;
            const value = candidate - arrangementGapPenalty(Math.max(0, slots[k]! - endMs), barMs);
            if (value > best) { best = value; bestK = k; }
          }
          placeValue = base + (best === negative ? 0 : best);
          placeChoice = bestK;
        }
      }
      const skipValue = globalBest[i + 1]!;
      if (placeValue >= skipValue) {
        dp[i]![j] = placeValue;
        choice[i]![j] = placeChoice;
      } else {
        dp[i]![j] = skipValue;
        choice[i]![j] = -2; // skip this unit
      }
      if (dp[i]![j]! > rowBest) { rowBest = dp[i]![j]!; rowBestSlot = j; }
    }
    globalBest[i] = rowBest;
    globalBestSlot[i] = rowBestSlot;
  }
  const slotIndices: number[] = [];
  let cursor = globalBestSlot[0]!;
  for (let i = 0; i < unitCount; i += 1) {
    if (cursor < 0) { slotIndices.push(-1); continue; }
    const move = choice[i]![cursor]!;
    if (move === -2) { slotIndices.push(-1); cursor = globalBestSlot[i + 1]!; continue; }
    slotIndices.push(cursor);
    cursor = move;
  }
  return { slotIndices, total: globalBest[0]! };
}

function sanitizeTransientEvents(events: MashupTransientEvent[] | undefined): MashupTransientEvent[] {
  return (events ?? [])
    .filter((event) => Number.isSafeInteger(event.timestampMs) && event.timestampMs >= 0
      && Number.isFinite(event.confidence) && event.confidence > 0 && event.confidence <= 1
      && Number.isFinite(event.strength) && event.strength >= 0 && event.strength <= 1)
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

function planArrangement(
  vocals: MashupSourceProfile,
  bed: MashupSourceProfile,
  body: { fromMs: number; toMs: number },
  overlayEntryMs: number,
  masterBpm: number,
  stretchRatio: number,
  vocalPitchShiftSemitones: number,
): MashupArrangement | null {
  const unitTimings = mergedArrangementUnits(vocals, body);
  if (unitTimings.length === 0) return null;
  const barMs = (60_000 / Math.max(1, masterBpm)) * 4;
  const harmonyEvents = [...(bed.harmonyEvents ?? [])]
    .filter((event) => Number.isSafeInteger(event.startMs) && Number.isSafeInteger(event.endMs)
      && event.endMs > event.startMs && event.startMs >= 0
      && Number.isFinite(event.confidence) && event.confidence >= 0 && event.confidence <= 1)
    .sort((left, right) => left.startMs - right.startMs);
  const vocalPitchFrames = [...(vocals.vocalPitchFrames ?? [])]
    .filter((frame) => Number.isSafeInteger(frame.timestampMs)
      && frame.timestampMs >= 0 && frame.timestampMs <= vocals.durationMs)
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const drumEvents = sanitizeTransientEvents(bed.drumEvents);
  const bassEvents = sanitizeTransientEvents(bed.bassEvents);
  const { slots, gridTrusted } = arrangementSlotEvidence(bed);
  if (slots.length < 3) return null;
  const evidence = {
    chordTimeline: harmonyEvents.length >= 4 && vocalPitchFrames.length >= 12,
    drumTransients: drumEvents.length >= 8,
    bassAttacks: bassEvents.length >= 8,
    beatGrid: gridTrusted,
    sectionRoles: bed.sections.length >= 2,
  };
  const informative = evidence.chordTimeline || evidence.drumTransients || evidence.bassAttacks;
  if (!informative) return null;

  const context: ArrangementBedContext = {
    harmonyEvents,
    drumEvents,
    bassEvents,
    sections: bed.sections,
    durationMs: bed.durationMs,
    barMs,
    stretchRatio,
    pitchShiftSemitones: vocalPitchShiftSemitones,
    vocalPitchFrames,
  };
  const timedUnits = unitTimings.map((unit) => ({
    unit,
    spanStretchedMs: Math.round((unit.toMs - unit.fromMs) * stretchRatio),
  }));

  // Precompute per-unit slot scores (bounded matrix).
  const unitCount = unitTimings.length;
  const slotCount = slots.length;
  const scoreMatrix: Float64Array[] = [];
  for (let index = 0; index < unitCount; index += 1) {
    const unit = unitTimings[index]!;
    const row = new Float64Array(slotCount);
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      const startMs = slots[slotIndex]!;
      const endMs = startMs + timedUnits[index]!.spanStretchedMs;
      row[slotIndex] = endMs > bed.durationMs + 1
        ? Number.NaN
        : arrangementFeatureScore(unit, startMs, context).score;
    }
    scoreMatrix.push(row);
  }

  const segmented = solveArrangementMonotonic(timedUnits, slots, scoreMatrix, bed.durationMs, barMs);

  const overlayStartFor = (unit: ArrangementUnit) =>
    Math.round(overlayEntryMs + (unit.fromMs - body.fromMs) * stretchRatio);
  let overlayScore = 0;
  let overlayPlaced = 0;
  for (const unit of unitTimings) {
    const startMs = overlayStartFor(unit);
    const endMs = startMs + Math.round((unit.toMs - unit.fromMs) * stretchRatio);
    if (startMs < 0 || endMs > bed.durationMs + 1) continue;
    overlayScore += arrangementFeatureScore(unit, startMs, context).score;
    overlayPlaced += 1;
  }

  const segmentedPlaced = segmented.slotIndices.filter((index) => index >= 0).length;
  const segmentedBetter = segmentedPlaced >= overlayPlaced
    && Number.isFinite(segmented.total)
    && segmented.total - overlayScore > Math.max(0.5, 0.03 * Math.abs(overlayScore));
  const selected: "segmented" | "continuous-overlay" = segmentedBetter ? "segmented" : "continuous-overlay";
  const improvementRatio = Number.isFinite(segmented.total)
    ? (segmented.total - overlayScore) / Math.max(1, Math.abs(overlayScore))
    : null;

  const placements: MashupArrangementPlacement[] = [];
  let unitsSkipped = 0;
  for (let index = 0; index < unitTimings.length; index += 1) {
    const unit = unitTimings[index]!;
    const bedStartMs = segmentedBetter
      ? (segmented.slotIndices[index] ?? -1) >= 0 ? slots[segmented.slotIndices[index]!]! : -1
      : overlayStartFor(unit);
    if (bedStartMs < 0) { unitsSkipped += 1; continue; }
    const endMs = bedStartMs + timedUnits[index]!.spanStretchedMs;
    if (endMs > bed.durationMs + 1) { unitsSkipped += 1; continue; }
    const feature = arrangementFeatureScore(unit, bedStartMs, context);
    placements.push({
      donorFromMs: unit.fromMs,
      donorToMs: unit.toMs,
      bedStartMs,
      unitScore: Number(feature.score.toFixed(4)),
      vocalChordFit: feature.vocalChordFit === null ? null : Number(feature.vocalChordFit.toFixed(4)),
      chordFrames: feature.chordFrames,
      drumBassOnsetFit: feature.drumBassOnsetFit === null ? null : Number(feature.drumBassOnsetFit.toFixed(4)),
      bedSectionRole: feature.bedSectionRole,
      evidence: feature.evidence,
    });
  }

  const rationale: string[] = [];
  const warnings: string[] = [];
  const evidenceSources = [
    evidence.chordTimeline ? "the bed's measured chord timeline" : null,
    evidence.drumTransients ? "measured drum transients" : null,
    evidence.bassAttacks ? "measured bass attacks" : null,
    evidence.sectionRoles ? "inferred bed section roles (unverified hypotheses)" : null,
  ].filter(Boolean).join(", ");
  if (segmentedBetter) {
    rationale.push(
      `full-track arrangement: ${placements.length}/${unitTimings.length} voiced units placed monotonically across the bed on measured ${gridTrusted ? "beat-grid" : "section"} slots; vocal order is preserved and no voiced material is reordered or duplicated (${evidenceSources})`,
    );
    rationale.push(
      `segmented placement scored ${segmented.total.toFixed(2)} against the continuous overlay's ${overlayScore.toFixed(2)} (${improvementRatio === null ? "n/a" : improvementRatio >= 0 ? `+${(improvementRatio * 100).toFixed(1)}%` : `${(improvementRatio * 100).toFixed(1)}%`}); the continuous overlay would have concentrated vocal placement at a single offset`,
    );
    warnings.push(
      "The vocal arrangement was re-mapped onto the bed by measured placement evidence. Unit boundaries keep their internal timing; placement is a relative evidence ranking, not lyric timing or verse/chorus detection.",
    );
  } else {
    rationale.push(
      `full-track arrangement search evaluated ${unitTimings.length} voiced unit(s) against ${slots.length} bed ${gridTrusted ? "beat-grid" : "boundary"} slots; the segmented placement scored ${segmented.total.toFixed(2)} versus ${overlayScore.toFixed(2)} for the continuous overlay, so the uninterrupted vocal was kept`,
    );
    warnings.push(
      "Vocal units were evaluated across the whole bed but no re-placement beat the continuous overlay decisively; the overlay is retained and the comparison is recorded in the plan.",
    );
  }
  if (unitsSkipped > 0) {
    warnings.push(`${unitsSkipped} voiced unit(s) did not fit before the end of the bed and are not placed; the bed simply ends first.`);
  }

  return {
    engine: MASHUP_PLANNER_ENGINE,
    mode: selected,
    selected,
    segmentedScore: Number(segmented.total.toFixed(4)),
    overlayScore: Number(overlayScore.toFixed(4)),
    improvementRatio: improvementRatio === null ? null : Number(improvementRatio.toFixed(4)),
    unitsTotal: unitTimings.length,
    unitsPlaced: placements.length,
    unitsSkipped,
    evidence: {
      chordTimeline: evidence.chordTimeline,
      drumTransients: evidence.drumTransients,
      bassAttacks: evidence.bassAttacks,
      beatGrid: gridTrusted,
      sectionRoles: evidence.sectionRoles,
    },
    rationale,
    warnings,
    placements,
  };
}

/**
 * Pick the donor material for a reprise over the late bed, grounded in
 * evidence instead of blindly replaying the opening. Order of preference:
 * 1. a repeated-passage section label persisted by the current analysis
 *    (pattern/rhythm/vocal-pattern recurrence); the LATEST occurrence is
 *    reprised and the measured recurrence agreement is disclosed;
 * 2. the donor's final measured sustained vocal passage (activity or
 *    pitch-continuity), labelled a closing echo rather than a recurrence.
 * Returns null when no grounding exists; the caller then leaves the bed
 * instrumental instead of faking a reprise.
 */
function chooseGroundedReprise(
  vocals: MashupSourceProfile,
  body: { fromMs: number; toMs: number },
): { fromMs: number; toMs: number; rationale: string; evidence: string; warning: string | null } | null {
  const repeatGroups = new Map<string, MashupSection[]>();
  for (const section of vocals.sections) {
    const match = /^(pattern|rhythm|vocal-pattern)-repeat-([a-z]+)$/.exec(section.label.toLowerCase());
    if (!match) continue;
    if (!Number.isSafeInteger(section.startMs) || !Number.isSafeInteger(section.endMs)
      || section.endMs <= section.startMs) continue;
    const key = `${match[1]}:${match[2]}`;
    const list = repeatGroups.get(key) ?? [];
    list.push(section);
    repeatGroups.set(key, list);
  }
  const repriseGroups = [...repeatGroups.values()]
    .map((group) => [...group].sort((left, right) => left.startMs - right.startMs))
    .filter((group) => group.length >= 2);
  let recurrenceCandidate: { section: MashupSection; durationSimilarity: number; occurrences: number; label: string } | null = null;
  for (const group of repriseGroups) {
    const last = group[group.length - 1]!;
    const previous = group[group.length - 2]!;
    const lastSpan = last.endMs - last.startMs;
    const previousSpan = Math.max(1, previous.endMs - previous.startMs);
    const durationSimilarity = Math.min(lastSpan, previousSpan) / Math.max(lastSpan, previousSpan);
    if (durationSimilarity < 0.5) continue;
    if (recurrenceCandidate && recurrenceCandidate.durationSimilarity >= durationSimilarity
      && (recurrenceCandidate.section.endMs - recurrenceCandidate.section.startMs) >= lastSpan) continue;
    recurrenceCandidate = { section: last, durationSimilarity, occurrences: group.length, label: last.label };
  }
  if (recurrenceCandidate) {
    const span = recurrenceCandidate.section;
    return {
      fromMs: span.startMs,
      toMs: span.endMs,
      rationale: `reprise of the donor's measured repeated passage “${recurrenceCandidate.label}” (${(span.startMs / 1000).toFixed(1)}s–${(span.endMs / 1000).toFixed(1)}s)`,
      evidence: `the donor's own recurrence label “${recurrenceCandidate.label}” across ${recurrenceCandidate.occurrences} occurrence(s), with ${(recurrenceCandidate.durationSimilarity * 100).toFixed(0)}% duration agreement — a structural recurrence hypothesis, not a semantic chorus claim`,
      warning: null,
    };
  }
  const activity = qualifiedVocalActivityIntervals(vocals);
  const finalInterval = [...activity].reverse().find((interval) => interval.endMs - interval.startMs >= 1_500);
  if (finalInterval) {
    return {
      fromMs: finalInterval.startMs,
      toMs: finalInterval.endMs,
      rationale: `closing-vocal echo of the donor's final sustained passage (${(finalInterval.startMs / 1000).toFixed(1)}s–${(finalInterval.endMs / 1000).toFixed(1)}s)`,
      evidence: "the donor's final measured sustained vocal-activity passage (no repeated-passage label was available)",
      warning: "The closing echo re-places the donor's final sustained vocal passage over the late bed; it is NOT an evidence-backed recurrence or semantic reprise. Treat it as a deliberate design choice, not a detection result.",
    };
  }
  const phrases = qualifiedVocalPitchRuns(vocals, { fromMs: 0, toMs: vocals.durationMs });
  const finalRun = [...phrases].reverse().find((phrase) => phrase.endMs - phrase.startMs >= 1_500);
  if (finalRun) {
    return {
      fromMs: finalRun.startMs,
      toMs: finalRun.endMs,
      rationale: `closing-vocal echo of the donor's final pitch-continuity passage (${(finalRun.startMs / 1000).toFixed(1)}s–${(finalRun.endMs / 1000).toFixed(1)}s)`,
      evidence: "the donor's final sustained pitch-continuity run (no repeated-passage label was available)",
      warning: "The closing echo re-places the donor's final pitch-continuity passage over the late bed; it is NOT an evidence-backed recurrence or semantic reprise. Treat it as a deliberate design choice, not a detection result.",
    };
  }
  // 4) The donor's final detected section, provided it is a different range
  //    from the opening passage (never replay the identical window).
  const bodyFrom = body.fromMs;
  const bodyTo = body.toMs;
  const bodyMid = (bodyFrom + bodyTo) / 2;
  const finalSection = [...vocals.sections]
    .filter((section) => Number.isSafeInteger(section.startMs) && Number.isSafeInteger(section.endMs)
      && section.endMs > section.startMs
      && !/intro/i.test(section.label))
    .sort((left, right) => left.startMs - right.startMs)
    .at(-1);
  if (finalSection
    && !(finalSection.startMs === bodyFrom && finalSection.endMs === bodyTo)
    && finalSection.startMs >= bodyMid - 1_000) {
    return {
      fromMs: finalSection.startMs,
      toMs: finalSection.endMs,
      rationale: `closing-vocal encore of the donor's final detected passage “${finalSection.label}” (${(finalSection.startMs / 1000).toFixed(1)}s–${(finalSection.endMs / 1000).toFixed(1)}s)`,
      evidence: `the donor's own persisted section “${finalSection.label}” — an encore of its closing passage, not a recurrence or semantic detection`,
      warning: "The closing encore re-places the donor's final detected section over the late bed; it is NOT an evidence-backed recurrence or semantic reprise. Treat it as a deliberate design choice, not a detection result.",
    };
  }
  return null;
}

function grooveAwareBedEntry(
  vocals: MashupSourceProfile,
  bed: MashupSourceProfile,
  body: ReturnType<typeof vocalBodySpan>,
  requestedEntryMs: number,
  masterBpm: number,
  stretchRatio: number,
  vocalPitchShiftSemitones: number,
): { at: number; why: string | null; warning: string | null; passageSearch: MashupPassageSearch } {
  const base = alignBedEntryToMeasuredBeat(bed, requestedEntryMs, masterBpm);
  const grid = trustedAnalysisBeatGrid(bed.beatGridMs, bed.bpmConfidence, bed.beatConfidence);

  const drumEvents = (bed.drumEvents ?? [])
    .filter((event) => Number.isSafeInteger(event.timestampMs) && event.timestampMs >= 0
      && Number.isFinite(event.confidence) && event.confidence > 0 && event.confidence <= 1)
    .slice()
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const bassEvents = (bed.bassEvents ?? [])
    .filter((event) => Number.isSafeInteger(event.timestampMs) && event.timestampMs >= 0
      && Number.isFinite(event.confidence) && event.confidence > 0 && event.confidence <= 1)
    .slice()
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const vocalTiming = vocalTimingIntervals(vocals, body);
  const vocalOnsetOffsetsMs = vocalTiming.intervals.map((interval) => interval.startMs - body.fromMs);
  const vocalOnsetLabel = vocalTiming.kind === "activity"
    ? "coarse vocal-activity interval starts"
    : vocalTiming.kind === "pitch-continuity"
      ? "pitch-continuity run starts"
      : "combined vocal-activity and pitch-run starts";
  const passageDecision = rankedPassageEntry(
    vocals, bed, body, base.at, masterBpm, stretchRatio, vocalPitchShiftSemitones,
  );
  const passageEntry = passageDecision.match;
  if (passageEntry) {
    const selectedSection = vocals.sections.find((section) => {
      const sectionId = section.id
        ?? `${vocals.sourceAssetId ?? "vocals"}:${section.startBeatIndex ?? section.startMs}`;
      return sectionId === passageEntry.donorSectionId;
    });
    const selectedOnsetOffsetsMs = selectedSection
      ? vocalTiming.intervals
        .filter((interval) => interval.startMs >= selectedSection.startMs && interval.startMs < selectedSection.endMs)
        .map((interval) => interval.startMs - body.fromMs)
      : vocalOnsetOffsetsMs;
    const selectedTiming = scoreEntryAgainstTransients(
      passageEntry.at, selectedOnsetOffsetsMs, stretchRatio, drumEvents, bassEvents,
    );
    const drumLabel = drumEvents.length > 0 ? `${selectedTiming.drumMatches}/${selectedOnsetOffsetsMs.length}` : "unavailable";
    const bassLabel = bassEvents.length > 0 ? `${selectedTiming.bassMatches}/${selectedOnsetOffsetsMs.length}` : "unavailable";
    return {
      at: passageEntry.at,
      why: [
        passageEntry.why,
        `at the selected passage, ${drumLabel} ${vocalOnsetLabel} overlap measured drum transients and ${bassLabel} overlap low-band bass attacks`,
      ].filter(Boolean).join("; "),
      warning: `The passage choice is only the highest relative evidence ranking among current candidates (${passageEntry.score.toFixed(3)}); it is not calibrated or listener-validated. It does not establish a good-sounding arrangement; transient matches are only a tie-breaker.`,
      passageSearch: passageDecision.search,
    };
  }

  const baselineTiming = scoreEntryAgainstTransients(
    base.at, vocalOnsetOffsetsMs, stretchRatio, drumEvents, bassEvents,
  );
  const drumLabel = drumEvents.length > 0 ? `${baselineTiming.drumMatches}/${vocalOnsetOffsetsMs.length}` : "unavailable";
  const bassLabel = bassEvents.length > 0 ? `${baselineTiming.bassMatches}/${vocalOnsetOffsetsMs.length}` : "unavailable";
  const phraseTiming = vocalOnsetOffsetsMs.length
    ? `at the unchanged entry, ${drumLabel} ${vocalOnsetLabel} overlap measured drum transients and ${bassLabel} overlap low-band bass attacks`
    : "no confidence-qualified vocal activity or pitch interval starts were available for transient comparison";
  return {
    at: base.at,
    why: `${base.why}; ${phraseTiming}; ${passageDecision.reason}, so transient coincidences did not move the entry`,
    warning: `The entry remains a measured-beat fallback because ${passageDecision.reason}.${grid ? "" : " No trusted bed beat grid was available."}${body.vocalActivityEvidence ? "" : " No current isolated-vocal activity or pitch intervals were available."} These observations are not lyric phrases, and event timing does not establish musical fit or listening quality.`,
    passageSearch: passageDecision.search,
  };
}

export function planMashup(vocals: MashupSourceProfile, bed: MashupSourceProfile): MashupPlanResult {
  vocals = profileFromCurrentEvidence(vocals);
  bed = profileFromCurrentEvidence(bed);
  const rationale: string[] = [];
  const warnings: string[] = [];
  if (bed.harmonyEvidenceSource === "source-mix") {
    warnings.push("Harmony evidence comes from the full source mix because no current separated bed-stem chord analysis was available.");
  } else if (bed.harmonyEvidenceSource === "separated-stem"
    && bed.harmonyEvidenceStemType
    && bed.harmonyEvidenceStemType !== "instrumental") {
    warnings.push(`Harmony evidence is measured on the separated ${bed.harmonyEvidenceStemType} stem, not the complete summed instrumental bed.`);
  }

  let masterBpm: number;
  let estimatedBed = false;
  let estimatedVocal = false;

  const trustedBedBpm = trustedAnalysisBpm(bed.bpm, bed.bpmConfidence);
  const trustedVocalBpm = trustedAnalysisBpm(vocals.bpm, vocals.bpmConfidence);

  if (trustedBedBpm !== null) {
    masterBpm = trustedBedBpm;
    rationale.push(`master tempo = the instrumental's verified ${masterBpm} BPM.`);
  } else if (bed.bpm !== null && bed.bpm > 0) {
    masterBpm = bed.bpm;
    warnings.push(`Instrumental tempo (${masterBpm} BPM) has low confidence (${bed.bpmConfidence ?? 0}); beat synchronization may drift.`);
    rationale.push(`master tempo = the instrumental's ${masterBpm} BPM (low confidence).`);
  } else if (trustedVocalBpm !== null || (vocals.bpm !== null && vocals.bpm > 0)) {
    masterBpm = trustedVocalBpm ?? vocals.bpm!;
    rationale.push(`master tempo = the vocal's ${masterBpm} BPM (adopted because instrumental tempo is unanalyzed).`);
    warnings.push(`The instrumental has no complete tempo analysis — adopting vocal tempo (${masterBpm} BPM) as master.`);
  } else {
    const fallbackBed = estimateFallbackTempo(bed);
    masterBpm = fallbackBed.bpm;
    estimatedBed = true;
    warnings.push(`Neither track has complete tempo analysis — using unaligned reference (${masterBpm} BPM). Musical beat synchronization cannot be guaranteed.`);
    rationale.push(`master tempo = reference tempo (${masterBpm} BPM, untrusted).`);
  }

  let effectiveVocalBpm: number;
  if (trustedVocalBpm !== null) {
    effectiveVocalBpm = trustedVocalBpm;
  } else if (vocals.bpm !== null && vocals.bpm > 0) {
    effectiveVocalBpm = vocals.bpm;
    warnings.push(`Vocal tempo (${effectiveVocalBpm} BPM) has low confidence (${vocals.bpmConfidence ?? 0}).`);
  } else {
    const fallbackVocal = estimateFallbackTempo(vocals);
    effectiveVocalBpm = fallbackVocal.bpm;
    estimatedVocal = true;
    warnings.push(`Vocal tempo analysis is incomplete — estimated at ${effectiveVocalBpm} BPM (${fallbackVocal.source}).`);
  }

  // Only calculate automatic tempo stretching when BOTH sources have trustworthy BPM evidence.
  // Otherwise preserve natural speed (1.0), mark alignment unverified, and explain honestly.
  let stretchRatio = 1.0;
  if (trustedBedBpm !== null && trustedVocalBpm !== null) {
    stretchRatio = warpRatioForTempos(effectiveVocalBpm, masterBpm);
    if (Math.abs(stretchRatio - 1) < 1e-9) {
      rationale.push(`vocals stay at natural speed (${effectiveVocalBpm} BPM syncs to ${masterBpm} BPM as-is or via a double/half lock).`);
    } else {
      rationale.push(`vocals are time-stretched ×${stretchRatio.toFixed(3)} (${effectiveVocalBpm} → ${masterBpm} BPM, pitch preserved by WSOLA).`);
    }
    if (vocals.bpm !== null && vocals.bpm !== masterBpm && Math.abs(vocals.bpm - masterBpm) <= 6) {
      rationale.push("tempos are near-equal — a light stretch, not a resample.");
    }
  } else {
    stretchRatio = 1.0;
    warnings.push("Automatic tempo stretching withheld (ratio 1.0): both tracks must have verified tempo confidence (>=0.5) to enable musical beat synchronization.");
    rationale.push("vocals remain at natural speed (1.000×): tempo evidence is unverified on at least one track.");
  }

  // Enforce trustedAnalysisKey strictly: missing confidence means untrusted evidence,
  // including legacy records. Only verified keys from both sources may trigger automatic pitch shifting.
  const trustedVocalKey = trustedAnalysisKey(vocals.musicalKey, vocals.keyConfidence);
  const trustedBedKey = trustedAnalysisKey(bed.musicalKey, bed.keyConfidence);

  const pitchMove = (trustedVocalKey !== null && trustedBedKey !== null)
    ? pitchMoveForKeys(trustedVocalKey, trustedBedKey)
    : { semitones: 0, relationship: "unknown" as const };

  if (pitchMove.relationship === "unknown") {
    if (!vocals.musicalKey || !bed.musicalKey) {
      warnings.push("Key analysis is missing for at least one track — no pitch move was made (0 semitones).");
    } else {
      warnings.push("Key analysis confidence is below the trusted threshold (0.5) — automatic pitch move withheld (0 semitones).");
    }
  } else if (pitchMove.semitones === 0 && pitchMove.relationship === "relative") {
    rationale.push(`keys are relative (${trustedVocalKey} / ${trustedBedKey}) — same scale, no pitch shift needed.`);
  } else if (pitchMove.semitones === 0) {
    rationale.push(`same key (${trustedBedKey}) — no pitch shift needed.`);
  } else {
    rationale.push(`vocals shift ${pitchMove.semitones > 0 ? "+" : ""}${pitchMove.semitones} semitones (${trustedVocalKey} → ${trustedBedKey}, ${pitchMove.relationship}).`);
  }
  if (Math.abs(pitchMove.semitones) > 4) {
    warnings.push(`A ${pitchMove.semitones}-semitone shift is large — expect audible formant change. Trust your ears; you can veto the shift.`);
  }

  const beatMs = 60_000 / masterBpm;
  const barMs = beatMs * 4;
  const body = vocalBodySpan(vocals);
  const requestedEntry = bedEntryMs(bed, barMs);
  const alignedEntry = grooveAwareBedEntry(
    vocals,
    bed,
    body,
    requestedEntry.at,
    masterBpm,
    stretchRatio,
    pitchMove.semitones,
  );
  const entry = {
    at: alignedEntry.at,
    why: [requestedEntry.why, alignedEntry.why].filter(Boolean).join("; "),
  };
  rationale.push(entry.why);
  if (alignedEntry.warning) warnings.push(alignedEntry.warning);
  warnings.push(...(bed.grooveWarnings ?? []));

  rationale.push(body.why);
  if (body.vocalActivityEvidence) {
    rationale.push("the crop keeps 250ms around measured voiced activity; word, syllable, and lyrical-meaning timing are not analyzed.");
  } else {
    warnings.push("No current isolated-vocal voicing intervals are available; the entry is not lyric-aware and the full vocal source window is retained.");
  }

  const vocalSpanMs = Math.max(0, body.toMs - body.fromMs);
  const stretchedMs = vocalSpanMs * stretchRatio;
  const bedRoomMs = Math.max(0, bed.durationMs - entry.at);

  const segments: MashupSegment[] = [];
  let arrangement: MashupArrangement | null = null;

  // Intelligently arrange full-length vocal segments across the bed timeline.
  // When vocals are significantly shorter than the bed (e.g. bed has extra sections / 2nd verse / chorus),
  // the planner places an evidence-grounded reprise of the donor's own later-occurring material instead of
  // replaying the opening, so both tracks contribute throughout the entire song.
  if (stretchedMs > 0 && bedRoomMs > 0) {
    const passageMatchSelected = alignedEntry.passageSearch?.selectedDonorSectionId != null;
    if (stretchedMs >= bedRoomMs * 0.75) {
      if (!passageMatchSelected) {
        arrangement = planArrangement(vocals, bed, body, entry.at, masterBpm, stretchRatio, pitchMove.semitones);
      }
      if (arrangement?.selected === "segmented") {
        // Merge placements that remain back-to-back into fewer clips; the renderer and
        // the Studio timeline still see ordinary segments with ordinary offsets.
        const mergedPlacements: typeof arrangement.placements = [];
        for (const placement of arrangement.placements) {
          const last = mergedPlacements[mergedPlacements.length - 1];
          if (last
            && Math.round(last.bedStartMs + (last.donorToMs - last.donorFromMs) * stretchRatio) === placement.bedStartMs
            && last.donorToMs === placement.donorFromMs) {
            mergedPlacements[mergedPlacements.length - 1] = {
              ...last,
              donorToMs: placement.donorToMs,
              unitScore: Number(((last.unitScore + placement.unitScore) / 2).toFixed(4)),
              evidence: [...new Set([...last.evidence, ...placement.evidence])],
            };
            continue;
          }
          mergedPlacements.push({ ...placement });
        }
        // Keep arrangement.placements as the per-unit record; the merged run is
        // only the segment representation of the same placements.
        for (const [index, placement] of mergedPlacements.entries()) {
          const segmentEndMs = Math.min(
            bed.durationMs,
            placement.bedStartMs + Math.round((placement.donorToMs - placement.donorFromMs) * stretchRatio),
          );
          if (segmentEndMs <= placement.bedStartMs) continue;
          segments.push({
            mashupStartMs: placement.bedStartMs,
            mashupEndMs: segmentEndMs,
            vocalsFromMs: placement.donorFromMs,
            vocalsToMs: placement.donorToMs,
            crossfadeMs: CROSSFADE_MS,
            rationale: `voiced unit ${index + 1}/${mergedPlacements.length} placed at ${(placement.bedStartMs / 1000).toFixed(1)}s on measured bed evidence (${placement.evidence[0] ?? "placement evidence"})`,
            stemType: "vocals",
            sourceRole: "vocals",
          });
        }
        rationale.push(...arrangement.rationale);
        warnings.push(...arrangement.warnings);
      } else {
        // Standard full or near-full overlay
        const segEndMs = Math.min(bed.durationMs, entry.at + stretchedMs);
        segments.push({
          mashupStartMs: entry.at,
          mashupEndMs: segEndMs,
          vocalsFromMs: body.fromMs,
          vocalsToMs: body.toMs,
          crossfadeMs: CROSSFADE_MS,
          rationale: `primary vocal body runs ${(stretchedMs / 1000).toFixed(1)}s from ${(entry.at / 1000).toFixed(1)}s`,
          stemType: "vocals",
          sourceRole: "vocals",
        });
        if (stretchedMs > bedRoomMs) {
          warnings.push(`The stretched vocal (${(stretchedMs / 1000).toFixed(1)}s) is longer than the bed has room (${(bedRoomMs / 1000).toFixed(1)}s) — it fades out at the bed's end.`);
        }
        if (arrangement) {
          rationale.push(...arrangement.rationale);
          warnings.push(...arrangement.warnings);
        }
      }
    } else {
      // Bed is significantly longer than vocals. We build a structured multi-segment arrangement:
      // Segment 1: initial vocal verse/body
      // Segment 2: evidence-grounded reprise later in the bed after an instrumental pocket
      const firstSegmentEnd = entry.at + stretchedMs;
      segments.push({
        mashupStartMs: entry.at,
        mashupEndMs: firstSegmentEnd,
        vocalsFromMs: body.fromMs,
        vocalsToMs: body.toMs,
        crossfadeMs: CROSSFADE_MS,
        rationale: `first vocal passage runs ${(stretchedMs / 1000).toFixed(1)}s over the bed`,
        stemType: "vocals",
        sourceRole: "vocals",
      });

      // Calculate bar-aligned breakdown gap
      const breakdownBars = Math.max(2, Math.floor((barMs > 0 ? (bedRoomMs - stretchedMs) / 3 / barMs : 4)));
      const breakdownMs = barMs > 0 ? breakdownBars * barMs : 8_000;
      const secondStart = Math.min(bed.durationMs - Math.min(stretchedMs, 30_000), firstSegmentEnd + breakdownMs);
      const remainingMs = bed.durationMs - secondStart;

      if (remainingMs > 4_000) {
        const reprise = chooseGroundedReprise(vocals, body);
        if (reprise) {
          const repriseSpanMs = Math.max(0, reprise.toMs - reprise.fromMs);
          const vocalPortionMs = Math.min(repriseSpanMs, remainingMs / stretchRatio);
          segments.push({
            mashupStartMs: secondStart,
            mashupEndMs: Math.min(bed.durationMs, secondStart + vocalPortionMs * stretchRatio),
            vocalsFromMs: reprise.fromMs,
            vocalsToMs: reprise.fromMs + vocalPortionMs,
            crossfadeMs: CROSSFADE_MS,
            rationale: `${reprise.rationale} — placed at ${(secondStart / 1000).toFixed(1)}s after a ${(breakdownMs / 1000).toFixed(1)}s instrumental pocket, extending the vocal to the late bed`,
            stemType: "vocals",
            sourceRole: "vocals",
          });
          rationale.push(`second vocal placement grounded in ${reprise.evidence}`);
          if (reprise.warning) warnings.push(reprise.warning);
        } else {
          warnings.push(
            `The bed is significantly longer than the vocal body (${(stretchedMs / 1000).toFixed(1)}s singable) and no donor reprise had grounding evidence (no repeated-passage sections or sustained trailing passage); the rest of the bed runs instrumental rather than replaying the opening vocal material.`,
          );
        }
      }
    }
  } else {
    // Fallback: minimal single segment
    segments.push({
      mashupStartMs: entry.at,
      mashupEndMs: Math.min(bed.durationMs, entry.at + stretchedMs),
      vocalsFromMs: body.fromMs,
      vocalsToMs: body.toMs,
      crossfadeMs: CROSSFADE_MS,
      rationale: `vocals run ${(stretchedMs / 1000).toFixed(1)}s over the bed`,
      stemType: "vocals",
      sourceRole: "vocals",
    });
  }

  return {
    ok: true,
    plan: {
      engine: MASHUP_PLANNER_ENGINE,
      masterBpm,
      vocalsStretchRatio: stretchRatio,
      vocalsPitchSemitones: pitchMove.semitones,
      keyRelationship: pitchMove.relationship,
      segments,
      ...(arrangement ? { arrangement } : {}),
      durationMs: bed.durationMs,
      rationale,
      warnings,
    passageSearch: alignedEntry.passageSearch,
    },
  };
}

function profileFromCurrentEvidence(profile: MashupSourceProfile): MashupSourceProfile {
  const packet = profile.evidence;
  if (!packet
    || packet.format !== "waveyard-musical-evidence-v1"
    || (profile.sourceAssetId !== undefined && packet.source.assetId !== profile.sourceAssetId)
    || (profile.sourceChecksumSha256 !== undefined && packet.source.checksumSha256 !== profile.sourceChecksumSha256)) {
    return profile;
  }

  const sourceChecksum = packet.source.checksumSha256;
  const tempo = currentEvidenceValue(packet.features.tempo, sourceChecksum);
  const key = currentEvidenceValue(packet.features.key, sourceChecksum);
  const beatGrid = currentEvidenceValue(packet.features.beatGrid, sourceChecksum);
  const sections = currentEvidenceValue(packet.features.sections, sourceChecksum);
  const vocalPhrases = currentEvidenceValue(packet.features.vocalPhrases, sourceChecksum);
  const vocalActivityEvidence = packet.features.vocalActivityIntervals;
  const vocalActivityIntervals = vocalActivityEvidence
    ? currentEvidenceValue(vocalActivityEvidence, sourceChecksum)
    : null;
  const vocalPitchFrames = packet.features.vocalPitchFrames
    ? currentEvidenceValue(packet.features.vocalPitchFrames, sourceChecksum)
    : null;
  const harmonyEvents = currentEvidenceValue(packet.features.harmony, sourceChecksum);
  const drumEvents = currentEvidenceValue(packet.features.drumEvents, sourceChecksum);
  const bassAttacks = currentEvidenceValue(packet.features.bassAttacks, sourceChecksum);
  return {
    ...profile,
    sourceAssetId: packet.source.assetId,
    sourceChecksumSha256: sourceChecksum,
    bpm: tempo?.bpm ?? profile.bpm,
    bpmConfidence: tempo?.confidence ?? profile.bpmConfidence ?? null,
    musicalKey: key?.key ?? profile.musicalKey,
    keyConfidence: key?.confidence ?? profile.keyConfidence ?? null,
    beatGridMs: beatGrid?.beatsMs ?? profile.beatGridMs ?? null,
    beatConfidence: beatGrid?.confidence ?? profile.beatConfidence ?? null,
    sections: sections ?? profile.sections,
    vocalPhrases: vocalPhrases ?? profile.vocalPhrases ?? [],
    vocalActivityIntervals: vocalActivityEvidence
      ? vocalActivityIntervals ?? []
      : profile.vocalActivityIntervals ?? [],
    vocalPitchFrames: vocalPitchFrames ?? undefined,
    harmonyEvents: harmonyEvents ?? undefined,
    drumEvents: drumEvents ?? profile.drumEvents ?? [],
    bassEvents: bassAttacks ?? profile.bassEvents ?? [],
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export type MashupPcmInput = {
  /** Interleaved stereo vocal stem PCM. */
  vocals: StereoBuffer;
  /** Interleaved stereo bed (instrumental) PCM. */
  bed: StereoBuffer;
  /** Optional discrete stems from both songs for stem-level mixing. */
  stems?: Map<string, StereoBuffer>;
  sampleRate: number;
};

function trapezoidGain(atMs: number, startMs: number, endMs: number, crossfadeMs: number): number {
  if (atMs < startMs || atMs > endMs) return 0;
  const into = atMs - startMs;
  const remaining = endMs - atMs;
  if (into < crossfadeMs) return into / crossfadeMs;
  if (remaining < crossfadeMs) return remaining / crossfadeMs;
  return 1;
}

/** Mix the plan: bed (ducked under vocals) + stretched/pitched vocal
 *  segments with trapezoid fades. Deterministic from the plan. */
export function renderMashup(plan: MashupPlan, input: MashupPcmInput): StereoBuffer {
  const { sampleRate } = input;
  const totalFrames = Math.max(1, Math.round((plan.durationMs / 1000) * sampleRate));
  const out = new Float32Array(totalFrames * 2);

  // Prepared vocal segments (stretched once, then pitched once each).
  const prepared = plan.segments.map((segment) => {
    const fromFrame = Math.max(0, Math.round((segment.vocalsFromMs / 1000) * sampleRate) * 2);
    const toFrame = Math.min(input.vocals.length, Math.max(fromFrame, Math.round((segment.vocalsToMs / 1000) * sampleRate) * 2));
    const span = input.vocals.slice(fromFrame, toFrame);
    if (span.length === 0) {
      return { segment, pcm: new Float32Array(0) };
    }
    const stretched = timeStretch(span, plan.vocalsStretchRatio, sampleRate);
    return { segment, pcm: pitchShift(stretched, plan.vocalsPitchSemitones, sampleRate) };
  });

  // Pre-process complementary donor stems ONCE before the rendering loop.
  // Instrumental stems (drums, bass, guitar, keys, other) must NEVER inherit vocal-specific
  // pitch transposition or vocal transformations. Preserve their native pitch.
  // Time-stretching is applied only when beat synchronization is mutually trusted.
  const preparedStems: Array<{ name: string; pcm: StereoBuffer }> = [];
  if (input.stems) {
    for (const [stemName, rawStemBuffer] of input.stems) {
      if (stemName !== "vocals") {
        // Instrumental donor stems preserve native pitch (0 semitones shift).
        // Only time-stretch to match master tempo if tempo stretch ratio differs from 1.0.
        const pcm = (stemName.startsWith("donor_") && Math.abs(plan.vocalsStretchRatio - 1.0) > 1e-6)
          ? timeStretch(rawStemBuffer, plan.vocalsStretchRatio, sampleRate)
          : rawStemBuffer;
        preparedStems.push({ name: stemName, pcm });
      }
    }
  }

  const bedFrames = Math.min(totalFrames, Math.floor(input.bed.length / 2));
  for (let frame = 0; frame < totalFrames; frame += 1) {
    const atMs = (frame / sampleRate) * 1000;

    // Bed gain: 1.0, ducked by a smoothed trapezoid under active vocals.
    let duck = 0;
    for (const { segment } of prepared) {
      duck = Math.max(duck, trapezoidGain(atMs, segment.mashupStartMs, segment.mashupEndMs, segment.crossfadeMs));
    }
    const bedGain = 1 - DUCK_DEPTH * duck;

    let left = 0;
    let right = 0;
    if (frame < bedFrames) {
      left = input.bed[frame * 2] * bedGain;
      right = input.bed[frame * 2 + 1] * bedGain;
    }

    for (const { segment, pcm } of prepared) {
      const gain = trapezoidGain(atMs, segment.mashupStartMs, segment.mashupEndMs, segment.crossfadeMs);
      if (gain <= 0) continue;
      const vocalFrame = Math.round(((atMs - segment.mashupStartMs) / 1000) * sampleRate);
      if (vocalFrame < 0 || vocalFrame * 2 + 1 >= pcm.length) continue;
      left += pcm[vocalFrame * 2] * gain;
      right += pcm[vocalFrame * 2 + 1] * gain;
    }

    // Mix prepared discrete stems with dynamic ducking into the vocal pocket
    for (const { pcm: stemBuffer } of preparedStems) {
      if (frame * 2 + 1 < stemBuffer.length) {
        const stemGain = 0.6;
        const stemDuck = DUCK_DEPTH;
        const dynamicGain = stemGain * (1 - stemDuck * duck);
        left += stemBuffer[frame * 2] * dynamicGain;
        right += stemBuffer[frame * 2 + 1] * dynamicGain;
      }
    }

    out[frame * 2] = Math.max(-1, Math.min(1, left));
    out[frame * 2 + 1] = Math.max(-1, Math.min(1, right));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Song extension — loop a section to lengthen a song (bar-aligned)
// ---------------------------------------------------------------------------

export type ExtensionPlan = {
  engine: typeof MASHUP_PLANNER_ENGINE;
  /** The section being looped. */
  section: MashupSection;
  /** How many extra plays of the section are appended. */
  repeats: number;
  /** Bar-aligned crossfade between the original end and each loop (ms). */
  crossfadeMs: number;
  durationMs: number;
  rationale: string[];
};

/** Plan an extension by looping a song section (default: the last chorus).
 *  The original audio is never cut — loops are appended at the section end. */
export function planSongExtension(
  source: MashupSourceProfile,
  options: { sectionLabel?: string; repeats?: number } = {},
): ExtensionPlan | null {
  const repeats = Math.max(1, Math.min(8, options.repeats ?? 2));
  const wanted = options.sectionLabel;
  const candidates = source.sections.filter((section) =>
    wanted === undefined ? !isIntro(section.label) : section.label.toLowerCase().includes(wanted.toLowerCase()),
  );
  const section = (candidates.length > 0 ? candidates[candidates.length - 1] : null) ?? source.sections[source.sections.length - 1] ?? null;
  if (section === null) return null;

  const barMs = source.bpm !== null && source.bpm > 0 ? (240_000 / source.bpm) : 0;
  const crossfadeMs = barMs > 0 ? Math.min(Math.round(barMs / 2), 1000) : 500;
  const loopMs = Math.max(0, section.endMs - section.startMs);
  const rationale = [
    `extending “${section.label}” (${(section.startMs / 1000).toFixed(1)}s–${(section.endMs / 1000).toFixed(1)}s) by ${repeats} more play${repeats === 1 ? "" : "s"}`,
    `loops append at ${(section.endMs / 1000).toFixed(1)}s with ${(crossfadeMs / 1000).toFixed(2)}s bar-aligned crossfades`,
    "the original audio is untouched — the extension is additive",
  ];
  return {
    engine: MASHUP_PLANNER_ENGINE,
    section,
    repeats,
    crossfadeMs,
    durationMs: section.endMs + loopMs * repeats + (barMs > 0 ? barMs : 1000),
    rationale,
  };
}

/** Render an extension: original (fading out as the loops take over) +
 *  crossfaded extra plays of the section, bar-length tail. */
export function renderSongExtension(
  plan: ExtensionPlan,
  pcm: StereoBuffer,
  sampleRate: number,
): StereoBuffer {
  const totalFrames = Math.max(1, Math.round((plan.durationMs / 1000) * sampleRate));
  const out = new Float32Array(totalFrames * 2);
  const sourceFrames = Math.floor(pcm.length / 2);

  const sectionFrom = Math.round((plan.section.startMs / 1000) * sampleRate);
  const sectionMs = plan.section.endMs - plan.section.startMs;
  const sectionFrames = Math.max(1, Math.round((sectionMs / 1000) * sampleRate));
  const sectionEndMs = plan.section.endMs;

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const atMs = (frame / sampleRate) * 1000;

    // Original pass: full gain until the section ends, then a short fade as
    // the first loop takes over. Anything past the plan is simply not used.
    if (frame < sourceFrames) {
      const originalGain = atMs <= sectionEndMs
        ? 1
        : Math.max(0, 1 - (atMs - sectionEndMs) / plan.crossfadeMs);
      out[frame * 2] += pcm[frame * 2] * originalGain;
      out[frame * 2 + 1] += pcm[frame * 2 + 1] * originalGain;
    }

    // Loop passes: each begins where the previous material ends, fading in
    // over crossfadeMs and out over its final crossfadeMs (into the next
    // loop or the outro bar).
    if (atMs >= sectionEndMs) {
      const loopIndex = Math.floor((atMs - sectionEndMs) / sectionMs);
      if (loopIndex < plan.repeats) {
        const loopStartMs = sectionEndMs + loopIndex * sectionMs;
        const loopEndMs = loopStartMs + sectionMs;
        const fadeIn = Math.min(1, (atMs - loopStartMs) / plan.crossfadeMs);
        const fadeOut = Math.min(1, (loopEndMs - atMs) / plan.crossfadeMs);
        const gain = Math.min(fadeIn, fadeOut);
        const sourceFrame = sectionFrom + (frame - Math.round((loopStartMs / 1000) * sampleRate));
        if (sourceFrame >= 0 && sourceFrame < sectionFrames && sourceFrame < sourceFrames) {
          out[frame * 2] += pcm[sourceFrame * 2] * gain;
          out[frame * 2 + 1] += pcm[sourceFrame * 2 + 1] * gain;
        }
      }
    }

    out[frame * 2] = Math.max(-1, Math.min(1, out[frame * 2]));
    out[frame * 2 + 1] = Math.max(-1, Math.min(1, out[frame * 2 + 1]));
  }
  return out;
}
