/**
 * Pure player logic for the P2 stem player — no DOM, no audio, no React.
 * The component layer consumes these as the single definition of queue
 * advancement, play-count gating, keyboard routing, and meter mapping, so
 * every rule is testable in Node without fabricating browser audio.
 */

import { shouldCountPlay } from "./model";

export type RepeatMode = "off" | "all" | "one";

/** The minimal queue shape the advancement rules need. */
export interface QueueEntry {
  /** queue item id */
  id: string;
  trackId: string;
}

export type AdvanceDecision =
  | { action: "play"; trackId: string; reason: "next" | "wrap" | "shuffle" | "only" }
  | { action: "stop"; reason: "end-of-queue" | "empty-queue" | "single-repeat-off" };

/**
 * Which track plays after the current one ends.
 *
 * - empty queue → stop
 * - current not in the queue → play the first entry (the queue was rebuilt
 *   around a new context) unless repeat is off and it IS the current track
 * - shuffle → a random OTHER entry (wrap to the same track only when it is
 *   the only one AND repeat is "all")
 * - sequential → the next entry; at the end, repeat "all" wraps to the head
 *   and repeat "off" stops
 * - repeat "one" never advances from here (the engine loop replays in place);
 *   this function is only consulted for "off"/"all"
 */
export function nextTrackFromQueue(
  queue: QueueEntry[],
  currentTrackId: string | null,
  repeat: RepeatMode,
  shuffle: boolean,
  random: () => number = Math.random,
): AdvanceDecision {
  if (queue.length === 0) return { action: "stop", reason: "empty-queue" };
  if (currentTrackId === null) return { action: "play", trackId: queue[0].trackId, reason: "next" };

  const currentIndex = queue.findIndex((entry) => entry.trackId === currentTrackId);
  if (currentIndex === -1) {
    if (repeat === "off" && queue[0].trackId === currentTrackId) {
      return { action: "stop", reason: "end-of-queue" };
    }
    return { action: "play", trackId: queue[0].trackId, reason: "next" };
  }

  if (shuffle) {
    if (queue.length === 1) {
      return repeat === "all"
        ? { action: "play", trackId: currentTrackId, reason: "only" }
        : { action: "stop", reason: "single-repeat-off" };
    }
    const others = queue.filter((entry) => entry.trackId !== currentTrackId);
    const pick = others[Math.floor(random() * others.length) % others.length];
    return { action: "play", trackId: pick.trackId, reason: "shuffle" };
  }

  if (currentIndex + 1 < queue.length) {
    return { action: "play", trackId: queue[currentIndex + 1].trackId, reason: "next" };
  }
  return repeat === "all"
    ? { action: "play", trackId: queue[0].trackId, reason: "wrap" }
    : { action: "stop", reason: "end-of-queue" };
}

/** Previous-track semantics: the entry before the current one; null at the
 * head (the UI disables the button — prev never wraps). */
export function previousTrackFromQueue(
  queue: QueueEntry[],
  currentTrackId: string | null,
): string | null {
  if (queue.length === 0 || currentTrackId === null) return null;
  const currentIndex = queue.findIndex((entry) => entry.trackId === currentTrackId);
  if (currentIndex <= 0) return null;
  return queue[currentIndex - 1].trackId;
}

/**
 * Play counting gate: a listen is recorded at most ONCE per visit and only
 * after real listening (threshold from model.shouldCountPlay — 30s or half
 * the track, whichever comes first).
 */
export function shouldRecordPlay(
  alreadyRecorded: boolean,
  positionSeconds: number,
  durationSeconds: number | null | undefined,
): boolean {
  return !alreadyRecorded && shouldCountPlay(positionSeconds, durationSeconds);
}

/** Keyboard seek step (seconds). */
export const SEEK_STEP_SECONDS = 5;

/**
 * Should a keyboard shortcut apply to this event target? Typing surfaces
 * (inputs, text areas, selects, contenteditable) always win — the player
 * must never steal keystrokes from a focused text field.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const element = target as HTMLElement;
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return element.isContentEditable === true;
}

/** Linear 0..1 level for a meter bar from real analyser data. */
export function meterLevel(meter: { peak: number; rms: number } | undefined | null): number {
  if (meter === undefined || meter === null) return 0;
  if (!Number.isFinite(meter.peak)) return 0;
  return Math.min(1, Math.max(0, meter.peak));
}

/** dB-ish display for a real meter reading; honest "−∞" at silence. */
export function meterDb(meter: { peak: number; rms: number } | undefined | null): string {
  const peak = meter?.peak ?? 0;
  if (!(peak > 0)) return "−∞";
  return `${(20 * Math.log10(peak)).toFixed(1)} dB`;
}
