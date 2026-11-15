/**
 * Session-layer pure logic (docs/waveyard-evolution-plan.md P3).
 *
 * Deterministic, Node-testable rules for the SESSION experience: transition
 * configuration + crossfade envelopes, tempo/key compatibility (reusing the
 * engine's own musical primitives — tempoRatioForBpm, normaliseMusicalKey,
 * semitoneShift), beat/bar-aligned transition starts from VERIFIED beat
 * grids (nearestBeat/usableBeatGrid), session advancement, and stem-swap
 * validation. No DOM, no audio, no React — the UI/controller consumes these.
 *
 * Honesty rules: every function states what it does NOT know. Beat alignment
 * is a start-time alignment only (browser clocks are not sample-locked);
 * missing analysis yields explicit "unknown" outcomes, never guesses.
 */

import {
  nearestBeat,
  tempoRatioForBpm,
  usableBeatGrid,
} from "@workspace/arena/lib/waveyard/types/beat-grid";
import { normaliseMusicalKey, semitoneShift } from "@workspace/arena/lib/waveyard/types/musical-key";
import {
  comparePassageWindowSimilarity,
  parsePassageFingerprint,
  PASSAGE_MATCH_SIMILARITY_THRESHOLD,
  type PassageRollingWindow,
} from "../types/passage-compatibility";
import type { SourceSection } from "../types/source-sections";
import { normalizePerformance, type PerformanceSettings } from "./performance";

// ------------------------------------------------------------- transitions

export const TRANSITION_MODES = ["manual", "beat", "bar"] as const;
export type TransitionMode = (typeof TRANSITION_MODES)[number];

export interface TransitionConfig {
  mode: TransitionMode;
  /** Live mute/isolate behavior and fader recall, stored with this track. */
  performance?: PerformanceSettings;
  /** Crossfade length in seconds. 0 = hard cut. */
  crossfadeSeconds: number;
  /** Stems of the OUTGOING track that hold their level for the whole
   * transition and release only at its end (empty = plain crossfade). */
  keepStems: string[];
}

export const MAX_CROSSFADE_SECONDS = 30;

export function normalizeTransitionConfig(raw: unknown): TransitionConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  // Older sessions may still contain the previously exposed but nonfunctional
  // meeting-point mode. Preserve their timing and stem settings while using
  // the supported current-position crossfade behavior.
  const mode: TransitionMode | null = value.mode === "meeting-point"
    ? "manual"
    : TRANSITION_MODES.includes(value.mode as TransitionMode)
      ? value.mode as TransitionMode
      : null;
  if (mode === null) return null;
  const seconds = Number(value.crossfadeSeconds);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_CROSSFADE_SECONDS) return null;
  const keepStems = Array.isArray(value.keepStems)
    ? [...new Set(value.keepStems.filter((stem): stem is string => typeof stem === "string" && stem.length > 0 && stem.length <= 64))]
    : [];
  const performance = value.performance === undefined ? undefined : normalizePerformance(value.performance);
  if (performance === null) return null;
  return { mode, crossfadeSeconds: seconds, keepStems, ...(performance ? { performance } : {}) };
}

export function defaultTransitionConfig(): TransitionConfig {
  return { mode: "manual", crossfadeSeconds: 4, keepStems: [] };
}

/**
 * Linear crossfade envelope. Gains are REAL multipliers applied to the two
 * transports' master gain nodes by the controller.
 *
 *   elapsed <= 0            → { from: 1, to: 0 }        (not started)
 *   0 < elapsed < duration  → equal-power cosine/sine envelope
 *   elapsed >= duration     → { from: 0, to: 1, done }  (transition complete)
 *   duration <= 0           → immediate hard cut
 */
export interface CrossfadeState {
  fromGain: number;
  toGain: number;
  done: boolean;
}

export function crossfadeEnvelope(elapsedSeconds: number, durationSeconds: number): CrossfadeState {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) return { fromGain: 1, toGain: 0, done: false };
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { fromGain: 0, toGain: 1, done: true }; // hard cut fires the moment the transition triggers
  }
  if (elapsedSeconds === 0) return { fromGain: 1, toGain: 0, done: false };
  const progress = Math.min(1, elapsedSeconds / durationSeconds);
  if (progress >= 1) return { fromGain: 0, toGain: 1, done: true };
  const angle = progress * Math.PI / 2;
  return { fromGain: Math.cos(angle), toGain: Math.sin(angle), done: false };
}

/** Apply one outgoing envelope to every stem while honoring explicit keep choices. */
export function scaleCrossfadeStemVolumes(
  volumes: Record<string, number>,
  keepStems: readonly string[],
  outgoingGain: number,
): Record<string, number> {
  const kept = new Set(keepStems);
  return Object.fromEntries(
    Object.entries(volumes).map(([stemType, volume]) => [
      stemType,
      kept.has(stemType) ? volume : volume * outgoingGain,
    ]),
  );
}

/**
 * Deterministic cancel: the transition stops wherever it is and BOTH decks
 * freeze at their current gains (no snap-back, no jump). The caller applies
 * the frozen gains; the session does not advance.
 */
export function crossfadeCancel(elapsedSeconds: number, durationSeconds: number): CrossfadeState & { advanced: false } {
  const state = crossfadeEnvelope(elapsedSeconds, durationSeconds);
  return { ...state, advanced: false };
}

// -------------------------------------------------------- tempo / key

export interface TempoCompatibility {
  aBpm: number | null;
  bBpm: number | null;
  /** target/source tempo ratio via the engine's tempoRatioForBpm. */
  ratio: number | null;
  compatible: boolean;
  reason: string;
}

const BPM_NEAR_TOLERANCE = 6;
const RATIO_LOCK_TOLERANCE = 0.03;
const LIVE_STEM_AUTO_STRETCH_MIN_RATIO = 0.8;
const LIVE_STEM_AUTO_STRETCH_MAX_RATIO = 1.25;

export const MANUAL_TEMPO_BPM_MIN = 40;
export const MANUAL_TEMPO_BPM_MAX = 300;

/** A user-confirmed tempo is accepted only inside the detector's supported range. */
export function normalizeManualTempoBpm(value: unknown): number | null {
  const bpm = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(bpm) || bpm < MANUAL_TEMPO_BPM_MIN || bpm > MANUAL_TEMPO_BPM_MAX) return null;
  return Math.round(bpm * 1000) / 1000;
}

/** Deterministic tempo compatibility: near-equal BPMs, or a 0.5×/1×/2× lock. */
export function tempoCompatibility(aBpm: number | null, bBpm: number | null): TempoCompatibility {
  if (aBpm === null || bBpm === null) {
    return { aBpm, bBpm, ratio: null, compatible: false, reason: "Tempo analysis is not complete for both tracks." };
  }
  const ratio = tempoRatioForBpm(bBpm, aBpm);
  if (ratio === null) {
    return { aBpm, bBpm, ratio: null, compatible: false, reason: "Tempo analysis is not complete for both tracks." };
  }
  if (Math.abs(aBpm - bBpm) <= BPM_NEAR_TOLERANCE) {
    return { aBpm, bBpm, ratio, compatible: true, reason: `BPMs are close (${aBpm} → ${bBpm}); ratio ${ratio.toFixed(3)}.` };
  }
  for (const lock of [0.5, 1, 2]) {
    if (Math.abs(ratio - lock) <= RATIO_LOCK_TOLERANCE) {
      return { aBpm, bBpm, ratio, compatible: true, reason: `Double/half tempo lock (ratio ${ratio.toFixed(3)} ≈ ${lock}).` };
    }
  }
  return {
    aBpm, bBpm, ratio, compatible: false,
    reason: `Tempos differ (${aBpm} vs ${bBpm} BPM, ratio ${ratio.toFixed(3)}); a transition will not be beat-locked.`,
  };
}

/** A near-2:1 BPM pair is often a half/double-time analysis choice, not a request to stretch vocals by 2×. */
export function isHalfDoubleTempoPair(
  recipientBpm: number | null,
  donorBpm: number | null,
): boolean {
  const ratio = tempoRatioForBpm(donorBpm ?? NaN, recipientBpm ?? NaN);
  return ratio !== null
    && (Math.abs(ratio - 0.5) <= RATIO_LOCK_TOLERANCE || Math.abs(ratio - 2) <= RATIO_LOCK_TOLERANCE);
}

export interface LiveStemTempoEvidence {
  recipientBpmConfidence: number | null | undefined;
  donorBpmConfidence: number | null | undefined;
  recipientBeatConfidence: number | null | undefined;
  donorBeatConfidence: number | null | undefined;
}

const LIVE_STEM_MIN_TEMPO_CONFIDENCE = 0.5;

function hasConfidenceAtLeastHalf(confidence: number | null | undefined): boolean {
  return typeof confidence === "number"
    && Number.isFinite(confidence)
    && confidence >= LIVE_STEM_MIN_TEMPO_CONFIDENCE;
}

export function hasReliableLiveStemTempoEvidence(evidence: LiveStemTempoEvidence): boolean {
  return [
    evidence.recipientBpmConfidence,
    evidence.donorBpmConfidence,
  ].every(hasConfidenceAtLeastHalf);
}

export function hasReliableLiveStemBeatEvidence(evidence: LiveStemTempoEvidence): boolean {
  return hasReliableLiveStemTempoEvidence(evidence) && [
    evidence.recipientBeatConfidence,
    evidence.donorBeatConfidence,
  ].every(hasConfidenceAtLeastHalf);
}

/**
 * Safe automatic live-stem stretch factor (output duration / donor duration).
 * Keep half/double-time pairs at the donor's native pace; only modestly stretch
 * other pairs automatically. The low-level engine still supports wider manual
 * ratios, but an automatic 2× vocal warp is not a quality match.
 */
export function liveStemTempoStretchRatio(
  recipientBpm: number | null,
  donorBpm: number | null,
  evidence?: LiveStemTempoEvidence,
): number | null {
  if (recipientBpm === null || donorBpm === null) return null;
  const ratio = tempoRatioForBpm(donorBpm, recipientBpm);
  if (ratio === null) return null;
  if (evidence !== undefined && !hasReliableLiveStemTempoEvidence(evidence)) return 1;
  if (isHalfDoubleTempoPair(recipientBpm, donorBpm)) return 1;
  return ratio >= LIVE_STEM_AUTO_STRETCH_MIN_RATIO && ratio <= LIVE_STEM_AUTO_STRETCH_MAX_RATIO
    ? ratio
    : null;
}

/** Offset in stretched-donor seconds. Beat zero is not necessarily a downbeat. */
export function liveStemBeatOffsetSeconds(
  recipientBeats: unknown,
  donorBeats: unknown,
  stretchRatio: number,
): number | null {
  const recipient = usableBeatGrid(recipientBeats);
  const donor = usableBeatGrid(donorBeats);
  if (!recipient || !donor || !Number.isFinite(stretchRatio) || stretchRatio <= 0) return null;
  // In output coordinates donorBeat * stretch = recipientBeat + offset.
  return (donor[0] * stretchRatio - recipient[0]) / 1000;
}

type LiveStemSection = Pick<
  SourceSection,
  | "sectionIndex" | "startMs" | "endMs" | "startBeatIndex" | "endBeatIndex"
  | "label" | "labelConfidence" | "structuralConfidence"
> & Partial<Pick<SourceSection, "sourceChecksumSha256" | "passageFingerprint">>;

type LiveStemSectionEvidence = LiveStemTempoEvidence & {
  recipientBeatGridMs?: unknown;
  donorBeatGridMs?: unknown;
  recipientBpm?: number | null;
  donorBpm?: number | null;
  recipientKey?: string | null;
  donorKey?: string | null;
  recipientKeyConfidence?: number | null;
  donorKeyConfidence?: number | null;
};

const COMPARABLE_SECTION_LABELS = new Set([
  "verse", "chorus", "pre chorus", "bridge", "intro", "outro", "drop",
  "breakdown", "refrain", "hook", "instrumental",
]);
const LIVE_STEM_PHRASE_DURATION_SIMILARITY_MIN = 0.9;
const LIVE_STEM_TRUSTED_KEY_CONFIDENCE_MIN = 0.75;
const LIVE_STEM_SECTION_ROLE_CONFIDENCE_MIN = 0.75;
const LIVE_STEM_SECTION_BOUNDARY_CONFIDENCE_MIN = 0.6;

function comparableSectionLabel(label: string): string | null {
  const normalized = label.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+\d+$/, "").trim();
  return COMPARABLE_SECTION_LABELS.has(normalized) ? normalized : null;
}

function orderedBeatGrid(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 2
    || value.some((beat) => !Number.isSafeInteger(beat) || beat < 0)
    || value.some((beat, index) => index > 0 && beat <= value[index - 1])) return null;
  return value as number[];
}

function nearestBeatIndexAtMs(grid: readonly number[], targetMs: number): number | null {
  if (!Number.isFinite(targetMs) || grid.length < 2) return null;
  let low = 0;
  let high = grid.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (grid[middle]! <= targetMs) low = middle;
    else high = middle;
  }
  return Math.abs(grid[low]! - targetMs) <= Math.abs(grid[high]! - targetMs) ? low : high;
}

function beatBoundaryMs(grid: readonly number[], beatIndex: number): number | null {
  if (!Number.isInteger(beatIndex) || beatIndex < 0 || beatIndex > grid.length) return null;
  if (beatIndex < grid.length) return grid[beatIndex]!;
  const intervals = grid.slice(1).map((time, index) => time - grid[index]!).sort((left, right) => left - right);
  const median = intervals[Math.floor(intervals.length / 2)];
  return median && Number.isFinite(median) ? grid.at(-1)! + median : null;
}

function measuredRollingWindows(section: LiveStemSection): PassageRollingWindow[] | null {
  if (!section.sourceChecksumSha256 || !/^[a-f\d]{64}$/i.test(section.sourceChecksumSha256)) return null;
  const fingerprint = parsePassageFingerprint(section.passageFingerprint, {
    sourceChecksumSha256: section.sourceChecksumSha256,
    startBeatIndex: section.startBeatIndex,
    endBeatIndex: section.endBeatIndex,
  });
  return fingerprint?.rollingWindows?.status === "measured"
    ? fingerprint.rollingWindows.value
    : null;
}

function hasReliableLocalPassageBeatEvidence(evidence: LiveStemSectionEvidence): boolean {
  const confidentGrid = (confidence: number | null | undefined) =>
    typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0.6;
  return Number.isFinite(evidence.recipientBpm) && (evidence.recipientBpm ?? 0) > 0
    && Number.isFinite(evidence.donorBpm) && (evidence.donorBpm ?? 0) > 0
    && confidentGrid(evidence.recipientBeatConfidence)
    && confidentGrid(evidence.donorBeatConfidence);
}

function livePhraseSectionAlignmentCandidates(
  recipientSections: readonly LiveStemSection[],
  donorSections: readonly LiveStemSection[],
  recipient: LiveStemSection,
  recipientPositionSeconds: number,
  stretchRatio: number,
  evidence: LiveStemSectionEvidence,
  maxCandidates: number,
): LiveStemSectionAlignmentCandidate[] {
  // A low whole-track BPM score must keep the donor at native pace, but it
  // need not discard checksum-bound local phrase evidence when both measured
  // beat grids are independently strong. Duration similarity still rejects
  // windows that would drift too far at native pace.
  if (!hasReliableLocalPassageBeatEvidence(evidence)) return [];
  const recipientGrid = orderedBeatGrid(evidence.recipientBeatGridMs);
  const donorGrid = orderedBeatGrid(evidence.donorBeatGridMs);
  if (!recipientGrid || !donorGrid) return [];
  const currentBeatIndex = nearestBeatIndexAtMs(recipientGrid, recipientPositionSeconds * 1000);
  if (currentBeatIndex === null) return [];

  const recipientWindows = measuredRollingWindows(recipient);
  const recipientWindow = recipientWindows?.find((window) =>
    window.startBeatIndex <= currentBeatIndex && currentBeatIndex < window.endBeatIndex
    && window.rhythm.status === "measured" && window.chroma.status === "measured",
  );
  if (!recipientWindow) return [];
  const recipientWindowStartMs = beatBoundaryMs(recipientGrid, recipientWindow.startBeatIndex);
  const recipientWindowEndMs = beatBoundaryMs(recipientGrid, recipientWindow.endBeatIndex);
  if (recipientWindowStartMs === null || recipientWindowEndMs === null || recipientWindowEndMs <= recipientWindowStartMs) return [];

  const anchorKeyTrusted = typeof evidence.recipientKey === "string"
    && (evidence.recipientKeyConfidence ?? 0) >= LIVE_STEM_TRUSTED_KEY_CONFIDENCE_MIN;
  const donorKeyTrusted = typeof evidence.donorKey === "string"
    && (evidence.donorKeyConfidence ?? 0) >= LIVE_STEM_TRUSTED_KEY_CONFIDENCE_MIN;
  const expectedKeyShift = anchorKeyTrusted && donorKeyTrusted
    ? semitoneShift(evidence.donorKey, evidence.recipientKey)
    : null;
  const recipientDurationMs = recipientWindowEndMs - recipientWindowStartMs;
  const recipientTrackEnd = recipientSections.at(-1)?.endBeatIndex ?? 0;
  const donorTrackEnd = donorSections.at(-1)?.endBeatIndex ?? 0;
  const matches: Array<LiveStemSectionAlignmentCandidate & { rankingScore: number; positionDistance: number }> = [];

  for (const donorSection of donorSections) {
    const donorWindows = measuredRollingWindows(donorSection);
    if (!donorWindows) continue;
    for (const donorWindow of donorWindows) {
      if (donorSection.structuralConfidence < LIVE_STEM_SECTION_BOUNDARY_CONFIDENCE_MIN) continue;
      if (donorWindow.rhythm.status !== "measured" || donorWindow.chroma.status !== "measured") continue;
      const donorWindowStartMs = beatBoundaryMs(donorGrid, donorWindow.startBeatIndex);
      const donorWindowEndMs = beatBoundaryMs(donorGrid, donorWindow.endBeatIndex);
      if (donorWindowStartMs === null || donorWindowEndMs === null || donorWindowEndMs <= donorWindowStartMs) continue;
      const stretchedDonorDurationMs = (donorWindowEndMs - donorWindowStartMs) * stretchRatio;
      const durationSimilarity = Math.min(recipientDurationMs, stretchedDonorDurationMs)
        / Math.max(recipientDurationMs, stretchedDonorDurationMs);
      if (durationSimilarity < LIVE_STEM_PHRASE_DURATION_SIMILARITY_MIN) continue;

      const similarity = comparePassageWindowSimilarity({
        anchor: recipientWindow,
        donor: donorWindow,
        anchorKeyTrusted,
        donorKeyTrusted,
        expectedKeyShift,
      });
      if (similarity.rhythmSimilarity === null
        || similarity.harmonySimilarity === null
        || similarity.rhythmSimilarity < PASSAGE_MATCH_SIMILARITY_THRESHOLD
        || similarity.harmonySimilarity < PASSAGE_MATCH_SIMILARITY_THRESHOLD
        || !similarity.harmonicShiftAllowed) continue;

      const score = (similarity.rhythmSimilarity + similarity.harmonySimilarity) / 2 * durationSimilarity;
      const positionDistance = recipientTrackEnd > 0 && donorTrackEnd > 0
        ? Math.abs(
          (donorWindow.startBeatIndex / donorTrackEnd)
          - (recipientWindow.startBeatIndex / recipientTrackEnd),
        )
        : Number.POSITIVE_INFINITY;
      const offsetSeconds = (donorWindowStartMs * stretchRatio - recipientWindowStartMs) / 1000;
      const donorEntryMs = (recipientPositionSeconds * 1000 + offsetSeconds * 1000) / stretchRatio;
      if (!Number.isFinite(donorEntryMs) || donorEntryMs < donorWindowStartMs || donorEntryMs >= donorWindowEndMs) continue;
      const measurementConfidence = (window: PassageRollingWindow, channel: "rhythm" | "chroma") => {
        const signal = window[channel];
        if (signal.status !== "measured") return null;
        const confidence = signal.confidence;
        return typeof confidence === "number" && Number.isFinite(confidence) ? confidence : null;
      };
      matches.push({
        offsetSeconds,
        stretchRatio,
        donorEntryMs,
        basis: "rhythm-harmony-phrase",
        donorSectionIndex: donorSection.sectionIndex,
        recipientSectionIndex: recipient.sectionIndex,
        donorWindowStartMs,
        donorWindowEndMs,
        recipientWindowStartMs,
        recipientWindowEndMs,
        rhythmSimilarity: similarity.rhythmSimilarity,
        harmonySimilarity: similarity.harmonySimilarity,
        durationSimilarity,
        rhythmMeasurementConfidence: Math.min(
          measurementConfidence(recipientWindow, "rhythm") ?? 0,
          measurementConfidence(donorWindow, "rhythm") ?? 0,
        ),
        harmonyMeasurementConfidence: Math.min(
          measurementConfidence(recipientWindow, "chroma") ?? 0,
          measurementConfidence(donorWindow, "chroma") ?? 0,
        ),
        recipientBoundaryConfidence: recipient.structuralConfidence,
        donorBoundaryConfidence: donorSection.structuralConfidence,
        recipientBeatConfidence: evidence.recipientBeatConfidence ?? null,
        donorBeatConfidence: evidence.donorBeatConfidence ?? null,
        transpositionSemitones: similarity.transpositionSemitones,
        rankingScore: score,
        positionDistance,
      });
    }
  }
  matches.sort((left, right) =>
    right.rankingScore - left.rankingScore || left.positionDistance - right.positionDistance,
  );
  const diverse: LiveStemSectionAlignmentCandidate[] = [];
  for (const match of matches) {
    const duration = match.donorWindowEndMs - match.donorWindowStartMs;
    const overlapsExisting = diverse.some((existing) => {
      const overlap = Math.max(0, Math.min(match.donorWindowEndMs, existing.donorWindowEndMs)
        - Math.max(match.donorWindowStartMs, existing.donorWindowStartMs));
      const shorter = Math.min(duration, existing.donorWindowEndMs - existing.donorWindowStartMs);
      return shorter > 0 && overlap / shorter >= 0.5;
    });
    if (overlapsExisting) continue;
    const { rankingScore: _rankingScore, positionDistance: _positionDistance, ...candidate } = match;
    diverse.push(candidate);
    if (diverse.length >= maxCandidates) break;
  }
  return diverse;
}

/**
 * Prefer checksum-verified local phrase windows with matching rhythm, chroma,
 * and post-stretch duration. This is evidence of similar local audio, not a
 * semantic section label. Legacy role matching remains for sources without
 * fingerprints; incomplete/conflicting fingerprint evidence returns null so
 * the caller can use verified beat-phase alignment.
 */
export type LiveStemSectionAlignmentBasis = "rhythm-harmony-phrase" | "trusted-section-role";

export type LiveStemSectionAlignmentCandidate = {
  offsetSeconds: number;
  stretchRatio: number;
  donorEntryMs: number;
  basis: LiveStemSectionAlignmentBasis;
  donorSectionIndex: number;
  recipientSectionIndex: number;
  donorWindowStartMs: number;
  donorWindowEndMs: number;
  recipientWindowStartMs: number;
  recipientWindowEndMs: number;
  rhythmSimilarity: number | null;
  harmonySimilarity: number | null;
  durationSimilarity: number | null;
  rhythmMeasurementConfidence: number | null;
  harmonyMeasurementConfidence: number | null;
  recipientBoundaryConfidence: number;
  donorBoundaryConfidence: number;
  recipientBeatConfidence: number | null;
  donorBeatConfidence: number | null;
  transpositionSemitones: number | null;
};

const MAX_LIVE_STEM_ALIGNMENT_CANDIDATES = 5;

/**
 * Returns distinct, source-verified alternatives at the current recipient
 * playhead. Similarity and measurement confidence remain separate; these are
 * local audio-window matches, not semantic phrase or section labels.
 */
export function liveStemSectionAlignmentCandidates(
  recipientSections: readonly LiveStemSection[] | null | undefined,
  donorSections: readonly LiveStemSection[] | null | undefined,
  recipientPositionSeconds: number,
  stretchRatio: number,
  evidence?: LiveStemSectionEvidence,
  maxCandidates = MAX_LIVE_STEM_ALIGNMENT_CANDIDATES,
): LiveStemSectionAlignmentCandidate[] {
  if (
    !Array.isArray(recipientSections)
    || !Array.isArray(donorSections)
    || recipientSections.length === 0
    || donorSections.length === 0
    || !Number.isFinite(recipientPositionSeconds)
    || recipientPositionSeconds < 0
    || !Number.isFinite(stretchRatio)
    || stretchRatio <= 0
    || !Number.isInteger(maxCandidates)
    || maxCandidates < 1
    || maxCandidates > 20
  ) return [];

  const validSections = (sections: readonly LiveStemSection[]) => sections.every((section, index) =>
    section.sectionIndex === index
    && Number.isSafeInteger(section.startMs)
    && Number.isSafeInteger(section.endMs)
    && section.endMs > section.startMs
    && Number.isInteger(section.startBeatIndex)
    && Number.isInteger(section.endBeatIndex)
    && section.endBeatIndex > section.startBeatIndex
    && typeof section.label === "string"
    && section.label.trim().length > 0
    && Number.isFinite(section.labelConfidence)
    && section.labelConfidence >= 0
    && section.labelConfidence <= 1
    && Number.isFinite(section.structuralConfidence)
    && section.structuralConfidence >= 0
    && section.structuralConfidence <= 1
    && (index === 0 || section.startMs >= sections[index - 1].endMs),
  );
  if (!validSections(recipientSections) || !validSections(donorSections)) return [];

  const recipientMs = recipientPositionSeconds * 1000;
  const recipient = recipientSections.find((section) =>
    recipientMs >= section.startMs && recipientMs < section.endMs,
  );
  if (!recipient || recipient.structuralConfidence < LIVE_STEM_SECTION_BOUNDARY_CONFIDENCE_MIN) return [];
  const anyFingerprint = [...recipientSections, ...donorSections]
    .some((section) => section.passageFingerprint !== undefined && section.passageFingerprint !== null);
  if (anyFingerprint) {
    return evidence
      ? livePhraseSectionAlignmentCandidates(
        recipientSections,
        donorSections,
        recipient,
        recipientPositionSeconds,
        stretchRatio,
        evidence,
        maxCandidates,
      )
      : [];
  }

  const role = comparableSectionLabel(recipient.label);
  if (!role || recipient.labelConfidence < LIVE_STEM_SECTION_ROLE_CONFIDENCE_MIN) return [];
  const recipientBeatLength = recipient.endBeatIndex - recipient.startBeatIndex;
  const recipientTrackEnd = recipientSections.at(-1)?.endBeatIndex ?? 0;
  const donorTrackEnd = donorSections.at(-1)?.endBeatIndex ?? 0;
  if (recipientTrackEnd <= 0 || donorTrackEnd <= 0) return [];
  const recipientPhase = recipient.startBeatIndex / recipientTrackEnd;
  const donors = donorSections
    .filter((candidate) => comparableSectionLabel(candidate.label) === role
      && candidate.labelConfidence >= LIVE_STEM_SECTION_ROLE_CONFIDENCE_MIN
      && candidate.structuralConfidence >= LIVE_STEM_SECTION_BOUNDARY_CONFIDENCE_MIN
      && Math.abs((candidate.endBeatIndex - candidate.startBeatIndex) - recipientBeatLength) <= 4)
    .sort((left, right) =>
      Math.abs(left.startBeatIndex / donorTrackEnd - recipientPhase)
      - Math.abs(right.startBeatIndex / donorTrackEnd - recipientPhase),
    );
  return donors.slice(0, maxCandidates).flatMap((candidate) => {
    const offsetSeconds = (candidate.startMs * stretchRatio - recipient.startMs) / 1000;
    const donorEntryMs = (recipientMs + offsetSeconds * 1000) / stretchRatio;
    const recipientDurationMs = recipient.endMs - recipient.startMs;
    const donorDurationMs = candidate.endMs - candidate.startMs;
    if (!Number.isFinite(donorEntryMs)
      || donorEntryMs < candidate.startMs
      || donorEntryMs >= candidate.endMs) return [];
    return [{
      offsetSeconds,
      stretchRatio,
      donorEntryMs,
      basis: "trusted-section-role" as const,
      donorSectionIndex: candidate.sectionIndex,
      recipientSectionIndex: recipient.sectionIndex,
      donorWindowStartMs: candidate.startMs,
      donorWindowEndMs: candidate.endMs,
      recipientWindowStartMs: recipient.startMs,
      recipientWindowEndMs: recipient.endMs,
      rhythmSimilarity: null,
      harmonySimilarity: null,
      durationSimilarity: Math.min(recipientDurationMs, donorDurationMs * stretchRatio)
        / Math.max(recipientDurationMs, donorDurationMs * stretchRatio),
      rhythmMeasurementConfidence: null,
      harmonyMeasurementConfidence: null,
      recipientBoundaryConfidence: recipient.structuralConfidence,
      donorBoundaryConfidence: candidate.structuralConfidence,
      recipientBeatConfidence: evidence?.recipientBeatConfidence ?? null,
      donorBeatConfidence: evidence?.donorBeatConfidence ?? null,
      transpositionSemitones: null,
    }];
  });
}

/** Re-project a reviewed window onto the live clock; never carry it across a
 * seek outside that window or a changed tempo match. */
export function liveStemCandidateDonorEntryMs(
  candidate: LiveStemSectionAlignmentCandidate,
  recipientPositionSeconds: number,
  currentStretchRatio: number,
): number | null {
  if (!Number.isFinite(recipientPositionSeconds) || recipientPositionSeconds < 0
    || !Number.isFinite(currentStretchRatio) || currentStretchRatio <= 0
    || !Number.isFinite(candidate.stretchRatio)
    || Math.abs(candidate.stretchRatio - currentStretchRatio) > 1e-9
    || !Number.isFinite(candidate.offsetSeconds)
    || ![candidate.recipientWindowStartMs, candidate.recipientWindowEndMs,
      candidate.donorWindowStartMs, candidate.donorWindowEndMs].every(Number.isFinite)
    || candidate.recipientWindowStartMs >= candidate.recipientWindowEndMs
    || candidate.donorWindowStartMs >= candidate.donorWindowEndMs) return null;
  const positionMs = recipientPositionSeconds * 1000;
  if (positionMs < candidate.recipientWindowStartMs || positionMs >= candidate.recipientWindowEndMs) return null;
  const donorMs = (positionMs + candidate.offsetSeconds * 1000) / currentStretchRatio;
  if (!Number.isFinite(donorMs)
    || donorMs < candidate.donorWindowStartMs || donorMs >= candidate.donorWindowEndMs) return null;
  return Math.min(candidate.donorWindowEndMs - 1, Math.max(candidate.donorWindowStartMs, Math.round(donorMs)));
}

export function liveStemSectionAlignment(
  recipientSections: readonly LiveStemSection[] | null | undefined,
  donorSections: readonly LiveStemSection[] | null | undefined,
  recipientPositionSeconds: number,
  stretchRatio: number,
  evidence?: LiveStemSectionEvidence,
): { offsetSeconds: number; basis: LiveStemSectionAlignmentBasis } | null {
  const candidate = liveStemSectionAlignmentCandidates(
    recipientSections,
    donorSections,
    recipientPositionSeconds,
    stretchRatio,
    evidence,
    1,
  )[0];
  return candidate ? { offsetSeconds: candidate.offsetSeconds, basis: candidate.basis } : null;
}

/** Numeric-offset compatibility wrapper for existing callers and tests. */
export function liveStemSectionOffsetSeconds(
  recipientSections: readonly LiveStemSection[] | null | undefined,
  donorSections: readonly LiveStemSection[] | null | undefined,
  recipientPositionSeconds: number,
  stretchRatio: number,
  evidence?: LiveStemSectionEvidence,
): number | null {
  return liveStemSectionAlignment(
    recipientSections,
    donorSections,
    recipientPositionSeconds,
    stretchRatio,
    evidence,
  )?.offsetSeconds ?? null;
}

/** Snaps an editable donor time to the closest measured vocal/section start.
 * This does not claim that activity is a lyric boundary or that a section is a chorus. */
export function nearestEntryEvidenceMs(
  targetMs: number,
  points: readonly { startMs: number }[] | null | undefined,
): number | null {
  if (!Number.isSafeInteger(targetMs) || targetMs < 0 || !Array.isArray(points)) return null;
  let nearest: number | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    if (!Number.isSafeInteger(point.startMs) || point.startMs < 0) continue;
    const candidateDistance = Math.abs(point.startMs - targetMs);
    if (candidateDistance < distance) {
      nearest = point.startMs;
      distance = candidateDistance;
    }
  }
  return nearest;
}

/** Maps a persisted donor-clock source start to the transport's playback offset.
 * A null tempo ratio means native pace; the user's chosen source entry still applies. */
export function liveStemDonorEntryOffsetSeconds(
  donorEntryOffsetMs: number | null | undefined,
  recipientPositionSeconds: number,
  stretchRatio: number | null,
): number | null {
  if (donorEntryOffsetMs === null || donorEntryOffsetMs === undefined) return null;
  if (!Number.isSafeInteger(donorEntryOffsetMs) || donorEntryOffsetMs < 0
    || !Number.isFinite(recipientPositionSeconds) || recipientPositionSeconds < 0
    || (stretchRatio !== null && (!Number.isFinite(stretchRatio) || stretchRatio <= 0))) return null;
  return (donorEntryOffsetMs / 1000) * (stretchRatio ?? 1) - recipientPositionSeconds;
}

export interface KeyCompatibility {
  aKey: string | null;
  bKey: string | null;
  shiftSemitones: number | null;
  relationship: "same" | "fifth" | "relative" | "other" | "unknown";
  compatible: boolean;
  reason: string;
}

/** Deterministic key compatibility from the engine's key vocabulary:
 * same key, perfect fifth (±7 semitones), or relative major/minor. */
export function keyCompatibility(aKey: string | null, bKey: string | null): KeyCompatibility {
  const a = normaliseMusicalKey(aKey);
  const b = normaliseMusicalKey(bKey);
  if (a === null || b === null) {
    return { aKey, bKey, shiftSemitones: null, relationship: "unknown", compatible: false, reason: "Key analysis is not complete for both tracks." };
  }
  const shift = semitoneShift(a, b);
  const aMinor = a.endsWith("minor");
  const bMinor = b.endsWith("minor");
  if (shift === 0 && aMinor === bMinor) {
    return { aKey: a, bKey: b, shiftSemitones: shift, relationship: "same", compatible: true, reason: `Same key (${a}).` };
  }
  if ((shift === 5 || shift === -5 || shift === 7 || shift === -7) && aMinor === bMinor) {
    return { aKey: a, bKey: b, shiftSemitones: shift, relationship: "fifth", compatible: true, reason: `Perfect-fifth relationship (${a} → ${b}, ${shift > 0 ? "+" : ""}${shift} semitones).` };
  }
  if (shift === 3 && aMinor !== bMinor) {
    return { aKey: a, bKey: b, shiftSemitones: shift, relationship: "relative", compatible: true, reason: `Relative major/minor (${a} → ${b}).` };
  }
  if (shift === -3 && aMinor !== bMinor) {
    return { aKey: a, bKey: b, shiftSemitones: shift, relationship: "relative", compatible: true, reason: `Relative major/minor (${a} → ${b}).` };
  }
  return {
    aKey: a, bKey: b, shiftSemitones: shift, relationship: "other", compatible: false,
    reason: `Keys ${a} and ${b} share no simple relationship (${shift !== null && shift > 0 ? "+" : ""}${shift} semitones) — the transition may sound clashy.`,
  };
}

export type KeyConfidenceLevel = "confident" | "tentative" | "unavailable";
export interface KeyCompatibilityEvidence extends KeyCompatibility {
  confidenceLevel: KeyConfidenceLevel;
  confidence: number | null;
}

const KEY_COMPATIBILITY_MIN_CONFIDENCE = 0.5;

/** Keep harmonic labels tentative when either source key is ambiguous or stale. */
export function keyCompatibilityEvidence(
  aKey: string | null,
  aConfidence: number | null | undefined,
  bKey: string | null,
  bConfidence: number | null | undefined,
): KeyCompatibilityEvidence {
  const compatibility = keyCompatibility(aKey, bKey);
  const validConfidence = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  if (
    compatibility.relationship === "unknown"
    || !validConfidence(aConfidence)
    || !validConfidence(bConfidence)
  ) {
    return { ...compatibility, confidenceLevel: "unavailable", confidence: null };
  }

  const confidence = Math.min(aConfidence as number, bConfidence as number);
  return {
    ...compatibility,
    confidenceLevel: confidence >= KEY_COMPATIBILITY_MIN_CONFIDENCE ? "confident" : "tentative",
    confidence,
  };
}

// ------------------------------------------------------------ beat alignment

export interface BeatAlignedStart {
  ok: boolean;
  /** Where in the OUTGOING track the transition starts (ms from track start). */
  startInCurrentMs: number | null;
  /** Where the INCOMING track should begin playback (ms from its start). */
  incomingOffsetMs: number | null;
  approximate: boolean;
  reason: string;
}

/**
 * Deterministic start-time alignment from VERIFIED beat positions:
 *  - find the outgoing track's next beat/bar boundary at/after the current
 *    position (a bar = every 4th beat, counted from the grid's first beat);
 *  - snap the incoming track's start to ITS nearest beat so both begin on
 *    analyzed beats.
 *
 * This aligns START TIMES only — ongoing phase sync is not enforced (browser
 * audio clocks are not sample-locked), which `approximate: true` states
 * honestly. No beat grid → explicit unavailability, never a guess.
 */
export function beatAlignedTransitionStart(
  currentBeatGridMs: unknown,
  incomingBeatGridMs: unknown,
  currentPositionMs: number,
  mode: "beat" | "bar",
): BeatAlignedStart {
  const currentBeats = usableBeatGrid(currentBeatGridMs);
  const incomingBeats = usableBeatGrid(incomingBeatGridMs);
  if (currentBeats === null || incomingBeats === null) {
    return { ok: false, startInCurrentMs: null, incomingOffsetMs: null, approximate: true, reason: "Beat grids are not available for both tracks — use a manual transition." };
  }
  const now = Number.isFinite(currentPositionMs) ? Math.max(0, currentPositionMs) : 0;
  const step = mode === "bar" ? 4 : 1;
  const candidates = currentBeats.filter((_, index) => index % step === 0);
  const boundary = candidates.find((beat) => beat >= now) ?? currentBeats[currentBeats.length - 1];
  const incomingStart = nearestBeat(0, incomingBeats) ?? incomingBeats[0];
  return {
    ok: true,
    startInCurrentMs: boundary,
    incomingOffsetMs: incomingStart,
    approximate: true,
    reason: `${mode === "bar" ? "Bar" : "Beat"}-aligned start (verified beats; start-time alignment only, not ongoing phase sync).`,
  };
}

// ------------------------------------------------------- evidence labeling

/** Select a verified cue which leaves room for the entire automatic fade.
 * Unlike manual alignment, never clamp to a beat past the last usable bar. */
export function automaticTransitionCue(
  cfg: TransitionConfig,
  durationSeconds: number,
  currentBeatGridMs: unknown,
  incomingBeatGridMs: unknown,
): BeatAlignedStart {
  const latestMs = Math.max(0, durationSeconds - cfg.crossfadeSeconds) * 1000;
  if (cfg.mode === "manual") {
    return { ok: true, startInCurrentMs: latestMs, incomingOffsetMs: 0, approximate: true, reason: "Automatic crossfade." };
  }
  const aligned = beatAlignedTransitionStart(currentBeatGridMs, incomingBeatGridMs, 0, cfg.mode);
  if (!aligned.ok) return aligned;
  const beats = usableBeatGrid(currentBeatGridMs)!;
  const step = cfg.mode === "bar" ? 4 : 1;
  const cue = beats.filter((beat, index) => index % step === 0 && beat <= latestMs).at(-1);
  if (cue === undefined || cfg.crossfadeSeconds > durationSeconds) {
    return { ...aligned, ok: false, startInCurrentMs: null, reason: "No verified cue leaves enough time for the automatic fade." };
  }
  return { ...aligned, startInCurrentMs: cue };
}

/** A delayed/backgrounded clock must not turn a verified cue into an off-beat fade.
 * Browser alignment is approximate; allow the existing 350ms control window. */
export function automaticCueTiming(positionMs: number, cueMs: number): "wait" | "start" | "missed" {
  if (positionMs < cueMs) return "wait";
  return positionMs - cueMs <= 350 ? "start" : "missed";
}

/** How strongly a compatibility claim is backed: real analysis evidence,
 * an honest approximation, or nothing (never blurred — P5 STEP 7). */
export type EvidenceLevel = "real" | "approximate" | "unavailable";

export interface EvidenceLabel {
  level: EvidenceLevel;
  label: string;
}

export interface CompatibilityEvidence {
  tempo: EvidenceLabel;
  key: EvidenceLabel;
  /** null when the transition mode has no alignment concept (manual). */
  alignment: EvidenceLabel | null;
}

/** Deterministic REAL / APPROXIMATE / UNAVAILABLE evidence labels from the
 * analyses that actually exist. Never "real" without analysis; alignment on
 * verified beat grids is start-time alignment only (the reason prose in the
 * compatibility panel always carries that scope). */
export function compatibilityEvidence(
  currentAnalysis: {
    bpm: number | null;
    bpmConfidence?: number | null;
    musicalKey: string | null;
    keyConfidence?: number | null;
    beatGridMs: number[] | null;
    beatConfidence?: number | null;
  } | null,
  nextAnalysis: {
    bpm: number | null;
    bpmConfidence?: number | null;
    musicalKey: string | null;
    keyConfidence?: number | null;
    beatGridMs: number[] | null;
    beatConfidence?: number | null;
  } | null,
  mode: TransitionMode,
): CompatibilityEvidence {
  const bothBpm = currentAnalysis?.bpm != null && nextAnalysis?.bpm != null;
  const bothKey = currentAnalysis?.musicalKey != null && nextAnalysis?.musicalKey != null;
  const bothGrids = currentAnalysis?.beatGridMs != null && nextAnalysis?.beatGridMs != null;
  const confident = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0.5 && value <= 1;
  const tempoConfident = bothBpm && confident(currentAnalysis?.bpmConfidence) && confident(nextAnalysis?.bpmConfidence);
  const keyConfident = bothKey && confident(currentAnalysis?.keyConfidence) && confident(nextAnalysis?.keyConfidence);
  const beatConfident = bothGrids && confident(currentAnalysis?.beatConfidence) && confident(nextAnalysis?.beatConfidence);
  let alignment: EvidenceLabel | null;
  if (mode === "manual") {
    alignment = null;
  } else if (mode === "beat" || mode === "bar") {
    alignment = !bothGrids
      ? { level: "unavailable", label: "UNAVAILABLE — beat grids missing; use a manual transition" }
      : beatConfident
        ? { level: "real", label: "REAL — confident beat-grid estimates (start-time alignment only)" }
        : { level: "approximate", label: "APPROXIMATE — beat grids exist, but confidence is low or unavailable" };
  } else {
    alignment = { level: "unavailable", label: "UNAVAILABLE — stored mode; section-aware cueing is not implemented" };
  }
  return {
    tempo: !bothBpm
      ? { level: "unavailable", label: "UNAVAILABLE — tempo analysis missing for one or both tracks" }
      : tempoConfident
        ? { level: "real", label: "REAL — confident tempo estimates for both tracks" }
        : { level: "approximate", label: "APPROXIMATE — tempo estimates exist, but confidence is low or unavailable" },
    key: !bothKey
      ? { level: "unavailable", label: "UNAVAILABLE — key analysis missing for one or both tracks" }
      : keyConfident
        ? { level: "real", label: "REAL — key profiles and competing-key margins support both estimates" }
        : { level: "approximate", label: "APPROXIMATE — key estimates exist, but confidence is low or unavailable" },
    alignment,
  };
}

// ------------------------------------------------------------- advancement

export interface SessionOrderEntry {
  id: string;
  trackId: string;
}

export type SessionAdvanceDecision =
  | { action: "play"; sessionTrackId: string; trackId: string }
  | { action: "stop"; reason: "end-of-session" | "empty-session" };

/** The next session track after `currentSessionTrackId` (by position);
 * wraps are the UI's explicit choice (a session ends when it ends). */
export function nextSessionTrack(
  order: SessionOrderEntry[],
  currentSessionTrackId: string | null,
): SessionAdvanceDecision {
  if (order.length === 0) return { action: "stop", reason: "empty-session" };
  if (currentSessionTrackId === null) {
    return { action: "play", sessionTrackId: order[0].id, trackId: order[0].trackId };
  }
  const index = order.findIndex((entry) => entry.id === currentSessionTrackId);
  if (index === -1 || index + 1 >= order.length) return { action: "stop", reason: "end-of-session" };
  const next = order[index + 1];
  return { action: "play", sessionTrackId: next.id, trackId: next.trackId };
}

// --------------------------------------------------------------- stem swap

export interface StemSwapCandidateStem {
  stemType: string;
  engine: string;
}

export type StemSwapValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * A stem swap requires BOTH tracks to really have the requested stem:
 * the current track needs the layer being replaced (it is playing), and the
 * donor needs a real separated stem of that type to lend. Passthrough
 * "source" stems cannot donate a stem layer — that would be relabeling, not
 * swapping. Both conditions are checked against real stem rows.
 */
export function validateStemSwap(
  currentStems: StemSwapCandidateStem[],
  donorStems: StemSwapCandidateStem[],
  stemType: string,
): StemSwapValidation {
  const isReal = (stem: StemSwapCandidateStem) => stem.engine !== "passthrough-unseparated";
  if (!currentStems.some((stem) => isReal(stem) && stem.stemType === stemType)) {
    return { ok: false, reason: `The current track has no real “${stemType}” stem layer to replace.` };
  }
  if (!donorStems.some((stem) => isReal(stem) && stem.stemType === stemType)) {
    return { ok: false, reason: `The donor track has no separated “${stemType}” stem to lend.` };
  }
  return { ok: true };
}
