"use client";

import { useEffect, useMemo, useState } from "react";
import type { WaveformDocument } from "@workspace/arena/lib/waveyard/types";

type Props = { assetId: string; label: string; position?: number; duration?: number; onSeek?: (seconds: number) => void; compact?: boolean };

function chooseResolution(document: WaveformDocument, compact: boolean) {
  const preferred = compact ? 256 : 1024;
  return document.resolutions[String(preferred)] ?? document.resolutions[Object.keys(document.resolutions).sort((a, b) => Number(a) - Number(b))[0]];
}

export function WaveformCanvas({ assetId, label, position = 0, duration, onSeek, compact = false }: Props) {
  const [document, setDocument] = useState<WaveformDocument | null>(null);
  const [message, setMessage] = useState("Loading real waveform…");
  const [loadState, setLoadState] = useState<"loading" | "error" | "ready">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setDocument(null);
    setMessage("Loading real waveform…");
    setLoadState("loading");
    void fetch(`/api/assets/${assetId}/waveform`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!active) return;
      if (!response.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Waveform is not available yet.");
      }
      const waveform = body.waveform as WaveformDocument | undefined;
      const hasUsableResolution = waveform?.resolutions && Object.values(waveform.resolutions).some((resolution) =>
        Array.isArray(resolution.max) &&
        Array.isArray(resolution.min) &&
        resolution.max.length > 0 &&
        resolution.max.length === resolution.min.length,
      );
      if (!waveform || !hasUsableResolution) {
        throw new Error("Waveform data is incomplete. Retry to request it again.");
      }
      setDocument(waveform);
      setMessage("");
      setLoadState("ready");
    }).catch((error: unknown) => {
      if (!active || (error instanceof Error && error.name === "AbortError")) return;
      setDocument(null);
      setMessage(error instanceof Error ? error.message : "Waveform request failed.");
      setLoadState("error");
    });
    return () => { active = false; controller.abort(); };
  }, [assetId, attempt]);

  const peaks = useMemo(() => document ? chooseResolution(document, compact) : null, [compact, document]);
  const renderedDuration = duration ?? document?.durationSeconds ?? 0;
  if (!peaks) return (
    <div className={`waveform-empty ${compact ? "compact" : ""}`}>
      <p role={loadState === "error" ? "alert" : "status"}>{message}</p>
      {loadState === "error" && (
        <button
          type="button"
          data-testid="waveform-canvas-retry"
          aria-label={`Retry ${label} waveform`}
          onClick={() => setAttempt((current) => current + 1)}
          className="mt-1 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-white/10"
        >
          Retry waveform
        </button>
      )}
    </div>
  );
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
