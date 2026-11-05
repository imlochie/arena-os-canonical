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

/**
 * Pitch-preserving live-stem stretch factor (output duration / donor duration)
 * across the live engine's supported 0.5–2 duration range. Natural transition
 * compatibility is not a processing limit: a distant BPM can still be matched.
 * This is a timing transform, not a guarantee of musical fit or audio quality.
 */
export function liveStemTempoStretchRatio(
  recipientBpm: number | null,
  donorBpm: number | null,
): number | null {
  if (recipientBpm === null || donorBpm === null) return null;
  const ratio = tempoRatioForBpm(donorBpm, recipientBpm);
  return ratio !== null && ratio >= 0.5 && ratio <= 2 ? ratio : null;
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
  "sectionIndex" | "startMs" | "endMs" | "startBeatIndex" | "endBeatIndex" | "structuralConfidence"
>;

/**
 * Map the selected recipient section to the donor section at the same structural
 * position. This only aligns source position; it does not claim semantic or
 * harmonic compatibility. Incompatible or low-confidence maps fall back to beat phase.
 */
export function liveStemSectionOffsetSeconds(
  recipientSections: readonly LiveStemSection[] | null | undefined,
  donorSections: readonly LiveStemSection[] | null | undefined,
  recipientPositionSeconds: number,
  stretchRatio: number,
): number | null {
  if (
    !Array.isArray(recipientSections)
    || !Array.isArray(donorSections)
    || recipientSections.length === 0
    || recipientSections.length !== donorSections.length
    || !Number.isFinite(recipientPositionSeconds)
    || recipientPositionSeconds < 0
    || !Number.isFinite(stretchRatio)
    || stretchRatio <= 0
  ) return null;

  const validSections = (sections: readonly LiveStemSection[]) => sections.every((section, index) =>
    section.sectionIndex === index
    && Number.isSafeInteger(section.startMs)
    && Number.isSafeInteger(section.endMs)
    && section.endMs > section.startMs
    && Number.isInteger(section.startBeatIndex)
    && Number.isInteger(section.endBeatIndex)
    && section.endBeatIndex > section.startBeatIndex
    && Number.isFinite(section.structuralConfidence)
    && section.structuralConfidence >= 0.6
    && (index === 0 || section.startMs >= sections[index - 1].endMs),
  );
  if (!validSections(recipientSections) || !validSections(donorSections)) return null;

  const recipientMs = recipientPositionSeconds * 1000;
  const recipient = recipientSections.find((section) =>
    recipientMs >= section.startMs && recipientMs < section.endMs,
  );
  if (!recipient) return null;
  const donor = donorSections[recipient.sectionIndex];
  if (!donor) return null;
  const recipientBeatLength = recipient.endBeatIndex - recipient.startBeatIndex;
  const donorBeatLength = donor.endBeatIndex - donor.startBeatIndex;
  if (Math.abs(recipientBeatLength - donorBeatLength) > 4) return null;

  // Output-coordinate offset: donor section start * stretch = recipient section start + offset.
  return (donor.startMs * stretchRatio - recipient.startMs) / 1000;
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
  currentAnalysis: { bpm: number | null; musicalKey: string | null; beatGridMs: number[] | null } | null,
  nextAnalysis: { bpm: number | null; musicalKey: string | null; beatGridMs: number[] | null } | null,
  mode: TransitionMode,
): CompatibilityEvidence {
  const bothBpm = currentAnalysis?.bpm != null && nextAnalysis?.bpm != null;
  const bothKey = currentAnalysis?.musicalKey != null && nextAnalysis?.musicalKey != null;
  const bothGrids = currentAnalysis?.beatGridMs != null && nextAnalysis?.beatGridMs != null;
  let alignment: EvidenceLabel | null;
  if (mode === "manual") {
    alignment = null;
  } else if (mode === "beat" || mode === "bar") {
    alignment = bothGrids
      ? { level: "real", label: "REAL — verified beat grids (start-time alignment)" }
      : { level: "unavailable", label: "UNAVAILABLE — beat grids missing; use a manual transition" };
  } else {
    alignment = { level: "unavailable", label: "UNAVAILABLE — stored mode; section-aware cueing is not implemented" };
  }
  return {
    tempo: bothBpm
      ? { level: "real", label: "REAL — tempo analysis complete for both tracks" }
      : { level: "unavailable", label: "UNAVAILABLE — tempo analysis missing for one or both tracks" },
    key: bothKey
      ? { level: "real", label: "REAL — key analysis complete for both tracks" }
      : { level: "unavailable", label: "UNAVAILABLE — key analysis missing for one or both tracks" },
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
