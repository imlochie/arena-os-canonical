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

import { pitchShift, timeStretch, type TimeStretchMapPoint } from "../elastic";
import type { LocalTempoMap } from "./local-tempo-map";
import type { StereoBuffer } from "../mixer/dsp";
import { keyCompatibility } from "../library/session-logic";
import { semitoneShift } from "../types/musical-key";
import { analysePcm, tempoCandidates, type AnalysisResult } from "../worker-local/analysis-engine";
import { trustedAnalysisBeatGrid, trustedAnalysisBpm, trustedAnalysisKey } from "../types/analysis-confidence";
import { comparePassageCompatibility, type PassageFingerprint, type PassageRollingWindow } from "../types/passage-compatibility";
import {
  HARMONY_TEMPLATE_MIN_MARGIN,
  harmonyPitchClasses,
  type HarmonyEvent,
} from "../types/harmony-analysis";
import type { VocalActivityInterval, VocalPhrase, VocalPitchFrame } from "../types/vocal-analysis";
import { currentEvidenceValue, type MusicalEvidencePacket } from "./musical-evidence";
import {
  finishMashupMix,
  measureMashupMixStage,
  planMashupBalance,
  unmeasuredBalance,
  MASHUP_LIMITER_CEILING,
  FULL_TRUE_PEAK_MAX_SECONDS,
  type MashupMixResult,
} from "./mashup-mix-bus";
import { hasReliableSessionDownbeatEvidence } from "../session-dj-controls";

export const MASHUP_PLANNER_ENGINE = "waveyard-mashup-planner-v12";
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
  /**
   * Plausible tempi in the same pulse family as `bpm`, strongest first. Used to
   * avoid stretching a vocal to twice the intended speed when a reading is an
   * octave high; absent means "trust `bpm` alone".
   */
  bpmCandidates?: number[] | null;
  musicalKey: string | null;
  keyConfidence?: number | null;
  beatGridMs?: number[] | null;
  beatConfidence?: number | null;
  /** Full-mix source analysis; a beat grid alone must never be promoted to a bar grid. */
  downbeatGridMs?: number[] | null;
  downbeatConfidence?: number | null;
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
  /** Optional gentle source-relative WSOLA correction derived from both trusted beat grids. */
  localTempoMap?: LocalTempoMap;
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
  /** The full vocal body stays together; coherent-overlay moves it as one tempo-locked unit. */
  mode: "continuous-overlay" | "coherent-overlay";
  /** Which mode was selected for this plan. */
  selected: "continuous-overlay" | "coherent-overlay";
  /** Bed position of the complete vocal body, including its internal pauses. */
  coherentEntryMs: number;
  /** Objective score for moving every voice-active window together at one tempo ratio. */
  coherentScore: number;
  /** Objective score of the continuous overlay starting at the chosen entry. */
  overlayScore: number;
  /** Donor beat-grid beats landing within tolerance of bed beats at the chosen entry. */
  pairedBeatPhaseFit: { score: number; matchedBeats: number; comparedBeats: number; meanErrorMs: number; toleranceMs: number } | null;
  /** The same paired beat-grid check at the original continuous entry. */
  baselineBeatPhaseFit: { score: number; matchedBeats: number; comparedBeats: number; meanErrorMs: number; toleranceMs: number } | null;
  /** (coherent - overlay) / max(1, |overlay|); null when no arrangement evidence existed. */
  improvementRatio: number | null;
  unitsTotal: number;
  unitsPlaced: number;
  unitsSkipped: number;
  coherentUnitsPlaced: number;
  continuousUnitsPlaced: number;
  evidence: {
    chordTimeline: boolean;
    drumTransients: boolean;
    bassAttacks: boolean;
    beatGrid: boolean;
    pairedBeatGrids: boolean;
    sectionRoles: boolean;
  };
  rationale: string[];
  warnings: string[];
  placements: MashupArrangementPlacement[];
};

export type MashupPlan = {
  engine: typeof MASHUP_PLANNER_ENGINE;
  alignmentStrategy: MashupAlignmentStrategy;
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

export type MashupAlignmentStrategy = "continuous" | "paired-grid" | "downbeat" | "phrase-aware";

export const MASHUP_ALIGNMENT_CANDIDATES: ReadonlyArray<{
  id: MashupAlignmentStrategy;
  title: string;
}> = [
  { id: "continuous", title: "Continuous baseline" },
  { id: "paired-grid", title: "Paired beat-grid" },
  { id: "downbeat", title: "Measured downbeat" },
  { id: "phrase-aware", title: "Fingerprint-ranked passage" },
];

const LOCK_TOLERANCE = 0.03;
const CROSSFADE_MS = 250;

function crossfadeForSegment(startMs: number, endMs: number): number {
  return Math.max(0, Math.min(CROSSFADE_MS, Math.floor((endMs - startMs) / 2)));
}
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
/**
 * Octave-aware stretch choice.
 *
 * `warpRatioForTempos` sees one number per track, which is enough when both
 * readings are unambiguous but produces a wrong result when either tempo was
 * reported one octave high: a 143.555 BPM reading for a 72 BPM bed yields a
 * 0.697 ratio where the truth is 1.389, so the vocal is stretched twice as far
 * as it should be. Given the pulse family for each side we can pick the pairing
 * that needs the least warp, which is both the smallest audible artefact and
 * the most likely musical intent — a 2:1 pairing is a half-time feel, not a
 * reason to halve a vocal.
 *
 * Least warp alone is not sufficient: two octave pairings can cost exactly the
 * same (100/71.777 and 200/143.555 both give 1.393). Ties are broken in favour
 * of leaving the *bed* at its own reading, because the resolved bed tempo is
 * also the master tempo the arrangement measures bars and entry points with.
 * Inventing an octave for the bed on a tie would halve or double every bar
 * length in the plan, which is a far larger musical change than the warp — and
 * an equal-cost tie means the warp itself is unaffected either way.
 *
 * Falls back to the single readings when no family is supplied, so callers
 * without candidate evidence keep the previous behaviour exactly.
 */
export function warpRatioForTempoCandidates(
  vocalCandidates: readonly number[] | null | undefined,
  bedCandidates: readonly number[] | null | undefined,
  vocalBpm: number,
  bedBpm: number,
): { ratio: number; vocalBpm: number; bedBpm: number; ambiguous: boolean; consideredPairs: number } {
  const vocals = usableCandidates(vocalCandidates, vocalBpm);
  const beds = usableCandidates(bedCandidates, bedBpm);
  if (vocals.length === 0 || beds.length === 0) {
    return { ratio: 1, vocalBpm, bedBpm, ambiguous: false, consideredPairs: 0 };
  }
  const octaveJumps = (candidate: number, raw: number) =>
    raw > 0 ? Math.abs(Math.log2(candidate / raw)) : 0;
  type Choice = { ratio: number; vocalBpm: number; bedBpm: number; cost: number; vocalJumps: number; bedJumps: number };
  const choices: Choice[] = [];
  for (const v of vocals) {
    for (const b of beds) {
      const ratio = warpRatioForTempos(v, b);
      choices.push({
        ratio,
        vocalBpm: v,
        bedBpm: b,
        // Rounded so that mathematically identical pairings tie instead of
        // being separated by floating-point noise.
        cost: Math.round(Math.abs(Math.log(ratio)) * 1e6) / 1e6,
        vocalJumps: octaveJumps(v, vocalBpm),
        bedJumps: octaveJumps(b, bedBpm),
      });
    }
  }
  const ranked = [...choices].sort((left, right) =>
    left.cost - right.cost
    || left.bedJumps - right.bedJumps
    || left.vocalJumps - right.vocalJumps
    || left.bedBpm - right.bedBpm,
  );
  const best = ranked[0]!;
  // Ambiguous when a different octave pairing would need the same amount of
  // warp, so the envelope genuinely cannot justify the choice. The octave is
  // reported as uncertain rather than being presented as measured.
  const ambiguous = ranked.some((choice) =>
    Math.abs(choice.cost - best.cost) <= 1e-3
    && (Math.abs(choice.vocalBpm - best.vocalBpm) > 0.5 || Math.abs(choice.bedBpm - best.bedBpm) > 0.5),
  );
  return {
    ratio: best.ratio,
    vocalBpm: best.vocalBpm,
    bedBpm: best.bedBpm,
    ambiguous,
    consideredPairs: choices.length,
  };
}

function usableCandidates(candidates: readonly number[] | null | undefined, fallback: number): number[] {
  const source = candidates && candidates.length > 0 ? candidates : [fallback];
  const seen: number[] = [];
  for (const candidate of source) {
    if (!Number.isFinite(candidate) || candidate <= 0) continue;
    if (candidate < 40 || candidate > 300) continue;
    if (seen.some((existing) => Math.abs(existing - candidate) <= 0.5)) continue;
    seen.push(candidate);
  }
  return seen;
}

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

function alignBedEntryToMeasuredDownbeat(
  bed: MashupSourceProfile,
  requestedEntryMs: number,
): { at: number; why: string } | null {
  const grid = bed.downbeatGridMs;
  if (!hasReliableSessionDownbeatEvidence(bed.downbeatConfidence, grid)
    || grid!.some((position) => position > bed.durationMs)) return null;
  const at = grid!.find((position) => position >= requestedEntryMs - 20);
  if (at === undefined || at >= bed.durationMs) return null;
  return {
    at,
    why: `entry uses a measured bed downbeat at ${(at / 1000).toFixed(2)}s (downbeat confidence ${(bed.downbeatConfidence! * 100).toFixed(0)}%)`,
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
// Full-track arrangement — compare the donor and bed across the whole vocal
// body. When both tracks have trusted drum grids, map donor beats onto bed
// beats before ranking one coherent global offset; then check harmonic,
// transient and section context. Without paired grids, keep the measured
// first-activity fallback. No semantic verse/chorus/lyric claims are made.
//
// Voiced material is merged into units separated by at least
// ARRANGEMENT_UNIT_MERGE_GAP_MS of silence. Unit ORDER IS ALWAYS PRESERVED,
// units are never reordered, duplicated or cropped, and the renderer
// receives ordinary segments — the save/reopen/edit/restore/export paths are
// unchanged. A move is rejected when paired donor/bed beat phase gets worse.
// ------------------------------------------------------------------

const ARRANGEMENT_MAX_UNITS = 120;
const ARRANGEMENT_UNIT_MERGE_GAP_MS = 750;
const ARRANGEMENT_MIN_UNIT_MS = 150;
const ARRANGEMENT_MAX_SLOTS = 600;
/** One percentage point is the maximum phase-fit regression or minimum gain used in the trade-off. */
const PAIRED_BEAT_PHASE_SCORE_MARGIN = 0.01;

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

type PairedBeatPhaseFit = {
  score: number;
  matchedBeats: number;
  comparedBeats: number;
  meanErrorMs: number;
  toleranceMs: number;
};

const LOCAL_TEMPO_WARP_MAX_RATE_DEVIATION = 0.015;
const LOCAL_TEMPO_WARP_ANCHOR_EVERY_BEATS = 4;
const LOCAL_TEMPO_WARP_SMOOTHING_RADIUS_BEATS = 4;

/**
 * Compares both songs' measured beat grids after the planned tempo transform.
 * Each donor beat is compared with its corresponding bed beat, rather than any
 * nearby beat. This prevents a one-beat cycle slip from looking like a perfect
 * phase match. The tolerance is phase evidence, not mix-quality evidence.
 */
function scorePairedBeatPhase(
  donorBeatGridMs: readonly number[],
  bedBeatGridMs: readonly number[],
  donorStartMs: number,
  donorEndMs: number,
  bedStartMs: number,
  stretchRatio: number,
): PairedBeatPhaseFit | null {
  if (donorBeatGridMs.length < 8 || bedBeatGridMs.length < 8
    || !Number.isFinite(stretchRatio) || stretchRatio <= 0) return null;
  const pairs = correspondingBeatPairs(
    donorBeatGridMs, bedBeatGridMs, donorStartMs, donorEndMs, bedStartMs, stretchRatio,
  );
  if (!pairs || pairs.length < 8) return null;

  let score = 0;
  let matchedBeats = 0;
  let errorTotal = 0;
  let comparedBeats = 0;
  for (const pair of pairs) {
    const predictedBedBeatMs = bedStartMs + (pair.donorMs - donorStartMs) * stretchRatio;
    const errorMs = Math.abs(pair.bedMs - predictedBedBeatMs);
    comparedBeats += 1;
    errorTotal += errorMs;
    if (errorMs <= GROOVE_MATCH_TOLERANCE_MS) {
      matchedBeats += 1;
      score += 1 - errorMs / GROOVE_MATCH_TOLERANCE_MS;
    }
  }
  if (comparedBeats < 8) return null;
  return {
    score: score / comparedBeats,
    matchedBeats,
    comparedBeats,
    meanErrorMs: errorTotal / comparedBeats,
    toleranceMs: GROOVE_MATCH_TOLERANCE_MS,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function correspondingBeatPairs(
  donorGrid: readonly number[],
  bedGrid: readonly number[],
  donorStartMs: number,
  donorEndMs: number,
  bedStartMs: number,
  stretchRatio: number,
): Array<{ donorMs: number; bedMs: number }> | null {
  const donorBeats = donorGrid.filter((beat) => beat >= donorStartMs && beat <= donorEndMs);
  if (donorBeats.length < 8 || bedGrid.length < 8) return null;
  const donorIntervals = donorBeats.slice(1).map((beat, index) => beat - donorBeats[index]!);
  const bedIntervals = bedGrid.slice(1).map((beat, index) => beat - bedGrid[index]!);
  const donorPeriodMs = median(donorIntervals);
  const bedPeriodMs = median(bedIntervals);
  if (!(donorPeriodMs > 0) || !(bedPeriodMs > 0)) return null;
  const intervalsAreConsistent = (intervals: readonly number[], typicalMs: number) =>
    intervals.every((interval) => interval >= typicalMs * 0.55 && interval <= typicalMs * 1.75);
  // A missing/doubled detection causes an ordinal cycle slip. Do not fabricate
  // correspondence across it; the caller can keep the unwarped arrangement.
  if (!intervalsAreConsistent(donorIntervals, donorPeriodMs)
    || !intervalsAreConsistent(bedIntervals, bedPeriodMs)) return null;
  const scaledPeriodRatio = donorPeriodMs * stretchRatio / bedPeriodMs;
  const beatStride = [0.5, 1, 2].sort((left, right) =>
    Math.abs(left - scaledPeriodRatio) - Math.abs(right - scaledPeriodRatio))[0]!;
  if (Math.abs(beatStride - scaledPeriodRatio) > 0.08) return null;
  const firstExpectedBedBeatMs = bedStartMs + (donorBeats[0]! - donorStartMs) * stretchRatio;
  const bedStartIndex = nearestGridIndex(bedGrid, firstExpectedBedBeatMs);
  const pairs: Array<{ donorMs: number; bedMs: number }> = [];
  for (const [index, donorMs] of donorBeats.entries()) {
    const bedMs = bedGrid[bedStartIndex + Math.round(index * beatStride)];
    if (bedMs !== undefined) pairs.push({ donorMs, bedMs });
  }
  return pairs.length >= 8 ? pairs : null;
}

function outputTimeForSourceTime(
  sourceMs: number,
  points: readonly { sourceMs: number; outputMs: number }[],
): number {
  let low = 0;
  let high = points.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (points[middle]!.sourceMs <= sourceMs) low = middle;
    else high = middle;
  }
  const left = points[low]!;
  const right = points[Math.min(points.length - 1, low + 1)]!;
  const span = right.sourceMs - left.sourceMs;
  const fraction = span > 0 ? (sourceMs - left.sourceMs) / span : 0;
  return left.outputMs + fraction * (right.outputMs - left.outputMs);
}

function scorePairedBeatPhaseWithMap(
  donorBeatGridMs: readonly number[],
  bedBeatGridMs: readonly number[],
  donorStartMs: number,
  donorEndMs: number,
  bedStartMs: number,
  stretchRatio: number,
  points: readonly { sourceMs: number; outputMs: number }[],
): PairedBeatPhaseFit | null {
  if (donorBeatGridMs.length < 8 || bedBeatGridMs.length < 8 || points.length < 2 || stretchRatio <= 0) return null;
  const pairs = correspondingBeatPairs(donorBeatGridMs, bedBeatGridMs, donorStartMs, donorEndMs, bedStartMs, stretchRatio);
  if (!pairs || pairs.length < 8) return null;
  let matchedBeats = 0;
  let errorTotal = 0;
  let comparedBeats = 0;
  for (const pair of pairs) {
    const relativeSourceMs = pair.donorMs - donorStartMs;
    if (relativeSourceMs < points[0]!.sourceMs || relativeSourceMs > points.at(-1)!.sourceMs) continue;
    const mappedBedMs = bedStartMs + outputTimeForSourceTime(relativeSourceMs, points);
    const errorMs = Math.abs(pair.bedMs - mappedBedMs);
    comparedBeats += 1;
    errorTotal += errorMs;
    if (errorMs <= GROOVE_MATCH_TOLERANCE_MS) matchedBeats += 1;
  }
  return comparedBeats < 8 ? null : {
    score: matchedBeats / comparedBeats,
    matchedBeats,
    comparedBeats,
    meanErrorMs: errorTotal / comparedBeats,
    toleranceMs: GROOVE_MATCH_TOLERANCE_MS,
  };
}

/**
 * Correct only slow, measured phase drift between the two trusted drum grids.
 * The continuous vocal body remains one performance; rate changes are bounded
 * to ±1.5% around the verified global BPM transform and smoothed over beats.
 */
function localTempoWarpForPair(
  vocals: MashupSourceProfile,
  bed: MashupSourceProfile,
  body: { fromMs: number; toMs: number },
  bedStartMs: number,
  stretchRatio: number,
): NonNullable<MashupSegment["localTempoMap"]> | null {
  const donorGrid = trustedAnalysisBeatGrid(vocals.beatGridMs, vocals.bpmConfidence, vocals.beatConfidence);
  const bedGrid = trustedAnalysisBeatGrid(bed.beatGridMs, bed.bpmConfidence, bed.beatConfidence);
  if (!donorGrid || !bedGrid || body.toMs <= body.fromMs || stretchRatio <= 0) return null;
  const beatPairs = correspondingBeatPairs(donorGrid, bedGrid, body.fromMs, body.toMs, bedStartMs, stretchRatio);
  if (!beatPairs || beatPairs.length < 24) return null;

  const rawPhaseErrors = beatPairs.map((pair) =>
    pair.bedMs - (bedStartMs + (pair.donorMs - body.fromMs) * stretchRatio));
  const smoothedPhaseErrors = rawPhaseErrors.map((_error, index) => median(
    rawPhaseErrors.slice(
      Math.max(0, index - LOCAL_TEMPO_WARP_SMOOTHING_RADIUS_BEATS),
      Math.min(rawPhaseErrors.length, index + LOCAL_TEMPO_WARP_SMOOTHING_RADIUS_BEATS + 1),
    ),
  ));
  const initialPhase = smoothedPhaseErrors[0] ?? 0;
  const anchorIndexes = new Set<number>([0, beatPairs.length - 1]);
  for (let index = LOCAL_TEMPO_WARP_ANCHOR_EVERY_BEATS; index < beatPairs.length - 1; index += LOCAL_TEMPO_WARP_ANCHOR_EVERY_BEATS) {
    anchorIndexes.add(index);
  }

  const sourceSpanMs = body.toMs - body.fromMs;
  const beatAnchors = [...anchorIndexes].sort((left, right) => left - right).map((index) => ({
    sourceMs: beatPairs[index]!.donorMs - body.fromMs,
    requestedCorrectionMs: smoothedPhaseErrors[index]! - initialPhase,
  }));
  const anchors = [
    { sourceMs: 0, requestedCorrectionMs: 0 },
    ...beatAnchors.filter((anchor) => anchor.sourceMs > 0 && anchor.sourceMs < sourceSpanMs),
    { sourceMs: sourceSpanMs, requestedCorrectionMs: smoothedPhaseErrors.at(-1)! - initialPhase },
  ];
  const points: Array<{ sourceMs: number; outputMs: number }> = [{ sourceMs: 0, outputMs: 0 }];
  let previousCorrection = 0;
  for (const anchor of anchors.slice(1)) {
    const previous = points.at(-1)!;
    const sourceDelta = anchor.sourceMs - previous.sourceMs;
    if (sourceDelta <= 0) continue;
    const correctionLimit = sourceDelta * stretchRatio * LOCAL_TEMPO_WARP_MAX_RATE_DEVIATION;
    const correctionDelta = Math.max(-correctionLimit, Math.min(
      correctionLimit,
      anchor.requestedCorrectionMs - previousCorrection,
    ));
    const correction = previousCorrection + correctionDelta;
    const outputMs = anchor.sourceMs * stretchRatio + correction;
    if (outputMs <= previous.outputMs) return null;
    points.push({ sourceMs: anchor.sourceMs, outputMs });
    previousCorrection = correction;
  }
  if (points.length < 3 || points.at(-1)!.sourceMs !== sourceSpanMs) return null;

  const baselinePoints = [
    { sourceMs: 0, outputMs: 0 },
    { sourceMs: sourceSpanMs, outputMs: sourceSpanMs * stretchRatio },
  ];
  const baselineFit = scorePairedBeatPhaseWithMap(donorGrid, bedGrid, body.fromMs, body.toMs, bedStartMs, stretchRatio, baselinePoints);
  const correctedFit = scorePairedBeatPhaseWithMap(
    donorGrid, bedGrid, body.fromMs, body.toMs, bedStartMs + initialPhase, stretchRatio, points,
  );
  if (!baselineFit || !correctedFit) return null;
  const minimumGain = Math.max(3, Math.ceil(baselineFit.comparedBeats * 0.01));
  if (correctedFit.matchedBeats < baselineFit.matchedBeats + minimumGain
    || correctedFit.meanErrorMs > baselineFit.meanErrorMs - 3) return null;
  return {
    points,
    baselineFit,
    correctedFit,
    maximumRateDeviationPercent: LOCAL_TEMPO_WARP_MAX_RATE_DEVIATION * 100,
    entryShiftMs: initialPhase,
  };
}

function nearestGridIndex(grid: readonly number[], timeMs: number): number {
  let low = 0;
  let high = grid.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (grid[middle]! < timeMs) low = middle + 1;
    else high = middle;
  }
  const before = Math.max(0, low - 1);
  const after = Math.min(grid.length - 1, low);
  return Math.abs(grid[before]! - timeMs) <= Math.abs(grid[after]! - timeMs) ? before : after;
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
  const donorBeatGrid = trustedAnalysisBeatGrid(vocals.beatGridMs, vocals.bpmConfidence, vocals.beatConfidence);
  const bedBeatGrid = trustedAnalysisBeatGrid(bed.beatGridMs, bed.bpmConfidence, bed.beatConfidence);
  const donorBeatsInBody = donorBeatGrid?.filter((beat) => beat >= body.fromMs && beat <= body.toMs) ?? [];
  const canComparePairedBeatGrids = gridTrusted
    && bedBeatGrid !== null
    && donorBeatGrid !== null
    && donorBeatsInBody.length >= 8;
  const baselineBeatPhaseFit = canComparePairedBeatGrids
    ? scorePairedBeatPhase(donorBeatGrid, bedBeatGrid, body.fromMs, body.toMs, overlayEntryMs, stretchRatio)
    : null;
  const evidence = {
    chordTimeline: harmonyEvents.length >= 4 && vocalPitchFrames.length >= 12,
    drumTransients: drumEvents.length >= 8,
    bassAttacks: bassEvents.length >= 8,
    beatGrid: gridTrusted,
    pairedBeatGrids: baselineBeatPhaseFit !== null,
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

  // A beat-aligned answer must not destroy the donor's phrasing. Instead of
  // assigning every voiced interval to a different bed beat, test only global
  // offsets: every interval keeps the same source-relative time after the one
  // evidence-supported tempo stretch. The first measured vocal unit anchors
  // the whole body; later units are never independently snapped or reordered.
  const firstUnit = unitTimings[0]!;
  const bodySpanMs = Math.round((body.toMs - body.fromMs) * stretchRatio);
  const sourceAnchorMs = canComparePairedBeatGrids
    ? donorBeatsInBody[0]!
    : firstUnit.fromMs;
  let coherentEntryMs: number | null = null;
  let coherentScore = Number.NEGATIVE_INFINITY;
  let coherentPlaced = 0;
  let coherentBeatPhaseFit: PairedBeatPhaseFit | null = null;
  let coherentPhaseSafe = false;
  for (const anchorMs of slots) {
    // When both tracks have a trusted drum grid, align a donor drum beat to a
    // bed drum beat. Otherwise preserve the old first-vocal-activity anchor.
    const candidateEntryMs = Math.round(anchorMs - (sourceAnchorMs - body.fromMs) * stretchRatio);
    if (candidateEntryMs < 0 || candidateEntryMs + bodySpanMs > bed.durationMs + 1) continue;
    let candidateScore = 0;
    let candidatePlaced = 0;
    for (const unit of unitTimings) {
      const startMs = Math.round(candidateEntryMs + (unit.fromMs - body.fromMs) * stretchRatio);
      const endMs = startMs + Math.round((unit.toMs - unit.fromMs) * stretchRatio);
      if (startMs < 0 || endMs > bed.durationMs + 1) continue;
      candidateScore += arrangementFeatureScore(unit, startMs, context).score;
      candidatePlaced += 1;
    }
    const candidateBeatPhaseFit = canComparePairedBeatGrids && donorBeatGrid && bedBeatGrid
      ? scorePairedBeatPhase(donorBeatGrid, bedBeatGrid, body.fromMs, body.toMs, candidateEntryMs, stretchRatio)
      : null;
    const candidatePhaseSafe = baselineBeatPhaseFit === null
      || (candidateBeatPhaseFit !== null
        && candidateBeatPhaseFit.score >= baselineBeatPhaseFit.score - PAIRED_BEAT_PHASE_SCORE_MARGIN);
    const phasePreferred = candidateBeatPhaseFit !== null
      && coherentBeatPhaseFit !== null
      && candidateBeatPhaseFit.score > coherentBeatPhaseFit.score + 1e-6;
    const phaseTied = candidateBeatPhaseFit === null
      || coherentBeatPhaseFit === null
      || Math.abs(candidateBeatPhaseFit.score - coherentBeatPhaseFit.score) <= 1e-6;
    const scorePreferred = candidateScore > coherentScore + 1e-9
      || (Math.abs(candidateScore - coherentScore) <= 1e-9
        && Math.abs(candidateEntryMs - overlayEntryMs) < Math.abs((coherentEntryMs ?? Infinity) - overlayEntryMs));
    if (candidatePlaced > coherentPlaced
      || (candidatePlaced === coherentPlaced && (
        (candidatePhaseSafe && !coherentPhaseSafe)
        || (candidatePhaseSafe === coherentPhaseSafe
          && (phasePreferred || (phaseTied && scorePreferred)))
      ))) {
      coherentEntryMs = candidateEntryMs;
      coherentScore = candidateScore;
      coherentPlaced = candidatePlaced;
      coherentBeatPhaseFit = candidateBeatPhaseFit;
      coherentPhaseSafe = candidatePhaseSafe;
    }
  }
  if (coherentPlaced === 0) coherentScore = 0;

  const contextImprovementThreshold = Math.max(0.5, 0.03 * Math.abs(overlayScore));
  const contextImproved = coherentScore - overlayScore > contextImprovementThreshold;
  const pairedPhaseImproved = baselineBeatPhaseFit !== null
    && coherentBeatPhaseFit !== null
    && coherentBeatPhaseFit.score > baselineBeatPhaseFit.score + PAIRED_BEAT_PHASE_SCORE_MARGIN;
  const contextNotMateriallyWorse = coherentScore - overlayScore >= -contextImprovementThreshold;
  const alignmentAccepted = baselineBeatPhaseFit === null
    ? contextImproved
    : coherentBeatPhaseFit !== null && coherentPhaseSafe && (
      contextImproved || (pairedPhaseImproved && contextNotMateriallyWorse)
    );
  const coherentBetter = coherentEntryMs !== null
    && coherentPlaced >= overlayPlaced
    && Math.abs(coherentEntryMs - overlayEntryMs) > 1
    && alignmentAccepted;
  const selected: "coherent-overlay" | "continuous-overlay" =
    coherentBetter ? "coherent-overlay" : "continuous-overlay";
  const selectedEntryMs = coherentBetter ? coherentEntryMs! : overlayEntryMs;
  const selectedPlaced = coherentBetter ? coherentPlaced : overlayPlaced;
  const selectedBeatPhaseFit = coherentBetter ? coherentBeatPhaseFit : baselineBeatPhaseFit;
  const improvementRatio = coherentEntryMs !== null && Number.isFinite(coherentScore)
    ? (coherentScore - overlayScore) / Math.max(1, Math.abs(overlayScore))
    : null;

  const placements: MashupArrangementPlacement[] = [];
  for (const unit of unitTimings) {
    const bedStartMs = Math.round(selectedEntryMs + (unit.fromMs - body.fromMs) * stretchRatio);
    const endMs = bedStartMs + Math.round((unit.toMs - unit.fromMs) * stretchRatio);
    if (bedStartMs < 0 || endMs > bed.durationMs + 1) continue;
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
    evidence.pairedBeatGrids ? "paired donor/bed beat grids" : null,
    evidence.sectionRoles ? "inferred bed section roles (unverified hypotheses)" : null,
  ].filter(Boolean).join(", ");
  if (coherentBetter) {
    rationale.push(
      `${evidence.pairedBeatGrids ? "donor drum beats are mapped to the bed drum grid" : "the first activity window is anchored to a measured beat"}; the whole vocal body keeps its source-relative timing at the same ${stretchRatio.toFixed(3)}× tempo ratio (${evidenceSources})`,
    );
    if (coherentBeatPhaseFit && baselineBeatPhaseFit) {
      rationale.push(
        `paired beat-grid fit: ${coherentBeatPhaseFit.matchedBeats}/${coherentBeatPhaseFit.comparedBeats} donor beats land within ${coherentBeatPhaseFit.toleranceMs} ms of bed beats (current entry: ${baselineBeatPhaseFit.matchedBeats}/${baselineBeatPhaseFit.comparedBeats})`,
      );
    }
    rationale.push(
      `coherent placement scored ${coherentScore.toFixed(2)} against the current continuous entry's ${overlayScore.toFixed(2)}; the entire body moved by ${((selectedEntryMs - overlayEntryMs) / 1000).toFixed(1)}s without independently moving or cutting its voice-active windows`,
    );
    warnings.push(
      "The coherent placement preserves the full vocal body's internal gaps as one clip. Activity windows are coarse voice-activity measurements, not lyric timing or verse/chorus labels; the relative score is not a sound-quality guarantee.",
    );
  } else {
    rationale.push(
      `full-track coherent-placement search evaluated ${unitTimings.length} voice-activity window(s) at ${slots.length} possible global anchors; moving the entire vocal body scored ${coherentScore.toFixed(2)} versus ${overlayScore.toFixed(2)} at the current entry, with ${coherentPlaced}/${unitTimings.length} windows fitting as a group`,
    );
    warnings.push(coherentEntryMs === null
      ? "No measured global anchor can fit the complete vocal body in the bed; the current continuous entry is retained."
      : baselineBeatPhaseFit !== null && coherentBeatPhaseFit !== null && !coherentPhaseSafe
        ? "The candidate whole-body move would worsen the paired donor-to-bed beat-grid fit; the current entry is retained. Individual activity windows are never moved separately."
        : "No whole-body move beat the current entry by the required margin; the current continuous vocal placement is retained. Individual activity windows are never moved separately.");
  }
  if (!evidence.pairedBeatGrids) {
    warnings.push("A paired donor-and-bed beat-grid check was unavailable; this plan cannot verify both tracks' beat phase.");
  }
  const unitsSkipped = unitTimings.length - selectedPlaced;
  if (unitsSkipped > 0) {
    warnings.push(`${unitsSkipped} voiced unit(s) did not fit before the end of the bed and are not placed; the bed simply ends first.`);
  }

  return {
    engine: MASHUP_PLANNER_ENGINE,
    mode: selected,
    selected,
    coherentEntryMs: selectedEntryMs,
    coherentScore: Number((coherentEntryMs === null ? 0 : coherentScore).toFixed(4)),
    overlayScore: Number(overlayScore.toFixed(4)),
    pairedBeatPhaseFit: selectedBeatPhaseFit,
    baselineBeatPhaseFit,
    improvementRatio: improvementRatio === null ? null : Number(improvementRatio.toFixed(4)),
    unitsTotal: unitTimings.length,
    unitsPlaced: placements.length,
    unitsSkipped,
    coherentUnitsPlaced: coherentPlaced,
    continuousUnitsPlaced: overlayPlaced,
    evidence: {
      chordTimeline: evidence.chordTimeline,
      drumTransients: evidence.drumTransients,
      bassAttacks: evidence.bassAttacks,
      beatGrid: gridTrusted,
      pairedBeatGrids: evidence.pairedBeatGrids,
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
  options: { searchPassages: boolean } = { searchPassages: true },
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
  const passageDecision = options.searchPassages
    ? rankedPassageEntry(vocals, bed, body, base.at, masterBpm, stretchRatio, vocalPitchShiftSemitones)
    : {
        match: null,
        reason: "phrase-passage ranking was not run for this comparison candidate",
        search: {
          evaluatedDonorPassageCount: 0,
          rankableDonorPassageCount: 0,
          evaluations: [],
          selectedDonorSectionId: null,
          selectedBedSectionId: null,
        },
      };
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
    why: `${base.why}; ${phraseTiming}; ${passageDecision.reason}, so transient coincidences alone do not shift this passage-entry fallback`,
    warning: options.searchPassages
      ? `Passage matching remains a measured-beat fallback because ${passageDecision.reason}.${grid ? "" : " No trusted bed beat grid was available."}${body.vocalActivityEvidence ? "" : " No current isolated-vocal activity or pitch intervals were available."} A separate whole-body fit may move the complete performance using its combined evidence; these observations are not lyric phrases, and event timing does not establish musical fit or listening quality.`
      : `This candidate deliberately skips passage ranking and uses the baseline bed entry; it is beat-snapped only when a trusted bed beat grid exists. It is not a lyric-aware or sound-quality judgement.`,
    passageSearch: passageDecision.search,
  };
}

export function planMashup(
  vocals: MashupSourceProfile,
  bed: MashupSourceProfile,
  options: { strategy?: MashupAlignmentStrategy } = {},
): MashupPlanResult {
  const strategy = options.strategy ?? "phrase-aware";
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
    // A single confidence number cannot express octave ambiguity, and a
    // hats-heavy part reads high with confidence 1.0. Choose the pulse-family
    // pairing that needs the least warp instead of taking both readings at face
    // value; identical readings reproduce the previous ratio exactly.
    const octaveChoice = warpRatioForTempoCandidates(
      vocals.bpmCandidates, bed.bpmCandidates, effectiveVocalBpm, masterBpm,
    );
    stretchRatio = octaveChoice.ratio;
    // Bar and entry decisions are derived from masterBpm. If the pulse family
    // resolved the bed to a different octave than the raw reading, the master
    // tempo has to move with it or the vocal would be warped for one tempo
    // while the arrangement used bars measured at another.
    if (Math.abs(octaveChoice.bedBpm - masterBpm) > 0.5) {
      rationale.push(
        `master tempo ${masterBpm} BPM is an octave reading; using ${octaveChoice.bedBpm} BPM `
        + `so bar and entry decisions match the vocal warp.`,
      );
      masterBpm = octaveChoice.bedBpm;
    }
    if (octaveChoice.ambiguous) {
      warnings.push(
        `Tempo octave is ambiguous (${octaveChoice.vocalBpm} vs ${octaveChoice.bedBpm} BPM both fit); `
        + `using the pairing that needs the least stretch (×${stretchRatio.toFixed(3)}).`,
      );
    }
    const rawRatio = warpRatioForTempos(effectiveVocalBpm, trustedBedBpm);
    if (Math.abs(octaveChoice.ratio - rawRatio) > 1e-6) {
      rationale.push(
        `tempo octave resolved from the pulse family: ${octaveChoice.vocalBpm} BPM over `
        + `${octaveChoice.bedBpm} BPM needs ×${stretchRatio.toFixed(3)}, against `
        + `×${rawRatio.toFixed(3)} for the raw readings.`,
      );
    }
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
  const downbeatEntry = strategy === "downbeat"
    ? alignBedEntryToMeasuredDownbeat(bed, requestedEntry.at)
    : null;
  if (strategy === "downbeat" && !downbeatEntry) {
    return {
      ok: false,
      reason: "A measured, checksum-current bed downbeat grid with confidence of at least 0.65 is unavailable. Waveyard will not infer bar starts from the beat grid.",
    };
  }
  const entryRequestMs = downbeatEntry?.at ?? requestedEntry.at;
  const alignedEntry = grooveAwareBedEntry(
    vocals,
    bed,
    body,
    entryRequestMs,
    masterBpm,
    stretchRatio,
    pitchMove.semitones,
    { searchPassages: strategy === "phrase-aware" },
  );
  const entry = {
    at: alignedEntry.at,
    why: [
      requestedEntry.why,
      downbeatEntry?.why,
      alignedEntry.why,
    ].filter(Boolean).join("; "),
  };
  rationale.push(entry.why);
  if (alignedEntry.warning) warnings.push(alignedEntry.warning);
  if (strategy === "continuous") {
    rationale.push("continuous baseline: the full vocal body keeps its source timing; passage ranking, whole-body entry search, and local WSOLA correction are disabled.");
  } else if (strategy === "paired-grid") {
    rationale.push("paired-grid comparison: phrase ranking is disabled so the measured donor/bed beat-phase search can be judged independently.");
  } else if (strategy === "downbeat") {
    rationale.push("downbeat comparison: entry is anchored to an independently measured bed downbeat; no 4/4 phase is inferred from ordinary beat positions.");
  } else if (strategy === "phrase-aware") {
    rationale.push("phrase-aware comparison: only checksum-current vocal passage fingerprints and their measured bed alternatives can select a different donor passage.");
  }
  warnings.push(...(vocals.grooveWarnings ?? []), ...(bed.grooveWarnings ?? []));

  rationale.push(body.why);
  if (body.vocalActivityEvidence) {
    rationale.push("the crop keeps 250ms around measured voiced activity; word, syllable, and lyrical-meaning timing are not analyzed.");
  } else {
    warnings.push("No current isolated-vocal voicing intervals are available; the entry is not lyric-aware and the full vocal source window is retained.");
  }

  const vocalSpanMs = Math.max(0, body.toMs - body.fromMs);
  // Timeline coordinates and persisted clip durations are integer milliseconds.
  const stretchedMs = Math.round(vocalSpanMs * stretchRatio);
  const bedRoomMs = Math.max(0, bed.durationMs - entry.at);

  const segments: MashupSegment[] = [];
  let arrangement: MashupArrangement | null = null;

  // Intelligently arrange full-length vocal segments across the bed timeline.
  // First compare coherent whole-body offsets even when the donor is shorter:
  // moving one complete performance can improve its musical fit without
  // destroying its internal pace. Only use a reprise when no coherent move wins.
  if ((strategy === "continuous" || strategy === "downbeat") && stretchedMs > 0 && bedRoomMs > 0) {
    const endMs = Math.round(Math.min(bed.durationMs, entry.at + stretchedMs));
    segments.push({
      mashupStartMs: entry.at,
      mashupEndMs: endMs,
      vocalsFromMs: body.fromMs,
      vocalsToMs: body.toMs,
      crossfadeMs: crossfadeForSegment(entry.at, endMs),
      rationale: `complete vocal body runs ${(stretchedMs / 1000).toFixed(1)}s from ${(entry.at / 1000).toFixed(1)}s; no local timing map is applied`,
      stemType: "vocals",
      sourceRole: "vocals",
    });
    if (stretchedMs > bedRoomMs) {
      warnings.push("The complete vocal body extends beyond the available bed and will fade at the bed's end.");
    }
  } else if (strategy !== "continuous" && strategy !== "downbeat" && stretchedMs > 0 && bedRoomMs > 0) {
    const passageMatchSelected = alignedEntry.passageSearch?.selectedDonorSectionId != null;
    if (!passageMatchSelected) {
      arrangement = planArrangement(vocals, bed, body, entry.at, masterBpm, stretchRatio, pitchMove.semitones);
    }
    if (arrangement) {
      rationale.push(...arrangement.rationale);
      warnings.push(...arrangement.warnings);
      if (arrangement.pairedBeatPhaseFit && arrangement.baselineBeatPhaseFit) {
        rationale.push(
          `paired beat-grid fit for the selected ${arrangement.selected} entry: ${arrangement.pairedBeatPhaseFit.matchedBeats}/${arrangement.pairedBeatPhaseFit.comparedBeats} beats within ${GROOVE_MATCH_TOLERANCE_MS} ms (mean ${arrangement.pairedBeatPhaseFit.meanErrorMs.toFixed(1)} ms); continuous baseline ${arrangement.baselineBeatPhaseFit.matchedBeats}/${arrangement.baselineBeatPhaseFit.comparedBeats} (mean ${arrangement.baselineBeatPhaseFit.meanErrorMs.toFixed(1)} ms)`,
        );
      }
    }
    if (arrangement?.selected === "coherent-overlay" || stretchedMs >= bedRoomMs * 0.70) {
      // Keep the donor's full vocal body and all of its internal pauses in one
      // clip. Even when a different bed entry ranks better, move the whole
      // performance together rather than snapping short activity windows
      // independently and turning phrases into a sporadic sequence.
      const baseSelectedEntryMs = Math.round(arrangement?.selected === "coherent-overlay"
        ? arrangement.coherentEntryMs
        : entry.at);
      const localTempoMap = localTempoWarpForPair(vocals, bed, body, baseSelectedEntryMs, stretchRatio);
      const localEntryMs = Math.round(baseSelectedEntryMs + (localTempoMap?.entryShiftMs ?? 0));
      const localWarpFitsBed = localTempoMap !== null && localEntryMs >= 0
        && localEntryMs + Math.round(localTempoMap.points.at(-1)!.outputMs) <= bed.durationMs;
      const acceptedTempoMap = localWarpFitsBed ? localTempoMap : null;
      const selectedEntryMs = acceptedTempoMap ? localEntryMs : baseSelectedEntryMs;
      const selectedRoomMs = Math.max(0, bed.durationMs - selectedEntryMs);
      const effectiveVocalDurationMs = acceptedTempoMap
        ? Math.round(acceptedTempoMap.points.at(-1)!.outputMs)
        : stretchedMs;
      const segEndMs = Math.round(Math.min(bed.durationMs, selectedEntryMs + effectiveVocalDurationMs));
      segments.push({
        mashupStartMs: selectedEntryMs,
        mashupEndMs: segEndMs,
        vocalsFromMs: body.fromMs,
        vocalsToMs: body.toMs,
        crossfadeMs: crossfadeForSegment(selectedEntryMs, segEndMs),
        ...(acceptedTempoMap ? { localTempoMap: acceptedTempoMap } : {}),
        rationale: acceptedTempoMap
          ? `complete vocal body runs ${(effectiveVocalDurationMs / 1000).toFixed(1)}s from ${(selectedEntryMs / 1000).toFixed(1)}s; local WSOLA rate varies by at most ${acceptedTempoMap.maximumRateDeviationPercent.toFixed(1)}% to reduce paired-grid drift while preserving one continuous performance`
          : `complete vocal body runs ${(stretchedMs / 1000).toFixed(1)}s from ${(selectedEntryMs / 1000).toFixed(1)}s; internal donor timing is preserved`,
        stemType: "vocals",
        sourceRole: "vocals",
      });
      if (acceptedTempoMap) {
        rationale.push(
          `bounded local beat correction shifted the entry ${acceptedTempoMap.entryShiftMs.toFixed(0)} ms and improved paired-grid fit from ${acceptedTempoMap.baselineFit.matchedBeats}/${acceptedTempoMap.baselineFit.comparedBeats} beats (mean ${acceptedTempoMap.baselineFit.meanErrorMs.toFixed(1)} ms) to ${acceptedTempoMap.correctedFit.matchedBeats}/${acceptedTempoMap.correctedFit.comparedBeats} (mean ${acceptedTempoMap.correctedFit.meanErrorMs.toFixed(1)} ms); this follows drum-grid timing, not lyric transcription or a subjective mix-quality score`,
        );
        warnings.push("Local beat correction uses a gently varying, pitch-preserving WSOLA rate on the complete vocal body. It does not identify lyric phrases or guarantee that the resulting mashup sounds good.");
      }
      if (effectiveVocalDurationMs > selectedRoomMs) {
        warnings.push(`The tempo-matched vocal (${(effectiveVocalDurationMs / 1000).toFixed(1)}s) is longer than the bed has room (${(selectedRoomMs / 1000).toFixed(1)}s) — it fades out at the bed's end.`);
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
        crossfadeMs: crossfadeForSegment(entry.at, firstSegmentEnd),
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
            crossfadeMs: crossfadeForSegment(secondStart, Math.min(bed.durationMs, secondStart + vocalPortionMs * stretchRatio)),
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
      crossfadeMs: crossfadeForSegment(entry.at, Math.min(bed.durationMs, entry.at + stretchedMs)),
      rationale: `vocals run ${(stretchedMs / 1000).toFixed(1)}s over the bed`,
      stemType: "vocals",
      sourceRole: "vocals",
    });
  }

  return {
    ok: true,
    plan: {
      engine: MASHUP_PLANNER_ENGINE,
      alignmentStrategy: strategy,
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

export type MashupAlignmentCandidate = {
  id: MashupAlignmentStrategy;
  title: string;
  available: boolean;
  unavailableReason?: string;
  plan: MashupPlan | null;
};

/** Run the existing production strategies over the same source profiles. */
export function compareMashupAlignmentCandidates(
  vocals: MashupSourceProfile,
  bed: MashupSourceProfile,
): MashupAlignmentCandidate[] {
  return MASHUP_ALIGNMENT_CANDIDATES.map(({ id, title }) => {
    const result = planMashup(vocals, bed, { strategy: id });
    if (!result.ok) {
      return { id, title, available: false, unavailableReason: result.reason, plan: null };
    }
    if (result.plan.segments.length === 0) {
      return {
        id,
        title,
        available: false,
        unavailableReason: "This strategy could not place a vocal segment inside the instrumental bed.",
        plan: result.plan,
      };
    }
    if (id === "paired-grid" && !result.plan.arrangement?.evidence.pairedBeatGrids) {
      return {
        id,
        title,
        available: false,
        unavailableReason: "Both songs need checksum-current trusted beat grids before a paired-grid candidate can be compared.",
        plan: result.plan,
      };
    }
    if (id === "phrase-aware" && !result.plan.passageSearch?.selectedDonorSectionId) {
      return {
        id,
        title,
        available: false,
        unavailableReason: "No measured vocal passage had a rankable bed match. The continuous fallback is still available.",
        plan: result.plan,
      };
    }
    return { id, title, available: true, plan: result.plan };
  });
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
    // Evidence packets carry a single tempo; only a profile that was analysed
    // directly can carry a pulse family, so never invent one here.
    bpmCandidates: tempo !== null ? tempoCandidates(tempo.bpm ?? null) : profile.bpmCandidates ?? null,
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
  /**
   * Optional complementary **donor** stems for deliberate layering, keyed
   * `donor_<stemType>`. These are never added automatically: only the stem
   * types named in `layerStemTypes` are summed, and each starts at the
   * planned vocal entry rather than at timeline zero.
   */
  stems?: Map<string, StereoBuffer>;
  /**
   * Donor stem types the caller deliberately chose to layer (e.g. `drums`).
   * Empty/absent means the default composition: vocal donor over the
   * instrumental bed only, with no second rhythm section.
   */
  layerStemTypes?: readonly string[];
  sampleRate: number;
  /**
   * Mix-bus controls. Defaults are the conservative production values; a
   * caller may disable balance matching or limiting only for a controlled
   * A/B render.
   */
  mix?: {
    matchVocalLoudness?: boolean;
    limit?: boolean;
  };
};

/** Donor stem gains when a caller explicitly layers one over the bed. */
const DONOR_LAYER_GAIN = 0.6;

function trapezoidGain(atMs: number, startMs: number, endMs: number, crossfadeMs: number): number {
  if (atMs < startMs || atMs > endMs) return 0;
  const into = atMs - startMs;
  const remaining = endMs - atMs;
  if (into < crossfadeMs) return into / crossfadeMs;
  if (remaining < crossfadeMs) return remaining / crossfadeMs;
  return 1;
}

/** Mix the plan: bed (ducked under vocals) + stretched/pitched vocal
 *  segments with trapezoid fades, then a measured mix bus.
 *
 *  Composition rule (the product default): the vocal donor supplies the
 *  vocal and the instrumental bed supplies drums, bass and everything else.
 *  Donor stems are only summed when the caller names them in
 *  `layerStemTypes`, and each one is offset to the planned vocal entry so a
 *  late-entering vocal never drags an unaligned second drum kit in from
 *  timeline zero.
 *
 *  Mix rule: the vocal is gain-matched to the bed's measured loudness and
 *  the sum is scaled into headroom and passed through the existing
 *  stereo-linked true-peak limiter. Nothing is hard-clipped. */
export function renderMashupWithBus(
  plan: MashupPlan,
  input: MashupPcmInput,
): { pcm: StereoBuffer; mix: MashupMixResult } {
  const { sampleRate } = input;
  const totalFrames = Math.max(1, Math.round((plan.durationMs / 1000) * sampleRate));
  const summed = new Float32Array(totalFrames * 2);

  const balance = input.mix?.matchVocalLoudness === false
    ? null
    : planMashupBalance({ vocals: input.vocals, bed: input.bed, sampleRate });
  const vocalGain = balance === null ? 1 : 10 ** (balance.vocalGainDb / 20);

  // Prepared vocal segments (stretched once, then pitched once each).
  const prepared = plan.segments.map((segment) => {
    const fromFrame = Math.max(0, Math.round((segment.vocalsFromMs / 1000) * sampleRate) * 2);
    const toFrame = Math.min(input.vocals.length, Math.max(fromFrame, Math.round((segment.vocalsToMs / 1000) * sampleRate) * 2));
    const span = input.vocals.slice(fromFrame, toFrame);
    if (span.length === 0) {
      return { segment, pcm: new Float32Array(0) };
    }
    let stretched: StereoBuffer;
    if (segment.localTempoMap) {
      const inputFrames = span.length / 2;
      const outputFrames = Math.max(1, Math.round(
        segment.localTempoMap.points.at(-1)!.outputMs * sampleRate / 1000,
      ));
      const timeMap: TimeStretchMapPoint[] = segment.localTempoMap.points.map((point) => ({
        outputFrame: Math.round(point.outputMs * sampleRate / 1000),
        inputFrame: Math.round(point.sourceMs * sampleRate / 1000),
      }));
      timeMap[0] = { outputFrame: 0, inputFrame: 0 };
      timeMap[timeMap.length - 1] = { outputFrame: outputFrames, inputFrame: inputFrames };
      stretched = timeStretch(span, outputFrames / inputFrames, sampleRate, timeMap);
    } else {
      stretched = timeStretch(span, plan.vocalsStretchRatio, sampleRate);
    }
    return { segment, pcm: pitchShift(stretched, plan.vocalsPitchSemitones, sampleRate) };
  });

  // Deliberately layered donor stems only. Everything else in the donor's
  // separation run stays out of the mix; the bed already carries those roles.
  const layerTypes = new Set((input.layerStemTypes ?? []).map((type) => String(type)));
  const preparedStems: Array<{ type: string; pcm: StereoBuffer; offsetFrames: number; sourceLeadMs: number }> = [];
  if (input.stems && layerTypes.size > 0) {
    for (const [stemName, rawStemBuffer] of input.stems) {
      if (!stemName.startsWith("donor_")) continue;
      const type = stemName.slice("donor_".length);
      if (!layerTypes.has(type)) continue;
      // A donor stem must be musically co-located with the vocal it
      // accompanies. Two corrections, not one:
      //
      //   1. the donor's *own* source offset is dropped, so the stem starts
      //      where the vocal phrase starts rather than at its file's timeline
      //      zero (which for a late-entering part is silence or the wrong bar);
      //   2. the remaining audio follows the session tempo map.
      //
      // Without (1) a late-entering phrase drags 2.5 s of donor instrumental in
      // ahead of it; without (2) the layer drifts against the bed within a bar.
      const entry = plan.segments[0];
      const sourceLeadFrames = Math.round(((entry?.vocalsFromMs ?? 0) / 1000) * sampleRate) * 2;
      const trimmed = sourceLeadFrames > 0 && sourceLeadFrames < rawStemBuffer.length
        ? rawStemBuffer.subarray(sourceLeadFrames)
        : rawStemBuffer;
      // Instrumental donor stems keep their native pitch. They follow the
      // session tempo like the bed does — and like the vocal does.
      //
      // A constant stretch ratio is only correct when the plan accepted a
      // constant tempo. When a piecewise `localTempoMap` was measured and
      // accepted, the vocal is warped through that map; stretching the donor
      // by the constant ratio instead makes the two drift apart *within* the
      // phrase even though they start together. So the donor is given the same
      // map, minus the vocal's pitch shift, which would be wrong for drums.
      const donorTempoMap = entry?.localTempoMap;
      let pcm: StereoBuffer;
      if (donorTempoMap) {
        const inputFrames = trimmed.length / 2;
        const outputFrames = Math.max(1, Math.round(
          (donorTempoMap.points.at(-1)!.outputMs / 1000) * sampleRate,
        ));
        const timeMap: TimeStretchMapPoint[] = donorTempoMap.points.map((point) => ({
          outputFrame: Math.round((point.outputMs / 1000) * sampleRate),
          inputFrame: Math.round((point.sourceMs / 1000) * sampleRate),
        }));
        timeMap[0] = { outputFrame: 0, inputFrame: 0 };
        timeMap[timeMap.length - 1] = { outputFrame: outputFrames, inputFrame: inputFrames };
        pcm = timeStretch(trimmed, outputFrames / inputFrames, sampleRate, timeMap);
      } else if (Math.abs(plan.vocalsStretchRatio - 1.0) > 1e-6) {
        pcm = timeStretch(trimmed, plan.vocalsStretchRatio, sampleRate);
      } else {
        pcm = Float32Array.from(trimmed);
      }
      // `mashupStartMs` is already the map-corrected entry (the planner folds
      // `entryShiftMs` into it), so the layer starts exactly where the vocal
      // starts. Adding the shift again would double-count it.
      const offsetFrames = Math.max(0, Math.round(((entry?.mashupStartMs ?? 0) / 1000) * sampleRate));
      preparedStems.push({ type, pcm, offsetFrames, sourceLeadMs: (entry?.vocalsFromMs ?? 0) });
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
      left = input.bed[frame * 2]! * bedGain;
      right = input.bed[frame * 2 + 1]! * bedGain;
    }

    for (const { segment, pcm } of prepared) {
      const gain = trapezoidGain(atMs, segment.mashupStartMs, segment.mashupEndMs, segment.crossfadeMs);
      if (gain <= 0) continue;
      const vocalFrame = Math.round(((atMs - segment.mashupStartMs) / 1000) * sampleRate);
      if (vocalFrame < 0 || vocalFrame * 2 + 1 >= pcm.length) continue;
      left += pcm[vocalFrame * 2]! * gain * vocalGain;
      right += pcm[vocalFrame * 2 + 1]! * gain * vocalGain;
    }

    for (const { pcm: stemBuffer, offsetFrames } of preparedStems) {
      const stemFrame = frame - offsetFrames;
      if (stemFrame < 0 || stemFrame * 2 + 1 >= stemBuffer.length) continue;
      const stemGain = DONOR_LAYER_GAIN * (1 - DUCK_DEPTH * duck);
      left += stemBuffer[stemFrame * 2]! * stemGain;
      right += stemBuffer[stemFrame * 2 + 1]! * stemGain;
    }

    // No clamp here: the mix bus limits the summed signal properly.
    summed[frame * 2] = left;
    summed[frame * 2 + 1] = right;
  }

  if (input.mix?.limit === false) {
    // Controlled A/B render: no attenuation and no ceiling, so a comparison
    // can attribute a difference to composition rather than to limiting.
    const pcm = Float32Array.from(summed);
    const fullTruePeak = pcm.length / 2 / sampleRate <= FULL_TRUE_PEAK_MAX_SECONDS;
    const stage = measureMashupMixStage(pcm, sampleRate, { fullTruePeak });
    return {
      pcm,
      mix: {
        pcm,
        balance: balance ?? unmeasuredBalance("Loudness matching was disabled for this render."),
        preLimit: stage,
        postLimit: stage,
        staticGainDb: 0,
        postTruePeakMeasured: fullTruePeak,
        limiter: { ceiling: MASHUP_LIMITER_CEILING, delayFrames: 0, applied: false },
      },
    };
  }

  const finished = finishMashupMix({ summed, sampleRate });
  return {
    pcm: finished.pcm,
    mix: { ...finished, balance: balance ?? unmeasuredBalance("Loudness matching was disabled for this render.") },
  };
}

/** Plan-and-render entry point retained for existing callers: exactly the
 *  production mix bus, PCM only. */
export function renderMashup(plan: MashupPlan, input: MashupPcmInput): StereoBuffer {
  return renderMashupWithBus(plan, input).pcm;
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
