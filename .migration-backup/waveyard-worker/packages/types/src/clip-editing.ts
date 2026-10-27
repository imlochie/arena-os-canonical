import type { MusicalClipInput } from "./clip-construction";

export const MAX_CLIPS_PER_TRACK = 256;
export const MAX_TIMELINE_MS = 86_400_000;

export function sourceConsumedMs(clip: Pick<MusicalClipInput, "durationMs">, tempoRatio = 1) {
  if (!Number.isFinite(tempoRatio) || tempoRatio <= 0) return null;
  return Math.max(1, Math.ceil(clip.durationMs * tempoRatio));
}

export function clipWindowIsValid(
  clip: Pick<MusicalClipInput, "timelineStartMs" | "durationMs" | "sourceOffsetMs">,
  sourceDurationMs: number,
  tempoRatio = 1,
) {
  const consumed = sourceConsumedMs(clip, tempoRatio);
  return Boolean(
    consumed
    && Number.isSafeInteger(clip.timelineStartMs)
    && Number.isSafeInteger(clip.durationMs)
    && Number.isSafeInteger(clip.sourceOffsetMs)
    && clip.timelineStartMs >= 0
    && clip.timelineStartMs + clip.durationMs <= MAX_TIMELINE_MS
    && clip.durationMs > 0
    && clip.sourceOffsetMs >= 0
    && clip.sourceOffsetMs + consumed <= sourceDurationMs,
  );
}

export function moveClipTimeline(
  clip: MusicalClipInput,
  timelineStartMs: number,
): MusicalClipInput | null {
  if (!Number.isFinite(timelineStartMs)) return null;
  const start = Math.round(timelineStartMs);
  if (start < 0 || start + clip.durationMs > MAX_TIMELINE_MS) return null;
  return { ...clip, timelineStartMs: start };
}

/** Timeline delta converts to source delta through the existing target/source ratio. */
export function trimClipLeftBy(
  clip: MusicalClipInput,
  requestedTimelineDeltaMs: number,
  sourceDurationMs: number,
  tempoRatio = 1,
): MusicalClipInput | null {
  if (!Number.isFinite(requestedTimelineDeltaMs) || !Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0
    || !Number.isFinite(tempoRatio) || tempoRatio <= 0) return null;
  const requested = Math.round(requestedTimelineDeltaMs);
  if (requested === 0) return clipWindowIsValid(clip, sourceDurationMs, tempoRatio) ? { ...clip } : null;
  if (requested > 0) {
    const maximumTimeline = clip.durationMs - 1;
    const proposedSource = Math.max(1, Math.round(requested * tempoRatio));
    const sourceTrim = Math.min(proposedSource, sourceConsumedMs(clip, tempoRatio)! - 1);
    const timelineTrim = Math.min(maximumTimeline, Math.max(1, Math.round(sourceTrim / tempoRatio)));
    const next = {
      ...clip,
      timelineStartMs: clip.timelineStartMs + timelineTrim,
      sourceOffsetMs: clip.sourceOffsetMs + sourceTrim,
      durationMs: clip.durationMs - timelineTrim,
      fadeInMs: Math.min(clip.fadeInMs, clip.durationMs - timelineTrim - Math.min(clip.fadeOutMs, clip.durationMs - timelineTrim)),
      fadeOutMs: Math.min(clip.fadeOutMs, clip.durationMs - timelineTrim),
    };
    return clipWindowIsValid(next, sourceDurationMs, tempoRatio) ? next : null;
  }
  const maximumSourceExtension = Math.min(clip.sourceOffsetMs, Math.round(clip.timelineStartMs * tempoRatio));
  if (maximumSourceExtension < 1) return { ...clip };
  const sourceExtension = Math.min(maximumSourceExtension, Math.max(1, Math.round(-requested * tempoRatio)));
  const timelineExtension = Math.min(clip.timelineStartMs, Math.max(1, Math.round(sourceExtension / tempoRatio)));
  const next = {
    ...clip,
    timelineStartMs: clip.timelineStartMs - timelineExtension,
    sourceOffsetMs: clip.sourceOffsetMs - sourceExtension,
    durationMs: clip.durationMs + timelineExtension,
  };
  return clipWindowIsValid(next, sourceDurationMs, tempoRatio) ? next : null;
}

export function trimClipRightBy(
  clip: MusicalClipInput,
  requestedTimelineDeltaMs: number,
  sourceDurationMs: number,
  tempoRatio = 1,
): MusicalClipInput | null {
  if (!Number.isFinite(requestedTimelineDeltaMs)) return null;
  const durationMs = clip.durationMs + Math.round(requestedTimelineDeltaMs);
  const next = { ...clip, durationMs, fadeInMs: Math.min(clip.fadeInMs, durationMs), fadeOutMs: Math.min(clip.fadeOutMs, durationMs) };
  if (next.fadeInMs + next.fadeOutMs > durationMs) next.fadeInMs = Math.max(0, durationMs - next.fadeOutMs);
  return clipWindowIsValid(next, sourceDurationMs, tempoRatio) ? next : null;
}

/** Applies one snapped timeline delta to every selected ordinary clip. */
export function moveEditableClips(
  clips: MusicalClipInput[],
  timelineDeltaMs: number,
): MusicalClipInput[] | null {
  if (!clips.length || !Number.isFinite(timelineDeltaMs)) return null;
  const delta = Math.round(timelineDeltaMs);
  const moved = clips.map((clip) => moveClipTimeline(clip, clip.timelineStartMs + delta));
  if (moved.some((clip) => clip === null)) return null;
  return moved as MusicalClipInput[];
}

/** A group duplicate starts after the selected group and retains all internal spacing. */
export function duplicateEditableClips(
  clips: MusicalClipInput[],
  timelineOffsetMs?: number,
): MusicalClipInput[] | null {
  if (!clips.length) return null;
  const firstStart = Math.min(...clips.map((clip) => clip.timelineStartMs));
  const finalEnd = Math.max(...clips.map((clip) => clip.timelineStartMs + clip.durationMs));
  const offset = timelineOffsetMs === undefined ? finalEnd - firstStart : Math.round(timelineOffsetMs);
  if (!Number.isFinite(offset) || offset <= 0) return null;
  const duplicates = clips.map((clip) => ({ ...clip, id: undefined, timelineStartMs: clip.timelineStartMs + offset }));
  return duplicates.every((clip) => clip.timelineStartMs + clip.durationMs <= MAX_TIMELINE_MS) ? duplicates : null;
}

export function hasClipCapacity(currentCount: number, additions: number, maximum = MAX_CLIPS_PER_TRACK) {
  return Number.isSafeInteger(currentCount) && Number.isSafeInteger(additions)
    && currentCount >= 0 && additions >= 0 && currentCount + additions <= maximum;
}

export function slipClipSource(
  clip: MusicalClipInput,
  sourceOffsetMs: number,
  sourceDurationMs: number,
  tempoRatio = 1,
): MusicalClipInput | null {
  if (!Number.isFinite(sourceOffsetMs)) return null;
  const next = { ...clip, sourceOffsetMs: Math.round(sourceOffsetMs) };
  return clipWindowIsValid(next, sourceDurationMs, tempoRatio) ? next : null;
}

/** Produces two contiguous ordinary clips; the caller transactionally replaces the original. */
export function splitEditableClip(
  clip: MusicalClipInput,
  timelineSplitMs: number,
  sourceDurationMs: number,
  tempoRatio = 1,
): { left: MusicalClipInput; right: MusicalClipInput } | null {
  if (!Number.isFinite(timelineSplitMs) || !Number.isFinite(tempoRatio) || tempoRatio <= 0) return null;
  const requested = Math.round(timelineSplitMs - clip.timelineStartMs);
  if (requested <= 0 || requested >= clip.durationMs) return null;
  const sourceSplit = Math.round(requested * tempoRatio);
  if (sourceSplit <= 0) return null;
  const leftDuration = Math.max(1, Math.round(sourceSplit / tempoRatio));
  if (leftDuration >= clip.durationMs) return null;
  const rightDuration = clip.durationMs - leftDuration;
  const left: MusicalClipInput = {
    ...clip, id: undefined, durationMs: leftDuration,
    fadeInMs: Math.min(clip.fadeInMs, leftDuration), fadeOutMs: 0,
  };
  const right: MusicalClipInput = {
    ...clip, id: undefined,
    timelineStartMs: clip.timelineStartMs + leftDuration,
    sourceOffsetMs: clip.sourceOffsetMs + sourceSplit,
    durationMs: rightDuration,
    fadeInMs: 0, fadeOutMs: Math.min(clip.fadeOutMs, rightDuration),
  };
  return clipWindowIsValid(left, sourceDurationMs, tempoRatio) && clipWindowIsValid(right, sourceDurationMs, tempoRatio)
    ? { left, right }
    : null;
}
