"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Gauge, HardDrive, Loader2, Trash2, Upload, Wrench } from "lucide-react";

/**
 * The Toolbox — local file conversion. The HandBrake / converter-website
 * replacement: everything runs on this machine through the bundled ffmpeg,
 * nothing is uploaded anywhere, and the engine used (hardware or software)
 * is labeled on every job.
 */

type Probe = {
  kind: "video" | "audio" | "image";
  durationSec: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
};

type Job = {
  id: string;
  presetLabel: string;
  kind: string;
  inputName: string;
  outputName: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number | null;
  speed: string | null;
  engine: string;
  inputBytes: number;
  outputBytes: number | null;
  outCodec: string | null;
  error: string | null;
};

type Preset = {
  id: string;
  label: string;
  kind: "video" | "audio" | "image";
  targetExt: string;
  description: string;
  notes?: string;
};

const input =
  "w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-amber-500 focus:outline-none";
const button =
  "rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-50";

const fmtBytes = (n: number | null): string => {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

const fmtDuration = (s: number | null): string => {
  if (s === null) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
};

export default function ToolboxPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [hardware, setHardware] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  // upload state
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<{ path: string; name: string; size: number; probe: Probe } | null>(null);
  const [presetId, setPresetId] = useState("fast-1080p");
  const [converting, setConverting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // custom
  const [width, setWidth] = useState(1280);
  const [fps, setFps] = useState(30);
  const [quality, setQuality] = useState(22);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/toolbox", { cache: "no-store" });
      const data = await response.json();
      setJobs(data.jobs ?? []);
      setHardware(data.hardware ?? null);
      setPresets(data.presets ?? []);
    } catch {
      /* best effort */
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 900);
    return () => clearInterval(timer);
  }, [refresh]);

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      setMessage(null);
      try {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/toolbox", { method: "POST", body: form });
        const data = await response.json();
        if (!response.ok) {
          setMessage(`✗ ${data.message ?? response.status}`);
          return;
        }
        setUploaded(data);
        // preselect a sensible preset for the detected kind
        const kind = data.probe?.kind ?? "video";
        const preferred =
          kind === "image" ? "image-webp" : kind === "audio" ? "extract-mp3" : "fast-1080p";
        setPresetId(preferred);
      } catch (e) {
        setMessage(`✗ ${String(e)}`);
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const convert = useCallback(async () => {
    if (!uploaded || converting) return;
    setConverting(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        action: "convert",
        path: uploaded.path,
        name: uploaded.name,
        presetId,
      };
      if (presetId === "custom") {
        body.width = width;
        body.fps = fps;
        body.quality = quality;
      }
      const response = await fetch("/api/toolbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(`✗ ${data.message ?? response.status}`);
        return;
      }
      setMessage(`✓ Queued: ${data.job.outputName}`);
      setUploaded(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setMessage(`✗ ${String(e)}`);
    } finally {
      setConverting(false);
    }
  }, [uploaded, converting, presetId, width, fps, quality]);

  const remove = useCallback(async (id: string) => {
    await fetch("/api/toolbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    });
    refresh();
  }, [refresh]);

  const visiblePresets = presets; // all presets shown; cross-kind is legit (mp3 from a video)
  const selected = visiblePresets.find((p) => p.id === presetId);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="flex items-center gap-2 text-3xl font-black text-white">
        <Wrench className="text-amber-400" size={26} aria-hidden="true" />
        Toolbox
      </h1>
      <p className="mt-2 text-sm text-slate-400">
        Convert video, audio and images locally — the converter websites and HandBrake, replaced. Everything runs on
        this machine through the bundled ffmpeg; nothing is uploaded anywhere, ever.
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
        {hardware ? (
          <>
            <Gauge size={13} className="text-emerald-400" aria-hidden="true" />
            Hardware encoder detected: <span className="font-mono text-emerald-300">{hardware}</span> — jobs prefer it and say so.
          </>
        ) : (
          <>
            <HardDrive size={13} className="text-slate-400" aria-hidden="true" />
            No hardware encoder found — using software (libx264), honestly labeled.
          </>
        )}
      </p>

      {/* upload + preset */}
      <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-lg font-bold text-white">Convert a file</h2>
        <label className="mt-3 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 bg-black/20 px-6 py-8 text-center hover:border-amber-500/50">
          <Upload size={22} className="text-amber-300" aria-hidden="true" />
          <span className="text-sm text-slate-300">
            {uploaded ? uploaded.name : "Drop or pick a file (video / audio / image, up to 2 GB)"}
          </span>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept="video/*,audio/*,image/*,.mkv,.flac,.opus"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>

        {uploaded && (
          <div className="mt-3 rounded-xl border border-amber-400/15 bg-amber-400/5 p-3 text-sm">
            <p className="font-bold text-white">
              {uploaded.name}
              <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-300">
                {uploaded.probe.kind}
              </span>
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              {fmtBytes(uploaded.size)}
              {uploaded.probe.durationSec !== null && ` · ${fmtDuration(uploaded.probe.durationSec)}`}
              {uploaded.probe.width !== null && ` · ${uploaded.probe.width}×${uploaded.probe.height}`}
              {uploaded.probe.videoCodec && ` · ${uploaded.probe.videoCodec}`}
              {uploaded.probe.audioCodec && ` · audio: ${uploaded.probe.audioCodec}`}
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <select className={input} value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                {(["video", "audio", "image"] as const).map((group) => (
                  <optgroup key={group} label={group.toUpperCase()}>
                    {visiblePresets
                      .filter((p) => p.kind === group)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} → .{p.targetExt}
                        </option>
                      ))}
                  </optgroup>
                ))}
                <optgroup label="CUSTOM">
                  <option value="custom">Custom (H.264, your knobs)</option>
                </optgroup>
              </select>
              <button className={button} disabled={converting} onClick={() => void convert()}>
                {converting ? "Queuing…" : "Convert"}
              </button>
            </div>
            {selected && (
              <p className="mt-2 text-[11px] leading-5 text-slate-400">
                {selected.description}
                {selected.notes ? ` — ${selected.notes}` : ""}
              </p>
            )}
            {presetId === "custom" && (
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <label className="text-[11px] text-slate-400">
                  Width cap
                  <input className={input} type="number" min={16} max={7680} value={width} onChange={(e) => setWidth(Number(e.target.value) || 1280)} />
                </label>
                <label className="text-[11px] text-slate-400">
                  FPS cap
                  <input className={input} type="number" min={1} max={60} value={fps} onChange={(e) => setFps(Number(e.target.value) || 30)} />
                </label>
                <label className="text-[11px] text-slate-400">
                  CRF quality (lower = better)
                  <input className={input} type="number" min={0} max={51} value={quality} onChange={(e) => setQuality(Number(e.target.value) || 22)} />
                </label>
              </div>
            )}
          </div>
        )}
        {message && <p className="mt-2 break-words text-xs text-amber-300">{message}</p>}
      </div>

      {/* queue */}
      <div className="mt-6 space-y-2">
        {jobs.map((job) => (
          <div key={job.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <p className="min-w-0 flex-1 truncate text-sm font-bold text-white">
                {job.inputName} → {job.outputName}
              </p>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                  job.status === "done"
                    ? "bg-emerald-500/15 text-emerald-300"
                    : job.status === "failed"
                      ? "bg-rose-500/15 text-rose-300"
                      : "bg-amber-500/15 text-amber-300"
                }`}
              >
                {job.status === "running" && <Loader2 size={10} className="mr-1 inline animate-spin" aria-hidden="true" />}
                {job.status}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              {job.presetLabel} · engine <span className="font-mono text-slate-400">{job.engine}</span>
              {job.speed && job.status === "running" && ` · ${job.speed}`}
              {job.outCodec && ` · ${job.outCodec}`}
              {job.status === "done" && ` · ${fmtBytes(job.inputBytes)} → ${fmtBytes(job.outputBytes)}`}
            </p>
            {job.status === "running" && job.progress !== null && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-amber-500 transition-all" style={{ width: `${Math.round(job.progress * 100)}%` }} />
              </div>
            )}
            {job.error && <p className="mt-1 break-words text-[11px] text-rose-300">{job.error}</p>}
            <div className="mt-2 flex items-center gap-2">
              {job.status === "done" && (
                <a
                  className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
                  href={`/api/toolbox?file=1&id=${job.id}`}
                >
                  <Download size={11} className="mr-1 inline" aria-hidden="true" />
                  Download
                </a>
              )}
              {job.status !== "running" && (
                <button
                  className="rounded-lg border border-white/15 px-3 py-1 text-xs text-slate-400 hover:text-white"
                  onClick={() => void remove(job.id)}
                >
                  <Trash2 size={11} className="mr-1 inline" aria-hidden="true" />
                  Clear
                </button>
              )}
            </div>
          </div>
        ))}
        {jobs.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-500">No conversions yet — hand a file over.</p>
        )}
      </div>
    </main>
  );
}
