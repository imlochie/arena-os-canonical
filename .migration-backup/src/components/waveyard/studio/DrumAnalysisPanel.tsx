"use client";

import { useState } from "react";
import type { Source, Stem } from "./types";

function sourceTime(milliseconds: number) {
  const seconds = Math.max(0, milliseconds) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
}

/** Observational drum-transient view. Beat positions remain the source analysis grid. */
export function DrumAnalysisPanel({
  stem,
  source,
  onRequestAnalysis,
  onExportMidi,
}: {
  stem: Stem;
  source: Source;
  onRequestAnalysis?: () => Promise<string | null>;
  onExportMidi?: () => Promise<string | null>;
}) {
  const [requesting, setRequesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (stem.stemType !== "drums" && stem.stemType !== "percussion") return null;
  const analysis = stem.drumAnalysis;
  const events = stem.drumEvents ?? [];
  const request = async () => {
    if (!onRequestAnalysis) return;
    setRequesting(true);
    setMessage(await onRequestAnalysis());
    setRequesting(false);
  };
  const exportMidi = async () => {
    if (!onExportMidi) return;
    setRequesting(true);
    setMessage(await onExportMidi() ?? "MIDI export queued from the immutable version.");
    setRequesting(false);
  };
  return <section className="drum-analysis" aria-label="Drum analysis">
    <div className="panel-title"><div><span className="eyebrow">Isolated {stem.stemType} stem</span><h3>Drum analysis</h3></div>{analysis && <span>{analysis.status}</span>}</div>
    {!analysis || analysis.status !== "complete" ? <>
      <p className={analysis?.status === "failed" ? "error" : "notice"}>
        {analysis?.status === "failed" ? `Drum analysis failed${analysis.errorMessage ? `: ${analysis.errorMessage}` : "."}` : "Transient evidence is optional and never changes clips or the beat grid."}
      </p>
      {onRequestAnalysis && <button className="button secondary" disabled={requesting || analysis?.status === "queued" || analysis?.status === "processing"} onClick={() => void request()}>{requesting ? "Queuing…" : analysis?.status === "failed" ? "Retry drum analysis" : analysis?.status ? "Drum analysis queued" : "Analyze drum stem"}</button>}
      {message && <p className="notice">{message}</p>}
    </> : <>
      <dl className="drum-analysis-counts">
        <dt>Events</dt><dd>{events.length}</dd>
        <dt>Kick</dt><dd>{events.filter((event) => event.rhythmicClass === "kick").length}</dd>
        <dt>Snare</dt><dd>{events.filter((event) => event.rhythmicClass === "snare").length}</dd>
        <dt>Hat</dt><dd>{events.filter((event) => event.rhythmicClass === "hat").length}</dd>
        <dt>Other</dt><dd>{events.filter((event) => event.rhythmicClass === "other").length}</dd>
      </dl>
      <div className="drum-event-ruler" aria-label="Drum events alongside source beat grid">
        {(source.analysis?.beatGrid ?? []).slice(0, 32).map((beat, index) => <span key={`${beat}-${index}`} title={`Beat ${index + 1}`}>|</span>)}
      </div>
      {events.length ? <ol>{events.slice(0, 16).map((event) => <li key={event.id}><b>{event.rhythmicClass?.toUpperCase() ?? "UNKNOWN"}</b> · {sourceTime(event.timestampMs)} · confidence {Math.round(event.confidence * 100)}%{event.nearestBeatIndex !== null ? ` · beat ${event.nearestBeatIndex + 1} ${event.beatOffsetMs! >= 0 ? "+" : ""}${event.beatOffsetMs}ms` : ""}</li>)}</ol> : <p>No transient met the conservative threshold.</p>}
      <small>Classes are conservative frequency-band evidence, not professional drum transcription. Markers are source-relative observations only.</small>
      {onExportMidi && <button className="button secondary" disabled={requesting} onClick={() => void exportMidi()}>{requesting ? "Queuing…" : "Export MIDI"}</button>}
      {message && <p className="notice">{message}</p>}
    </>}
  </section>;
}
