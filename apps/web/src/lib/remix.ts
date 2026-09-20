export type RemixClipInput = {
  id?: string;
  stemAssetId: string;
  timelineStartMs: number;
  durationMs: number;
  sourceOffsetMs: number;
  gain: number;
};
export type RemixTrackInput = {
  id: string;
  stemAssetId: string;
  name: string;
  sortOrder: number;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  clips: RemixClipInput[];
};
export type RemixStateInput = {
  name?: string;
  masterVolume: number;
  loopStartMs: number;
  loopEndMs: number | null;
  tracks: RemixTrackInput[];
};

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
export function clamp(value: unknown, lower: number, upper: number) {
  return Math.min(upper, Math.max(lower, finiteNumber(value, lower)));
}
export function normaliseRemixState(raw: unknown): RemixStateInput | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<RemixStateInput>;
  if (!Array.isArray(value.tracks) || value.tracks.length > 32) return null;
  const tracks: RemixTrackInput[] = [];
  for (const [trackIndex, input] of value.tracks.entries()) {
    if (!input || typeof input !== "object" || !input.id || !input.stemAssetId || !Array.isArray(input.clips) || input.clips.length > 256) return null;
    const clips: RemixClipInput[] = [];
    for (const clip of input.clips) {
      if (!clip || typeof clip !== "object" || !clip.stemAssetId) return null;
      const timelineStartMs = Math.round(clamp(clip.timelineStartMs, 0, 86_400_000));
      const durationMs = Math.round(clamp(clip.durationMs, 1, 86_400_000));
      const sourceOffsetMs = Math.round(clamp(clip.sourceOffsetMs, 0, 86_400_000));
      clips.push({ id: clip.id, stemAssetId: String(clip.stemAssetId), timelineStartMs, durationMs, sourceOffsetMs, gain: clamp(clip.gain, 0, 4) });
    }
    tracks.push({
      id: String(input.id), stemAssetId: String(input.stemAssetId), name: String(input.name || "Stem").slice(0, 80), sortOrder: Math.round(clamp(input.sortOrder ?? trackIndex, 0, 99)),
      volume: clamp(input.volume, 0, 2), pan: clamp(input.pan, -1, 1), muted: input.muted === true, solo: input.solo === true, clips,
    });
  }
  const loopStartMs = Math.round(clamp(value.loopStartMs, 0, 86_400_000));
  const loopEndCandidate = value.loopEndMs === null || value.loopEndMs === undefined ? null : Math.round(clamp(value.loopEndMs, 0, 86_400_000));
  return {
    name: value.name ? String(value.name).trim().slice(0, 120) : undefined,
    masterVolume: clamp(value.masterVolume, 0, 2),
    loopStartMs,
    loopEndMs: loopEndCandidate && loopEndCandidate > loopStartMs ? loopEndCandidate : null,
    tracks,
  };
}

export function effectiveMuted(track: Pick<RemixTrackInput, "muted" | "solo">, anySolo: boolean) {
  return track.muted || (anySolo && !track.solo);
}
