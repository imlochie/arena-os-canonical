import type { RemixTrackInput } from "./remix";
import { normaliseMusicalKey, semitoneShift } from "./types/musical-key";

export type ArrangementPreviewClip = RemixTrackInput["clips"][number] & {
  /** Transient, source-analysis-derived instruction; never persisted. */
  previewKeyShiftSemitones?: number | null;
};

export type ArrangementPreviewTrack = Omit<RemixTrackInput, "clips"> & {
  clips: ArrangementPreviewClip[];
};

export function withArrangementPreviewKeySync<
  T extends { targetKey: string | null; tracks: RemixTrackInput[] },
>(
  state: T,
  sourceKeyByStemId: ReadonlyMap<string, string | null>,
): Omit<T, "tracks"> & { tracks: ArrangementPreviewTrack[] } {
  const targetKey = normaliseMusicalKey(state.targetKey);
  return {
    ...state,
    tracks: state.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        if (!clip.keySyncEnabled) return clip;
        const sourceKey = normaliseMusicalKey(sourceKeyByStemId.get(clip.stemAssetId));
        const semitones = sourceKey && targetKey ? semitoneShift(sourceKey, targetKey) : null;
        return { ...clip, previewKeyShiftSemitones: semitones };
      }),
    })),
  };
}
