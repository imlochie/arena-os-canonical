"use client";

import { useEffect, useMemo, useState } from "react";
import type { WaveformDocument } from "@workspace/arena/lib/waveyard/types";

type WaveformJob = { id: string; status: string; errorCode: string | null };
type RetryResult = { ok: boolean; message?: string };
type Props = {
  assetId: string;
  label: string;
  position?: number;
  duration?: number;
  onSeek?: (seconds: number) => void;
  compact?: boolean;
  onRetryJob?: (jobId: string) => Promise<RetryResult>;
};

function chooseResolution(document: WaveformDocument, compact: boolean) {
  const preferred = compact ? 256 : 1024;
  return document.resolutions[String(preferred)] ?? document.resolutions[Object.keys(document.resolutions).sort((a, b) => Number(a) - Number(b))[0]];
}

export function WaveformCanvas({ assetId, label, position = 0, duration, onSeek, compact = false, onRetryJob }: Props) {
  const [document, setDocument] = useState<WaveformDocument | null>(null);
  const [message, setMessage] = useState("Loading real waveform…");
  const [loadState, setLoadState] = useState<"loading" | "error" | "ready">("loading");
  const [attempt, setAttempt] = useState(0);
  const [waveformJob, setWaveformJob] = useState<WaveformJob | null>(null);
  const [retryingJob, setRetryingJob] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    setDocument(null);
    setMessage("Loading real waveform…");
    setLoadState("loading");
    setWaveformJob(null);
    const load = async () => {
      try {
        const response = await fetch(`/api/assets/${assetId}/waveform`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!active) return;
        if (response.ok) {
          const waveform = body.waveform as WaveformDocument | undefined;
          const hasUsableResolution = waveform?.resolutions && Object.values(waveform.resolutions).some((resolution) =>
            Array.isArray(resolution.max) &&
            Array.isArray(resolution.min) &&
            resolution.max.length > 0 &&
            resolution.max.length === resolution.min.length,
          );
          if (!waveform || !hasUsableResolution) {
            setMessage("Waveform data is incomplete. Retry to request it again.");
            setLoadState("error");
            return;
          }
          setDocument(waveform);
          setMessage("");
          setLoadState("ready");
          setWaveformJob(null);
          return;
        }

        const job = body.waveformJob as WaveformJob | null | undefined;
        setWaveformJob(job?.id ? job : null);
        if (job && ["queued", "preparing", "processing", "finalizing"].includes(job.status)) {
          setMessage("Waveform generation is in progress. Audio playback remains available.");
          setLoadState("loading");
          pollTimer = setTimeout(() => void load(), 2_000);
          return;
        }
        if (job?.status === "failed" && job.errorCode === "waveform_pcm_limit") {
          setMessage("This recording is too long to build a waveform within the safe processing limit. Audio playback remains available.");
        } else if (job?.status === "failed" && job.errorCode === "queue_unavailable") {
          setMessage("Waveform generation could not be queued because processing is unavailable. Audio playback remains available.");
        } else if (job?.status === "failed") {
          setMessage("Waveform generation failed. Audio playback remains available.");
        } else {
          setMessage(typeof body.error === "string" ? body.error : "Waveform is not available yet.");
        }
        setLoadState("error");
      } catch (error: unknown) {
        if (!active || (error instanceof Error && error.name === "AbortError")) return;
        setDocument(null);
        setMessage(error instanceof Error ? error.message : "Waveform request failed.");
        setLoadState("error");
      }
    };
    void load();
    return () => {
      active = false;
      controller.abort();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [assetId, attempt]);

  async function retryWaveform() {
    if (onRetryJob && waveformJob?.status === "failed") {
      setRetryingJob(true);
      const result = await onRetryJob(waveformJob.id).catch(() => ({
        ok: false,
        message: "Waveform retry could not reach the server. Audio playback remains available; try again when connected.",
      }));
      setRetryingJob(false);
      if (!result.ok) {
        setMessage(result.message ?? "Waveform retry could not be started. Audio playback remains available.");
        return;
      }
      setMessage("Waveform retry queued. Audio playback remains available while it finishes.");
      setLoadState("loading");
      setAttempt((current) => current + 1);
      return;
    }
    setAttempt((current) => current + 1);
  }

  const peaks = useMemo(() => document ? chooseResolution(document, compact) : null, [compact, document]);
  const renderedDuration = duration ?? document?.durationSeconds ?? 0;
  if (!peaks) return (
    <div className={`waveform-empty ${compact ? "compact" : ""}`}>
      <p role={loadState === "error" ? "alert" : "status"}>{message}</p>
      {loadState === "error" && waveformJob?.errorCode !== "waveform_pcm_limit" && (
        <button
          type="button"
          data-testid="waveform-canvas-retry"
          aria-label={`Retry ${label} waveform`}
          disabled={retryingJob}
          onClick={() => void retryWaveform()}
          className="mt-1 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-white/10"
        >
          {retryingJob ? "Retrying…" : "Retry waveform"}
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
