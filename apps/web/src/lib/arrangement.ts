import { clamp } from "./remix";
import type { RemixClipInput } from "./remix";

export function moveClip(clip: RemixClipInput, timelineStartMs: number) {
  return { ...clip, timelineStartMs: Math.round(Math.max(0, timelineStartMs)) };
}

export function trimClipLeft(
  clip: RemixClipInput,
  timelineStartMs: number,
  sourceDurationMs: number,
) {
  const nextStart = Math.round(Math.max(0, timelineStartMs));
  const delta = nextStart - clip.timelineStartMs;
  if (delta >= 0) {
    const trim = Math.min(delta, clip.durationMs - 1);
    return {
      ...clip,
      timelineStartMs: clip.timelineStartMs + trim,
      sourceOffsetMs: clip.sourceOffsetMs + trim,
      durationMs: clip.durationMs - trim,
    };
  }
  const extension = Math.min(-delta, clip.sourceOffsetMs, clip.timelineStartMs);
  return {
    ...clip,
    timelineStartMs: clip.timelineStartMs - extension,
    sourceOffsetMs: clip.sourceOffsetMs - extension,
    durationMs: Math.min(sourceDurationMs - (clip.sourceOffsetMs - extension), clip.durationMs + extension),
  };
}

export function trimClipRight(
  clip: RemixClipInput,
  timelineEndMs: number,
  sourceDurationMs: number,
) {
  const maximum = sourceDurationMs - clip.sourceOffsetMs;
  const durationMs = Math.round(
    clamp(timelineEndMs - clip.timelineStartMs, 1, Math.max(1, maximum)),
  );
  return { ...clip, durationMs };
}

export function splitClipAt(clip: RemixClipInput, playheadMs: number) {
  const splitAt = Math.round(playheadMs - clip.timelineStartMs);
  if (splitAt <= 0 || splitAt >= clip.durationMs) return null;
  const left = {
    ...clip,
    id: undefined,
    durationMs: splitAt,
    fadeInMs: Math.min(clip.fadeInMs, splitAt),
    fadeOutMs: 0,
  };
  const rightDuration = clip.durationMs - splitAt;
  const right = {
    ...clip,
    id: undefined,
    timelineStartMs: clip.timelineStartMs + splitAt,
    sourceOffsetMs: clip.sourceOffsetMs + splitAt,
    durationMs: rightDuration,
    fadeInMs: 0,
    fadeOutMs: Math.min(clip.fadeOutMs, rightDuration),
  };
  return { left, right };
}
