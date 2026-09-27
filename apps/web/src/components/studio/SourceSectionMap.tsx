"use client";

import { useState } from "react";
import type { Source, SourceSection } from "./types";

type ArrangementAction = "add" | "insert" | "loop";

function sourceTime(milliseconds: number) {
  const value = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor(value / 1_000) % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(value % 1_000).padStart(3, "0")}`;
}

export function SourceSectionMap({
  source,
  onUseForSlice,
  onArrangementAction,
}: {
  source: Source;
  onUseForSlice: (section: SourceSection) => void;
  onArrangementAction?: (section: SourceSection, action: ArrangementAction, repetitions: number) => Promise<string | null>;
}) {
  const sections = source.sections ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [repetitions, setRepetitions] = useState(4);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [acting, setActing] = useState<ArrangementAction | null>(null);
  if (source.sectionAnalysis?.status !== "complete" || !sections.length) return null;
  const selected = sections.find((section) => section.id === selectedId) ?? null;
  const durationMs = Math.max(1, Math.round(source.durationSeconds * 1000));
  const label = selected ? `Section ${String(selected.sectionIndex + 1).padStart(2, "0")}` : "";
  const act = async (action: ArrangementAction) => {
    if (!selected || !onArrangementAction) return;
    setActing(action);
    setActionMessage(null);
    const message = await onArrangementAction(selected, action, repetitions);
    setActing(null);
    setActionMessage(message ?? (action === "loop" ? "Section loop added to the arrangement." : "Section added to the arrangement."));
  };
  return <section className="source-section-map" aria-label="Source structure markers" data-testid={`source-section-map-${source.id}`}>
    <div className="panel-title"><div><span className="eyebrow">Source-coordinate markers</span><h3>Detected structure</h3></div><span>{sections.length} sections</span></div>
    <div className="source-section-ruler" role="list" aria-label="Detected source sections">
      {sections.map((section) => <button
        type="button"
        role="listitem"
        className={`source-section-marker ${selected?.id === section.id ? "selected" : ""}`}
        key={section.id}
        style={{ width: `${Math.max(2, ((section.endMs - section.startMs) / durationMs) * 100)}%` }}
        onClick={() => { setSelectedId(section.id); setActionMessage(null); onUseForSlice(section); }}
        title={`Section ${section.sectionIndex + 1}, bars ${section.startBar} to ${section.endBar}`}
      >Section {section.sectionIndex + 1}</button>)}
    </div>
    {selected ? <div className="source-section-inspection" data-testid={`source-section-inspection-${selected.id}`}>
      <span className="eyebrow">Section</span>
      <h4>{label}</h4>
      <dl>
        <dt>Bars</dt><dd>{selected.startBar}–{selected.endBar}</dd>
        <dt>Start</dt><dd>{sourceTime(selected.startMs)}</dd>
        <dt>End</dt><dd>{sourceTime(selected.endMs)}</dd>
        <dt>Duration</dt><dd>{sourceTime(selected.endMs - selected.startMs)}</dd>
        <dt>Structural confidence</dt><dd>{selected.structuralConfidence.toFixed(2)}</dd>
        {selected.labelConfidence > 0 && <><dt>Label confidence</dt><dd>{selected.labelConfidence.toFixed(2)}</dd></>}
      </dl>
      <p>Source beats {selected.startBeatIndex}–{selected.endBeatIndex}. This is a generic structural marker, not a semantic chorus or verse claim.</p>
      <div className="section-arrangement-actions">
        <button className="button secondary" onClick={() => onUseForSlice(selected)}>Use these beats in Slice</button>
        <button className="button" disabled={!onArrangementAction || acting !== null} onClick={() => void act("add")}>{acting === "add" ? "Adding…" : "Add to Arrangement"}</button>
        <button className="button secondary" disabled={!onArrangementAction || acting !== null} onClick={() => void act("insert")}>{acting === "insert" ? "Inserting…" : "Insert at Playhead"}</button>
        <label>Repeat copies <input aria-label="Section loop repetitions" type="number" min="1" max="64" value={repetitions} onChange={(event) => setRepetitions(Math.max(1, Math.min(64, Number(event.target.value) || 1)))} /></label>
        <button className="button secondary" disabled={!onArrangementAction || acting !== null} onClick={() => void act("loop")}>{acting === "loop" ? "Looping…" : "Loop"}</button>
      </div>
      {actionMessage && <p className="notice" role="status">{actionMessage}</p>}
    </div> : <p className="notice">Select a marker to inspect it, prefill Slice, or deliberately add it to the arrangement.</p>}
  </section>;
}
