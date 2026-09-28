"use client";

import type { Source, Stem } from "./types";

export function SourcePool({ sources, stems, selectedStemId, onSelectStem }: { sources: Source[]; stems: Stem[]; selectedStemId: string; onSelectStem: (id: string) => void }) {
  return <section className="source-pool" aria-label="Project source pool">
    <div className="panel-title"><div><span className="eyebrow">Musical palette</span><h3>Project sources</h3></div><span>{sources.length} available</span></div>
    <div className="source-pool-grid">{sources.map((source) => {
      const sourceStems = stems.filter((stem) => stem.sourceAssetId === source.id);
      const selected = sourceStems.some((stem) => stem.id === selectedStemId);
      return <article key={source.id} className={selected ? "selected" : ""}><button type="button" onClick={() => sourceStems[0] && onSelectStem(sourceStems[0].id)}><b>{source.originalFilename}</b><small>{source.analysis?.status === "complete" ? `${source.analysis.bpm?.toFixed(1) ?? "—"} BPM · ${source.analysis.musicalKey ?? "Key unavailable"}` : "Analysis pending"}</small><span>{source.sections?.length ? `${source.sections.length} sections` : "Structure unavailable"} · {sourceStems.map((stem) => stem.stemType).join(" · ") || "Stems pending"}</span></button></article>;
    })}</div>
  </section>;
}
