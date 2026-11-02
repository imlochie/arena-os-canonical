import { effectiveMuted, type RemixTrackInput } from "./remix";

export function selectArrangementPreviewTracks(tracks: RemixTrackInput[]) {
  const anySolo = tracks.some((track) => track.solo);
  const audibleTracks = tracks.filter((track) => !effectiveMuted(track, anySolo));
  const assetIds = [...new Set(
    audibleTracks.flatMap((track) => track.clips.map((clip) => clip.stemAssetId)),
  )];
  return { audibleTracks, assetIds };
}
