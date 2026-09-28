"use client";

import { useState } from "react";
import type { Stem } from "./types";

function clockMs(milliseconds: number) {
  const seconds = Math.max(0, milliseconds) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

/** Read-only evidence from an isolated vocals stem; it does not create notes or edit audio. */
export function VocalAnalysisSummary({
  stem,
  editable = false,
  onRequestAnalysis,
  onExportMidi,
}: {
  stem: Stem;
  editable?: boolean;
  onRequestAnalysis?: () => Promise<string | null>;
  onExportMidi?: () => Promise<string | null>;
}) {
  const [requesting, setRequesting] = useState(false);
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  if (stem.stemType !== "vocals") return null;
  const analysis = stem.vocalAnalysis;
  const request = async () => {
    if (!onRequestAnalysis) return;
    setRequesting(true);
    setRequestMessage(await onRequestAnalysis());
    setRequesting(false);
  };
  const exportMidi = async () => {
    if (!onExportMidi) return;
    setRequesting(true);
    setRequestMessage(await onExportMidi() ?? "MIDI export queued from the immutable version.");
    setRequesting(false);
  };
  if (!analysis) return <section className="vocal-analysis-summary" aria-label="Vocal stem pitch observation">
    <p>No vocal pitch observation is recorded for this isolated stem.</p>
    {editable && onRequestAnalysis && <button className="button secondary" disabled={requesting} onClick={() => void request()}>{requesting ? "Queuing…" : "Analyze vocal stem"}</button>}
    {requestMessage && <p className="error">{requestMessage}</p>}
  </section>;
  if (analysis.status !== "complete") {
    return <section className="vocal-analysis-summary" aria-label="Vocal stem pitch observation">
      <p className={analysis.status === "failed" ? "error" : "analysis-notice"}>
        Vocal stem observation: {analysis.status} · {analysis.stage}
        {analysis.errorMessage ? ` · ${analysis.errorMessage}` : ""}
      </p>
      {editable && analysis.status === "failed" && onRequestAnalysis && <button className="button secondary" disabled={requesting} onClick={() => void request()}>{requesting ? "Queuing…" : "Retry vocal observation"}</button>}
      {requestMessage && <p className="error">{requestMessage}</p>}
    </section>;
  }
  const frames = stem.vocalFrames ?? [];
  const phrases = stem.vocalPhrases ?? [];
  const voiced = frames.filter((frame) => frame.voiced);
  const range = voiced.length ? `${Math.min(...voiced.map((frame) => frame.nearestMidiNote ?? 0))}–${Math.max(...voiced.map((frame) => frame.nearestMidiNote ?? 0))}` : "No voiced frames";
  return <section className="vocal-analysis-summary" aria-label="Vocal stem pitch observation">
    <div><b>Vocal stem observation</b><small>{voiced.length} voiced frames · MIDI range {range} · {phrases.length} coarse phrases</small></div>
    {phrases.length > 0 && <ol>
      {phrases.slice(0, 6).map((phrase, index) => <li key={phrase.id}>Phrase {index + 1}: {clockMs(phrase.startMs)}–{clockMs(phrase.endMs)} · confidence {Math.round(phrase.confidence * 100)}%</li>)}
    </ol>}
    <p>Source-relative pitch evidence from the isolated vocals stem only. It does not correct audio, create lyrics, or generate music.</p>
    {onExportMidi && <button className="button secondary" disabled={requesting} onClick={() => void exportMidi()}>{requesting ? "Queuing…" : "Export MIDI"}</button>}
    {requestMessage && <p className="notice">{requestMessage}</p>}
  </section>;
}
