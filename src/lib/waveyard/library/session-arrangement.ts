/** Compile completed session cues into EXISTING remix clips + volume automation.
 * No new arrangement format or database schema. Unrecorded/reordered cues fail
 * closed: only an explicitly requested sequential edit may omit transitions. */
import type { TransitionConfig } from "./session-logic";

export interface SessionPlacement {
  timelineStartMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  keepStems: string[];
}
export function sessionPlacements(items: Array<{ id: string; durationSeconds: number; transition: TransitionConfig }>): SessionPlacement[] {
  let timelineStartMs = 0, sourceStartMs = 0, fadeInMs = 0;
  return items.map((item, index) => {
    const duration = Math.floor(item.durationSeconds * 1000);
    const next = items[index + 1];
    const cue = next ? item.transition.cue : undefined;
    if (next && (!cue || cue.toSessionTrackId !== next.id)) throw new Error(`Track ${index + 1} has no completed transition to its next track. Play that transition, or explicitly choose a sequential edit.`);
    if (index > 0 && cue && cue.fromDeck !== items[index - 1].transition.cue?.toDeck) throw new Error("Saved physical deck identities are inconsistent. Replay the transitions after reordering.");
    const fadeOutMs = cue ? Math.round(item.transition.crossfadeSeconds * 1000) : 0;
    const trigger = cue ? Math.round(cue.fromSeconds * 1000) : duration;
    const sourceEndMs = cue ? trigger + fadeOutMs : duration;
    if (!Number.isFinite(duration) || duration <= 0 || sourceStartMs >= sourceEndMs || trigger < sourceStartMs + fadeInMs || sourceEndMs > duration)
      throw new Error(`Track ${index + 1} has an invalid source range or overlapping transitions. Replay within the available audio range.`);
    const result = { timelineStartMs, sourceStartMs, sourceEndMs, fadeInMs, fadeOutMs, keepStems: item.transition.keepStems };
    if (timelineStartMs + sourceEndMs - sourceStartMs > 86_400_000) throw new Error("The arrangement exceeds Studio’s 24-hour timeline limit.");
    timelineStartMs += trigger - sourceStartMs;
    sourceStartMs = cue ? Math.round(cue.incomingSeconds * 1000) : 0;
    fadeInMs = fadeOutMs;
    return result;
  });
}

/** Lane-wide envelope continues across donor clip boundaries, unlike clip fades. */
export function sessionVolumePoints(p: SessionPlacement, stemType: string, volume: number) {
  const points = new Map<number, number>();
  points.set(p.timelineStartMs, p.fadeInMs > 0 ? 0 : volume);
  if (p.fadeInMs > 0) points.set(p.timelineStartMs + p.fadeInMs, volume);
  if (p.fadeOutMs > 0 && !p.keepStems.includes(stemType)) {
    const end = p.timelineStartMs + p.sourceEndMs - p.sourceStartMs;
    points.set(end - p.fadeOutMs, volume);
    points.set(end, 0);
  }
  return [...points].sort(([a], [b]) => a - b).map(([timelineMs, value]) => ({ timelineMs, value }));
}
