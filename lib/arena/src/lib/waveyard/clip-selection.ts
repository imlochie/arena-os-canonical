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
