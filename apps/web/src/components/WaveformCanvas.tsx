"use client";

import { useEffect, useMemo, useState } from "react";
import type { WaveformDocument } from "@waveyard/types";

type Props = { assetId: string; label: string; position?: number; duration?: number; onSeek?: (seconds: number) => void; compact?: boolean };

function chooseResolution(document: WaveformDocument, compact: boolean) {
  const preferred = compact ? 256 : 1024;
  return document.resolutions[String(preferred)] ?? document.resolutions[Object.keys(document.resolutions).sort((a, b) => Number(a) - Number(b))[0]];
}

export function WaveformCanvas({ assetId, label, position = 0, duration, onSeek, compact = false }: Props) {
  const [document, setDocument] = useState<WaveformDocument | null>(null);
  const [message, setMessage] = useState("Loading real waveform…");
  useEffect(() => {
    let active = true;
    void fetch(`/api/assets/${assetId}/waveform`, { cache: "no-store" }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!active) return;
      if (!response.ok) { setDocument(null); setMessage(body.error ?? "Waveform is not available yet."); return; }
      setDocument(body.waveform); setMessage("");
    }).catch(() => { if (active) { setDocument(null); setMessage("Waveform request failed."); } });
    return () => { active = false; };
  }, [assetId]);

  const peaks = useMemo(() => document ? chooseResolution(document, compact) : null, [compact, document]);
  const renderedDuration = duration ?? document?.durationSeconds ?? 0;
  if (!peaks) return <div className={`waveform-empty ${compact ? "compact" : ""}`} role="status">{message}</div>;
  const viewWidth = peaks.max.length;
  const playhead = renderedDuration > 0 ? Math.min(viewWidth, Math.max(0, (position / renderedDuration) * viewWidth)) : 0;
  return <button type="button" className={`waveform ${compact ? "compact" : ""}`} aria-label={`Seek ${label}`} onClick={(event) => {
    if (!onSeek || renderedDuration <= 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(renderedDuration, ((event.clientX - box.left) / box.width) * renderedDuration)));
  }}>
    <svg viewBox={`0 -1 ${viewWidth} 2`} preserveAspectRatio="none" aria-hidden="true">
      {peaks.max.map((high, index) => <line key={index} x1={index + 0.5} x2={index + 0.5} y1={-high} y2={-peaks.min[index]} />)}
      <line className="waveform-playhead" x1={playhead} x2={playhead} y1="-1" y2="1" />
    </svg>
  </button>;
}
