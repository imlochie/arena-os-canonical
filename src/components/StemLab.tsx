"use client";

import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import ProjectPicker from "./ProjectPicker";

type WorkerStatus = {
  available: boolean;
  reason?: string;
  engine?: string;
  model?: string;
  device?: string;
};

type Submission = { status: "idle" | "sending" | "accepted" | "failed"; message?: string };

const ACCEPT = ".wav,.mp3,.flac,.m4a,.aac,.ogg,audio/wav,audio/mpeg,audio/flac,audio/mp4,audio/aac,audio/ogg";

export default function StemLab() {
  const [projectId, setProjectId] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("projectId") ?? "";
  });
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [submission, setSubmission] = useState<Submission>({ status: "idle" });

  async function checkWorker() {
    setWorker(null);
    try {
      const response = await fetch("/api/stems/health", { cache: "no-store" });
      setWorker(await response.json());
    } catch {
      setWorker({ available: false, reason: "Arena could not check the configured stem worker." });
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void checkWorker(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function separate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !worker?.available || submission.status === "sending") return;
    setSubmission({ status: "sending" });
    const form = new FormData();
    form.set("file", file);
    if (projectId) form.set("projectId", projectId);
    try {
      const response = await fetch("/api/stems", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSubmission({ status: "failed", message: body.error ?? "The worker rejected the separation request." });
        return;
      }
      setSubmission({
        status: "accepted",
        message: body.message ?? (body.jobId
          ? `Worker accepted job ${body.jobId}. It will appear only when the worker returns real stem assets.`
          : "Worker accepted the request. No output is shown until actual stems are returned."),
      });
    } catch {
      setSubmission({ status: "failed", message: "Arena could not reach the configured worker." });
    }
  }

  const ready = worker?.available === true;
  return (
    <div className="mx-auto max-w-5xl">
      <section className="text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-4 py-1.5 text-xs font-bold text-fuchsia-200">🎚️ Stem Lab · local worker extension</p>
        <h1 className="text-glow mt-4 text-3xl font-black tracking-tight text-white sm:text-4xl">Pull a track apart. Keep the project intact.</h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">Stem Lab lives inside Arena&apos;s project workflow. It sends audio only to an operator-configured separation worker and never creates placeholder stems, waveforms, or progress.</p>
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_320px]">
        <form onSubmit={separate} className="glass rounded-2xl p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-white">New separation</h2>
              <p className="mt-1 text-xs text-slate-400">WAV, MP3, FLAC, M4A, AAC, or OGG. The worker, model, and device are reported by the worker itself.</p>
            </div>
            <button type="button" onClick={() => void checkWorker()} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-white/10">↻ Check worker</button>
          </div>

          <div className="mt-5 grid gap-3">
            <label className="text-xs font-bold text-slate-300">Attach this work to a project <ProjectPicker value={projectId} onChange={setProjectId} /></label>
            <label className="block rounded-xl border border-dashed border-white/20 bg-black/20 p-4 text-sm text-slate-300 hover:border-fuchsia-400/50">
              <span className="block font-bold text-white">Choose source audio</span>
              <span className="mt-1 block text-xs text-slate-500">{file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : "No file selected"}</span>
              <input className="mt-3 block w-full text-xs text-slate-400" type="file" accept={ACCEPT} onChange={(e: ChangeEvent<HTMLInputElement>) => setFile(e.target.files?.[0] ?? null)} disabled={!ready} />
            </label>
            <button type="submit" disabled={!file || !ready || submission.status === "sending"} className="btn-arena rounded-xl px-5 py-3 text-sm font-extrabold text-white">
              {submission.status === "sending" ? "Sending to worker…" : "Separate with configured worker"}
            </button>
            {submission.message && <p className={`rounded-lg px-3 py-2 text-xs ${submission.status === "failed" ? "bg-red-500/10 text-red-200" : "bg-emerald-500/10 text-emerald-200"}`}>{submission.message}</p>}
          </div>
        </form>

        <aside className="glass rounded-2xl p-5">
          <p className="text-xs font-black uppercase tracking-wider text-slate-400">Worker status</p>
          {worker === null ? <p className="mt-3 text-sm text-slate-400">Checking configured worker…</p> : ready ? <div className="mt-3 space-y-2"><p className="text-sm font-extrabold text-emerald-200">● Available</p><p className="text-xs text-slate-300">Engine: <strong className="text-white">{worker.engine}</strong></p><p className="text-xs text-slate-300">Model: <strong className="text-white">{worker.model}</strong></p><p className="text-xs text-slate-300">Device: <strong className="text-white">{worker.device}</strong></p></div> : <div className="mt-3"><p className="text-sm font-extrabold text-amber-200">● Unavailable</p><p className="mt-2 text-xs leading-relaxed text-slate-400">{worker.reason}</p><p className="mt-4 rounded-lg bg-white/[0.03] p-3 text-[11px] leading-relaxed text-slate-500">Arena is intentionally not substituting a fake local reply or filter effect. Configure a real worker, then check again.</p></div>}
        </aside>
      </div>

      <section className="mt-5 rounded-2xl border border-white/10 bg-black/20 p-5">
        <h2 className="text-sm font-extrabold text-white">Expected worker contract</h2>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">A self-hosted worker exposes <code className="rounded bg-white/10 px-1.5 py-0.5 text-fuchsia-200">GET /health</code> and <code className="rounded bg-white/10 px-1.5 py-0.5 text-fuchsia-200">POST /v1/separations</code>. It must report its actual engine/model/device and return only stems it has genuinely produced. Worker setup and durable asset persistence remain explicitly incomplete in this Arena integration.</p>
      </section>
    </div>
  );
}
