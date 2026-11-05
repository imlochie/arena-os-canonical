"use client";

import { useState } from "react";
import { displaySourceSectionLabel } from "@workspace/arena/lib/waveyard/types/source-sections";
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
  onFindMeetingPoints,
  onRequestEvents,
}: {
  source: Source;
  onUseForSlice: (section: SourceSection) => void;
  onArrangementAction?: (section: SourceSection, action: ArrangementAction, repetitions: number) => Promise<string | null>;
  onFindMeetingPoints?: (section: SourceSection) => Promise<string | null>;
  onRequestEvents?: () => Promise<string | null>;
}) {
  const sections = source.sections ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [repetitions, setRepetitions] = useState(4);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [acting, setActing] = useState<ArrangementAction | "meeting" | null>(null);
  const [requestingEvents, setRequestingEvents] = useState(false);
  const [eventMessage, setEventMessage] = useState<string | null>(null);
  const events = source.events ?? [];
  const requestEvents = async () => {
    if (!onRequestEvents) return;
    setRequestingEvents(true);
    setEventMessage(null);
    try {
      const message = await onRequestEvents();
      setEventMessage(message ?? "Event analysis queued.");
    } catch {
      setEventMessage("Could not confirm the request. Refresh the source status before trying again.");
    } finally {
      setRequestingEvents(false);
    }
  };
  const eventPanel = <section className="source-events" aria-label="Source musical events">
    <div><span className="eyebrow">Source-coordinate markers</span><h4>Events</h4></div>
    {source.eventAnalysis?.status === "complete" ? <>
      <p>{events.length ? `${events.length} deterministic onset events` : "No onset events met the conservative threshold."}</p>
      {events.length > 0 && <ol>{events.slice(0, 12).map((event) => {
        const dots = "●".repeat(Math.max(1, Math.min(3, Math.round(event.strength * 3))));
        return <li key={event.id}>{sourceTime(event.timestampMs)} <b>{dots}</b></li>;
      })}</ol>}
      {events.length > 12 && <small>+ {events.length - 12} more source-relative events</small>}
    </> : <>
      <p>{source.eventAnalysis?.status === "failed" ? `Event analysis failed${source.eventAnalysis.errorMessage ? `: ${source.eventAnalysis.errorMessage}` : "."}` : "Events are optional deterministic onset evidence; they do not alter Beat Snap or clips."}</p>
      {onRequestEvents && <button type="button" className="button secondary" disabled={requestingEvents} onClick={() => void requestEvents()}>{requestingEvents ? "Queuing…" : source.eventAnalysis?.status === "processing" || source.eventAnalysis?.status === "queued" ? "Event analysis queued" : "Analyze events"}</button>}
      {eventMessage && <p className="notice" role="status">{eventMessage}</p>}
    </>}
    {source.eventAnalysis && <small>Engine {source.eventAnalysis.analysisEngine} {source.eventAnalysis.analysisEngineVersion}</small>}
  </section>;
  if (source.sectionAnalysis?.status !== "complete" || !sections.length) return eventPanel;
  const selected = sections.find((section) => section.id === selectedId) ?? null;
  const durationMs = Math.max(1, Math.round(source.durationSeconds * 1000));
  const label = selected ? displaySourceSectionLabel(selected) : "";
  const act = async (action: ArrangementAction) => {
    if (!selected || !onArrangementAction) return;
    setActing(action);
    setActionMessage(null);
    try {
      const message = await onArrangementAction(selected, action, repetitions);
      setActionMessage(message ?? (action === "loop" ? "Section loop added to the arrangement." : "Section added to the arrangement."));
    } catch {
      setActionMessage("Could not confirm this arrangement change. Refresh Studio before trying again.");
    } finally {
      setActing(null);
    }
  };
  const findMeetingPoints = async () => {
    if (!selected || !onFindMeetingPoints) return;
    setActing("meeting"); setActionMessage(null);
    try {
      const message = await onFindMeetingPoints(selected);
      setActionMessage(message ?? "Placement recommendations updated.");
    } catch {
      setActionMessage("Could not reach the server for placement recommendations. Check your connection and try again.");
    } finally {
      setActing(null);
    }
  };
  return <section className="source-section-map" aria-label="Source structure markers" data-testid={`source-section-map-${source.id}`}>
    <div className="panel-title"><div><span className="eyebrow">Source-coordinate markers</span><h3>Detected structure</h3></div><span>{sections.length} sections</span></div>
    <div className="source-section-ruler" role="list" aria-label="Detected source sections">
      {sections.map((section) => {
        const label = displaySourceSectionLabel(section);
        return <button
        type="button"
        role="listitem"
        className={`source-section-marker ${selected?.id === section.id ? "selected" : ""}`}
        key={section.id}
        style={{ width: `${Math.max(2, ((section.endMs - section.startMs) / durationMs) * 100)}%` }}
        onClick={() => { setSelectedId(section.id); setActionMessage(null); }}
        title={`${label}, bars ${section.startBar} to ${section.endBar}`}
      >{label}</button>;
      })}
    </div>
    {selected ? <div className="source-section-inspection" data-testid={`source-section-inspection-${selected.id}`}>
       <span className="eyebrow">Detected phrase</span>
      <h4>{label}</h4>
      <dl>
        <dt>Bars</dt><dd>{selected.startBar}–{selected.endBar}</dd>
        <dt>Start</dt><dd>{sourceTime(selected.startMs)}</dd>
        <dt>End</dt><dd>{sourceTime(selected.endMs)}</dd>
        <dt>Duration</dt><dd>{sourceTime(selected.endMs - selected.startMs)}</dd>
        <dt>Structural confidence</dt><dd>{selected.structuralConfidence.toFixed(2)}</dd>
        {selected.labelConfidence > 0 && <><dt>{selected.label.startsWith("rhythm-repeat-") ? "Rhythm similarity" : "Label confidence"}</dt><dd>{selected.labelConfidence.toFixed(2)}</dd></>}
      </dl>
      <p>Source beats {selected.startBeatIndex}–{selected.endBeatIndex}. {selected.label.startsWith("rhythm-repeat-") ? "This phrase repeats a similar rhythmic pattern elsewhere in this track; it does not claim a verse/chorus role or cross-song match." : "This marks a bar-aligned boundary; it does not claim a semantic chorus or verse role."}</p>
      <div className="section-arrangement-actions">
        <button className="button secondary" onClick={() => onUseForSlice(selected)}>Use these beats in Slice</button>
        <button className="button" disabled={!onFindMeetingPoints || acting !== null} onClick={() => void findMeetingPoints()}>{acting === "meeting" ? "Finding…" : "Find where this fits"}</button>
        <button className="button" disabled={!onArrangementAction || acting !== null} onClick={() => void act("add")}>{acting === "add" ? "Adding…" : "Add to Arrangement"}</button>
        <button className="button secondary" disabled={!onArrangementAction || acting !== null} onClick={() => void act("insert")}>{acting === "insert" ? "Inserting…" : "Insert at Playhead"}</button>
        <label>Repeat copies <input aria-label="Section loop repetitions" type="number" min="1" max="64" value={repetitions} onChange={(event) => setRepetitions(Math.max(1, Math.min(64, Number(event.target.value) || 1)))} /></label>
        <button className="button secondary" disabled={!onArrangementAction || acting !== null} onClick={() => void act("loop")}>{acting === "loop" ? "Looping…" : "Loop"}</button>
      </div>
      {actionMessage && <p className="notice" role="status">{actionMessage}</p>}
    </div> : <p className="notice">Select a marker to inspect it, prefill Slice, or deliberately add it to the arrangement.</p>}
    {eventPanel}
  </section>;
}
