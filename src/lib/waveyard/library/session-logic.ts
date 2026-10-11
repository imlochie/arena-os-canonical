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
} from "@/lib/waveyard/types/beat-grid";
import { normaliseMusicalKey, semitoneShift } from "@/lib/waveyard/types/musical-key";

// ------------------------------------------------------------- transitions

export const TRANSITION_MODES = ["manual", "beat", "bar", "meeting-point"] as const;
export type TransitionMode = (typeof TRANSITION_MODES)[number];

export interface TransitionConfig {
  mode: TransitionMode;
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
  const mode = TRANSITION_MODES.includes(value.mode as TransitionMode) ? (value.mode as TransitionMode) : null;
  if (mode === null) return null;
  const seconds = Number(value.crossfadeSeconds);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_CROSSFADE_SECONDS) return null;
  const keepStems = Array.isArray(value.keepStems)
    ? [...new Set(value.keepStems.filter((stem): stem is string => typeof stem === "string" && stem.length > 0 && stem.length <= 64))]
    : [];
  return { mode, crossfadeSeconds: seconds, keepStems };
}

export function defaultTransitionConfig(): TransitionConfig {
  return { mode: "manual", crossfadeSeconds: 4, keepStems: [] };
}

/**
 * Linear crossfade envelope. Gains are REAL multipliers applied to the two
 * transports' master gain nodes by the controller.
 *
 *   elapsed <= 0            → { from: 1, to: 0 }        (not started)
 *   0 < elapsed < duration  → linear interpolation
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
  return { fromGain: 1 - progress, toGain: progress, done: progress >= 1 };
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
