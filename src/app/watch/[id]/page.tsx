"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Film, Gauge, Loader2, MonitorPlay } from "lucide-react";

/**
 * The local watch page — play a file from your own library with zero
 * third-party servers in the loop: Arena streams the bytes (Range-capable),
 * Arena records the progress, Arena transcodes on demand through the
 * Toolbox engine when the codec isn't browser-safe.
 */

type ShelfItem = {
  id: number;
  title: string;
  year: number | null;
  itemType: string;
  libraryName: string;
  durationMs: number | null;
  viewCount: number;
  viewOffsetMs: number;
  fileName: string;
  videoCodec: string | null;
};

type Playability =
  | { mode: "direct"; reason: string }
  | { mode: "cached"; reason: string }
  | { mode: "transcode"; reason: string };

type TranscodeState = { status: "running" | "done" | "failed"; progress: number | null; error: string | null } | null;

const fmt = (ms: number | null): string => {
  if (ms === null) return "—";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

export default function WatchPage() {
  const routeParams = useParams<{ id: string }>();
  const params = routeParams?.id && /^\d+$/.test(routeParams.id) ? routeParams.id : null;
  const [item, setItem] = useState<ShelfItem | null>(null);
  const [playability, setPlayability] = useState<Playability | null>(null);
  const [transcode, setTranscode] = useState<TranscodeState>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastPosted = useRef(0);

  const refresh = useCallback(async () => {
    if (!params) return;
    try {
      const response = await fetch(`/api/library?id=${params}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message ?? `HTTP ${response.status}`);
        return;
      }
      setItem(data.item);
      setPlayability(data.playability);
      setTranscode(data.transcode ?? null);
    } catch (e) {
      setError(String(e));
    }
  }, [params]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While a transcode runs, poll for progress; when it finishes, resume playback.
  useEffect(() => {
    if (transcode?.status !== "running") return;
    const timer = setInterval(() => void refresh(), 900);
    return () => clearInterval(timer);
  }, [transcode?.status, refresh]);

  // Post OUR OWN watch progress every 10s while playing, and on pause.
  const postProgress = useCallback(
    (finished = false) => {
      const video = videoRef.current;
      if (!video || !params || !Number.isFinite(video.currentTime) || video.currentTime <= 0) return;
      const positionMs = Math.round(video.currentTime * 1000);
      if (!finished && Math.abs(positionMs - lastPosted.current) < 5000) return;
      lastPosted.current = positionMs;
      void fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          action: "progress",
          itemId: Number(params),
          positionMs,
          durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
          finished,
        }),
      }).catch(() => {});
    },
    [params],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => postProgress();
    const onPause = () => postProgress();
    const onEnded = () => postProgress(true);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
    };
  }, [postProgress, item]);

  const requestTranscode = useCallback(async () => {
    if (!params) return;
    const response = await fetch("/api/library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "transcode", itemId: Number(params) }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.message ?? `HTTP ${response.status}`);
      return;
    }
    if (data.skipped) {
      await refresh();
      return;
    }
    setTranscode(data.transcode);
  }, [params, refresh]);

  if (error && !item) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <Link href="/rooms/archive-assistant" className="text-sm text-slate-400 hover:text-white">
          <ArrowLeft size={14} className="mr-1 inline" aria-hidden="true" /> Archive Assistant
        </Link>
        <p className="mt-6 text-rose-300">{error}</p>
      </main>
    );
  }

  if (!item || !playability) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <Loader2 className="animate-spin text-amber-400" size={22} aria-hidden="true" />
      </main>
    );
  }

  const streamUrl = `/api/library/stream/${item.id}`;
  const canPlayNow = playability.mode === "direct" || playability.mode === "cached";

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/rooms/archive-assistant" className="text-sm text-slate-400 hover:text-white">
        <ArrowLeft size={14} className="mr-1 inline" aria-hidden="true" /> Archive Assistant
      </Link>
      <h1 className="mt-4 flex flex-wrap items-baseline gap-2 text-3xl font-black text-white">
        <Film className="text-amber-400" size={24} aria-hidden="true" />
        {item.title}
        {item.year !== null && <span className="text-lg font-bold text-slate-400">({item.year})</span>}
      </h1>
      <p className="mt-1 text-xs text-slate-500">
        {item.libraryName} · {fmt(item.durationMs)} · {item.fileName}
        {item.viewCount > 0 && ` · watched ${item.viewCount}×`}
      </p>

      <div className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-black">
        {canPlayNow ? (
          <video
            ref={videoRef}
            className="aspect-video w-full"
            controls
            playsInline
            preload="metadata"
            src={streamUrl}
          />
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 px-8 text-center">
            <MonitorPlay size={34} className="text-slate-500" aria-hidden="true" />
            <p className="text-sm text-slate-300">This file won&apos;t play natively in a browser.</p>
            <p className="max-w-md text-xs leading-5 text-slate-500">{playability.reason}</p>
            {transcode?.status === "running" ? (
              <div className="w-full max-w-sm">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-amber-500 transition-all"
                    style={{ width: `${Math.round((transcode.progress ?? 0) * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-amber-300">
                  <Loader2 size={11} className="mr-1 inline animate-spin" aria-hidden="true" />
                  Building a playable H.264 copy ({Math.round((transcode.progress ?? 0) * 100)}%)…
                </p>
              </div>
            ) : transcode?.status === "failed" ? (
              <p className="text-xs text-rose-300">Transcode failed: {transcode.error}</p>
            ) : (
              <button
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500"
                onClick={() => void requestTranscode()}
              >
                <Gauge size={13} className="mr-1.5 inline" aria-hidden="true" />
                Make browser-playable (1080p H.264)
              </button>
            )}
            {transcode?.status === "done" && (
              <button className="text-xs text-amber-300 underline" onClick={() => void refresh()}>
                Refresh
              </button>
            )}
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-500">
        {playability.mode === "direct" && `▶ Direct play — ${playability.reason}. Streamed straight from your disk.`}
        {playability.mode === "cached" && `▶ Playing the cached H.264 copy Arena built (source untouched).`}
        {playability.mode === "transcode" && `⚠ Needs a playable copy — the source is never modified.`}
      </p>
      <p className="mt-1 text-xs text-slate-600">
        Watch progress is recorded in Arena&apos;s own database — not by Plex, not by anyone.
      </p>
    </main>
  );
}
