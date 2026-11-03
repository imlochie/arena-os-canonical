/** UI-only helpers: a selected clip is still identified solely by its RemixClip id. */
export function toggleClipSelection(selectedIds: string[], clipId: string) {
  return selectedIds.includes(clipId)
    ? selectedIds.filter((id) => id !== clipId)
    : [...selectedIds, clipId];
}

export function clipRangeSelection(trackClipIds: string[], fromIndex: number, toIndex: number) {
  if (!trackClipIds.length) return [];
  const first = Math.max(0, Math.min(fromIndex, toIndex));
  const last = Math.min(trackClipIds.length - 1, Math.max(fromIndex, toIndex));
  return trackClipIds.slice(first, last + 1);
}

export function trackClipSelection(trackClipIds: string[]) {
  return [...new Set(trackClipIds)];
}

/** Lane order, then chronological clip order (matching Home/End navigation). */
export function orderedClipIds(tracks: { clips: { id?: string; timelineStartMs: number }[] }[]) {
  return tracks.flatMap((track) => track.clips
    .map((clip, index) => ({ ...clip, index }))
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs || a.index - b.index)
    .flatMap((clip) => clip.id ? [clip.id] : []));
}

/** A stable anchor allows an extended range to shrink when direction reverses. */
export function anchoredClipRange(orderedIds: string[], anchorId: string, targetId: string) {
  const from = orderedIds.indexOf(anchorId);
  const to = orderedIds.indexOf(targetId);
  if (to < 0) return [];
  return clipRangeSelection(orderedIds, from < 0 ? to : from, to);
}
