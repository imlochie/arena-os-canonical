"use client";

import { useState } from "react";
import { chordLabel } from "@waveyard/types";
import type { Source } from "./types";

function sourceTime(milliseconds: number) {
  const seconds = Math.max(0, milliseconds) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
}

/** Compact source-coordinate harmonic evidence; it never replaces source key. */
export function HarmonyAnalysisPanel({ source, onRequestAnalysis }: { source: Source; onRequestAnalysis?: () => Promise<string | null> }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const analysis = source.harmonyAnalysis;
  const events = source.harmonyEvents ?? [];
  const selected = events.find((event) => event.id === selectedId) ?? null;
  const request = async () => {
    if (!onRequestAnalysis) return;
    setRequesting(true); setMessage(await onRequestAnalysis()); setRequesting(false);
  };
  return <section className="harmony-analysis" aria-label="Harmony analysis">
    <div className="panel-title"><div><span className="eyebrow">Source-coordinate evidence</span><h3>Harmony</h3></div>{analysis && <span>{analysis.status}</span>}</div>
    {!analysis || analysis.status !== "complete" ? <>
      <p className={analysis?.status === "failed" ? "error" : "notice"}>{analysis?.status === "failed" ? `Harmony analysis failed${analysis.errorMessage ? `: ${analysis.errorMessage}` : "."}` : "A coarse harmonic timeline augments the existing global source key; it does not replace it."}</p>
      {onRequestAnalysis && <button className="button secondary" disabled={requesting || analysis?.status === "queued" || analysis?.status === "processing"} onClick={() => void request()}>{requesting ? "Queuing…" : analysis?.status === "failed" ? "Retry harmony analysis" : analysis?.status ? "Harmony analysis queued" : "Analyze harmony"}</button>}
      {message && <p className="notice">{message}</p>}
    </> : <>
      <div className="harmony-ruler" role="list" aria-label="Detected harmonic timeline">
        {events.map((event) => <button type="button" role="listitem" className={selected?.id === event.id ? "selected" : ""} key={event.id} onClick={() => setSelectedId(event.id)}>{chordLabel(event)}</button>)}
      </div>
      {selected ? <dl className="harmony-inspection"><dt>Root</dt><dd>{selected.root ?? "Unknown"}</dd><dt>Quality</dt><dd>{selected.quality}</dd><dt>Confidence</dt><dd>{Math.round(selected.confidence * 100)}%</dd><dt>Source time</dt><dd>{sourceTime(selected.startMs)}–{sourceTime(selected.endMs)}</dd></dl> : <p>Select a chord window to inspect its source time and confidence.</p>}
      <small>Global source key remains separate. Chords are source-relative observations and do not edit clips.</small>
    </>}
  </section>;
}
