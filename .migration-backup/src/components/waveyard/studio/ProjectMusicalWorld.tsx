import type { Remix, Stem } from "./types";

export function ProjectMusicalWorld({ remix, stems }: { remix: Remix; stems: Stem[] }) {
  const sourceByStem = new Map(stems.map((stem) => [stem.id, stem.sourceAssetId]));
  const clips = remix.tracks.flatMap((track) => track.clips);
  const sourceCount = new Set(remix.tracks.map((track) => sourceByStem.get(track.stemAssetId)).filter(Boolean)).size;
  const tempoCount = clips.filter((clip) => clip.tempoSyncEnabled).length;
  const keyCount = clips.filter((clip) => clip.keySyncEnabled).length;
  return <section className="project-musical-world" aria-label="Remix musical world"><span className="eyebrow">Remix world</span><div><b>{remix.tempoBpm.toFixed(1)} BPM</b><b>{remix.targetKey ?? "Key not set"}</b></div><small>{sourceCount} participating source{sourceCount === 1 ? "" : "s"} · {tempoCount} tempo transformed · {keyCount} key transformed</small></section>;
}
