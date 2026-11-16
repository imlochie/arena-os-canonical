import type { Remix, Stem } from "./types";

export function ProjectMusicalWorld({ remix, stems }: { remix: Remix; stems: Stem[] }) {
  const sourceByStem = new Map(stems.map((stem) => [stem.id, stem.sourceAssetId]));
  const clips = remix.tracks.flatMap((track) => track.clips);
  const sourceCount = new Set(remix.tracks.map((track) => sourceByStem.get(track.stemAssetId)).filter(Boolean)).size;
  const tempoCount = clips.filter((clip) => clip.tempoSyncEnabled).length;
  const keyCount = clips.filter((clip) => clip.keySyncEnabled).length;
  const tempoLabel = tempoCount > 0
    ? `${remix.tempoBpm.toFixed(1)} BPM`
    : `${remix.tempoBpm.toFixed(1)} BPM grid`;
  const tempoStatus = tempoCount > 0
    ? `${tempoCount} source clip${tempoCount === 1 ? "" : "s"} tempo-synced`
    : "No source audio is tempo-synced; BPM is the Studio grid only";
  return (
    <section className="project-musical-world" aria-label="Remix musical world">
      <span className="eyebrow">Remix world</span>
      <div><b>{tempoLabel}</b><b>{remix.targetKey ?? "Key not set"}</b></div>
      <small>{sourceCount} participating source{sourceCount === 1 ? "" : "s"} · {tempoStatus} · {keyCount} key transformed</small>
    </section>
  );
}
