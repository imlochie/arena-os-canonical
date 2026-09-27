"use client";

import { useState } from "react";
import type { Source, SourceSection } from "./types";

export function SourceSectionMap({ source, onUseForSlice }: {
  source: Source;
  onUseForSlice: (section: SourceSection) => void;
}) {
  const sections = source.sections ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (source.sectionAnalysis?.status !== "complete" || !sections.length) return null;
  const selected = sections.find((section) => section.id === selectedId) ?? null;
  const durationMs = Math.max(1, Math.round(source.durationSeconds * 1000));
  return <section className="source-section-map" aria-label="Source structure markers" data-testid={`source-section-map-${source.id}`}>
    <div className="panel-title"><div><span className="eyebrow">Source-coordinate markers</span><h3>Detected structure</h3></div><span>{sections.length} sections</span></div>
    <div className="source-section-ruler" role="list" aria-label="Detected source sections">
      {sections.map((section) => <button
        type="button"
        role="listitem"
        className={`source-section-marker ${selected?.id === section.id ? "selected" : ""}`}
        key={section.id}
        style={{ width: `${Math.max(2, ((section.endMs - section.startMs) / durationMs) * 100)}%` }}
        onClick={() => setSelectedId(section.id)}
        title={`Section ${section.sectionIndex + 1}, bars ${section.startBar} to ${section.endBar}`}
      >Section {section.sectionIndex + 1}</button>)}
    </div>
    {selected ? <div className="source-section-inspection">
      <p><b>Section {selected.sectionIndex + 1}</b> · source bars {selected.startBar}–{selected.endBar} · source beats {selected.startBeatIndex}–{selected.endBeatIndex} · {selected.startMs}–{selected.endMs} ms.</p>
      <p>Structural confidence {selected.structuralConfidence.toFixed(2)}. This is a generic structural marker, not a semantic chorus or verse claim.</p>
      <button className="button secondary" onClick={() => onUseForSlice(selected)}>Use these beats in Slice</button>
    </div> : <p className="notice">Select a marker to inspect it or prefill the existing beat Slice controls.</p>}
  </section>;
}
