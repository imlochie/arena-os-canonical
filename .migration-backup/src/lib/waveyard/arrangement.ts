import {
  moveClipTimeline,
  splitEditableClip,
  trimClipLeftBy,
  trimClipRightBy,
} from "./types";
import type { RemixClipInput } from "./remix";

/** Client drag previews intentionally reuse the same ordinary-clip math as the API. */
export function moveClip(clip: RemixClipInput, timelineStartMs: number) {
  return moveClipTimeline(clip, timelineStartMs) ?? clip;
}

export function trimClipLeft(
  clip: RemixClipInput,
  timelineStartMs: number,
  sourceDurationMs: number,
  tempoRatio = 1,
) {
  return trimClipLeftBy(
    clip,
    Math.round(timelineStartMs) - clip.timelineStartMs,
    sourceDurationMs,
    tempoRatio,
  ) ?? clip;
}

export function trimClipRight(
  clip: RemixClipInput,
  timelineEndMs: number,
  sourceDurationMs: number,
  tempoRatio = 1,
) {
  return trimClipRightBy(
    clip,
    Math.round(timelineEndMs) - clip.timelineStartMs - clip.durationMs,
    sourceDurationMs,
    tempoRatio,
  ) ?? clip;
}

export function splitClipAt(
  clip: RemixClipInput,
  playheadMs: number,
  sourceDurationMs = Number.MAX_SAFE_INTEGER,
  tempoRatio = 1,
) {
  return splitEditableClip(clip, playheadMs, sourceDurationMs, tempoRatio);
}
