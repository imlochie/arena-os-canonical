"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useState } from "react";

type WorkerStatus = { available: boolean; reason?: string; engine?: string; model?: string; device?: string };
type StemUser = { id: string; username: string; displayName: string };
type StemProject = { id: string; name: string; emoji: string; role: string };
type Job = { id: string; status: string; stage: string; errorMessage: string | null; model: string; resolvedDevice: string | null };
type Stem = { id: string; stemType: "vocals" | "drums" | "bass" | "other"; durationSeconds: number; sampleRate: number; channels: number; checksumSha256: string };
type ProjectState = { jobs: Job[]; stems: Stem[] };

type Submission = { status: "idle" | "sending" | "accepted" | "failed"; message?: string };
const ACCEPT = ".wav,.mp3,.flac,.m4a,.aac,.ogg,audio/wav,audio/mpeg,audio/flac,audio/mp4,audio/aac,audio/ogg";

export default function StemLab() {
  const [projectId, setProjectId] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("projectId") ?? "");
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [user, setUser] = useState<StemUser | null>(null);
  const [projects, setProjects] = useState<StemProject[]>([]);
  const [projectName, setProjectName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submission, setSubmission] = useState<Submission>({ status: "idle" });
  const [projectState, setProjectState] = useState<ProjectState | null>(null);
  const [authMode, setAuthMode] = useState<"register" | "login">("register");
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const checkWorker = useCallback(async () => {
    setWorker(null);
    try { setWorker(await (await fetch("/api/stems/health", { cache: "no-store" })).json()); }
    catch { setWorker({ available: false, reason: "Arena could not check the configured stem worker." }); }
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const response = await fetch("/api/stems/auth/session", { cache: "no-store" });
      const body = await response.json();
      setUser(body.user ?? null);
      return body.user as StemUser | null;
    } catch { return null; }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const response = await fetch("/api/stems/projects", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json();
      setProjects(body.projects ?? []);
    } catch { /* Surface API errors only when the user makes an explicit request. */ }
  }, []);

  const loadProjectState = useCallback(async (id: string) => {
    if (!id) return null;
    const response = await fetch(`/api/stems/projects/${id}`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json();
    const next = { jobs: body.jobs ?? [], stems: body.stems ?? [] };
    setProjectState(next);
    return next as ProjectState;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void checkWorker(); void loadSession().then((found) => { if (found) void loadProjects(); }); }, 0);
    return () => window.clearTimeout(timer);
  }, [checkWorker, loadProjects, loadSession]);

  useEffect(() => {
    if (!user || !projectId) {
      const clearTimer = window.setTimeout(() => setProjectState(null), 0);
      return () => window.clearTimeout(clearTimer);
    }
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      const state = await loadProjectState(projectId);
      if (cancelled || !state) return;
      const active = state.jobs.some((job) => ["queued", "preparing", "processing", "validating"].includes(job.status));
      if (active) timer = window.setTimeout(() => { void refresh(); }, 2_500);
    };
    timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [loadProjectState, projectId, user]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true); setAuthMessage(null);
    const form = new FormData(event.currentTarget);
    const body = authMode === "register"
      ? { username: form.get("username"), displayName: form.get("displayName"), email: form.get("email"), password: form.get("password") }
      : { identity: form.get("identity"), password: form.get("password") };
    try {
      const response = await fetch(`/api/stems/auth/${authMode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { setAuthMessage(result.error ?? "Account action failed."); return; }
      setUser(result.user); await loadProjects();
    } catch { setAuthMessage("Arena could not complete the account request."); }
    finally { setAuthBusy(false); }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = projectName.trim();
    if (!name) return;
    const response = await fetch("/api/stems/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setSubmission({ status: "failed", message: body.error ?? "Could not create a private project." }); return; }
    const project = body.project as StemProject;
    setProjects((current) => [project, ...current]); setProjectId(project.id); setProjectName(""); setSubmission({ status: "idle" });
  }

  async function separate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !worker?.available || !projectId || submission.status === "sending") return;
    setSubmission({ status: "sending" });
    const form = new FormData(); form.set("file", file); form.set("projectId", projectId);
    try {
      const response = await fetch("/api/stems", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setSubmission({ status: "failed", message: body.error ?? "The worker rejected the separation request." }); return; }
      setSubmission({ status: "accepted", message: body.job?.id ? `Job ${body.job.id} is queued. Only real worker stages and validated outputs will appear here.` : "The configured worker accepted the request." });
      await loadProjectState(projectId);
    } catch { setSubmission({ status: "failed", message: "Arena could not reach the configured worker." }); }
  }

  const ready = worker?.available === true;
  const latestJob = projectState?.jobs[0];
  return <div className="mx-auto max-w-5xl">
    <section className="text-center">
      <p className="inline-flex items-center gap-2 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-4 py-1.5 text-xs font-bold text-fuchsia-200">🎚️ Stem Lab · Arena project module</p>
      <h1 className="text-glow mt-4 text-3xl font-black tracking-tight text-white sm:text-4xl">Pull a track apart. Keep the project intact.</h1>
      <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">Arena stores real source and stem records privately, queues work for a separately running Demucs worker, and never substitutes a filter, waveform, or invented output.</p>
    </section>

    {!user ? <section className="glass mx-auto mt-6 max-w-lg rounded-2xl p-5"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-extrabold text-white">Private Stem Lab access</h2><button type="button" onClick={() => setAuthMode(authMode === "register" ? "login" : "register")} className="text-xs font-bold text-fuchsia-200 hover:text-white">{authMode === "register" ? "I have an account" : "Create an account"}</button></div><form onSubmit={submitAuth} className="mt-4 space-y-3">{authMode === "register" && <><input name="username" required pattern="[a-z0-9_-]{3,32}" placeholder="Username" className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white" /><input name="displayName" required maxLength={80} placeholder="Display name" className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white" /><input name="email" required type="email" placeholder="Email" className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white" /></>} {authMode === "login" && <input name="identity" required placeholder="Username or email" className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white" />}<input name="password" required type="password" minLength={authMode === "register" ? 12 : 1} placeholder="Password" className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white" /><button disabled={authBusy} className="btn-arena w-full rounded-xl px-4 py-2.5 text-sm font-extrabold text-white">{authBusy ? "Working…" : authMode === "register" ? "Create private account" : "Sign in"}</button>{authMessage && <p className="text-xs text-red-200">{authMessage}</p>}</form></section> : <>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-xs"><span className="text-slate-300">Signed in as <strong className="text-white">{user.displayName}</strong>. Stem sources and assets require this private account.</span><button onClick={async () => { await fetch("/api/stems/auth/logout", { method: "POST" }); setUser(null); setProjects([]); setProjectState(null); }} className="font-bold text-slate-300 hover:text-white">Sign out</button></div>
      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_320px]"><form onSubmit={separate} className="glass rounded-2xl p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-extrabold text-white">New separation</h2><p className="mt-1 text-xs text-slate-400">The source is inspected with ffprobe before it is saved or queued.</p></div><button type="button" onClick={() => void checkWorker()} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-white/10">↻ Check worker</button></div><div className="mt-5 grid gap-3"><label className="text-xs font-bold text-slate-300">Private Arena project<select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="mt-1 block w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"><option value="">Select a private Stem Lab project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.emoji} {project.name} · {project.role}</option>)}</select></label><label className="block rounded-xl border border-dashed border-white/20 bg-black/20 p-4 text-sm text-slate-300 hover:border-fuchsia-400/50"><span className="block font-bold text-white">Choose source audio</span><span className="mt-1 block text-xs text-slate-500">{file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : "No file selected"}</span><input className="mt-3 block w-full text-xs text-slate-400" type="file" accept={ACCEPT} onChange={(e: ChangeEvent<HTMLInputElement>) => setFile(e.target.files?.[0] ?? null)} disabled={!ready || !projectId} /></label><button type="submit" disabled={!file || !ready || !projectId || submission.status === "sending"} className="btn-arena rounded-xl px-5 py-3 text-sm font-extrabold text-white">{submission.status === "sending" ? "Saving and queuing…" : "Queue real Demucs separation"}</button>{submission.message && <p className={`rounded-lg px-3 py-2 text-xs ${submission.status === "failed" ? "bg-red-500/10 text-red-200" : "bg-emerald-500/10 text-emerald-200"}`}>{submission.message}</p>}</div></form><aside className="glass rounded-2xl p-5"><p className="text-xs font-black uppercase tracking-wider text-slate-400">Worker status</p>{worker === null ? <p className="mt-3 text-sm text-slate-400">Checking durable pipeline…</p> : ready ? <div className="mt-3 space-y-2"><p className="text-sm font-extrabold text-emerald-200">● Available</p><p className="text-xs text-slate-300">Engine: <strong className="text-white">{worker.engine}</strong></p><p className="text-xs text-slate-300">Model: <strong className="text-white">{worker.model}</strong></p><p className="text-xs text-slate-300">Device: <strong className="text-white">{worker.device}</strong></p></div> : <div className="mt-3"><p className="text-sm font-extrabold text-amber-200">● Unavailable</p><p className="mt-2 text-xs leading-relaxed text-slate-400">{worker.reason}</p></div>}</aside></div>
      <form onSubmit={createProject} className="mt-4 flex flex-wrap gap-2 rounded-xl border border-white/10 bg-black/20 p-3"><input value={projectName} onChange={(e) => setProjectName(e.target.value)} maxLength={80} required placeholder="New private project name" className="min-w-56 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white" /><button className="rounded-lg bg-white/10 px-4 py-2 text-xs font-bold text-white hover:bg-white/15">Create project</button></form>
      {latestJob && <section className="mt-5 rounded-2xl border border-white/10 bg-black/20 p-5"><h2 className="text-sm font-extrabold text-white">Latest processing record</h2><p className="mt-2 text-xs text-slate-300"><strong>{latestJob.status}</strong> · {latestJob.stage} · {latestJob.model}{latestJob.resolvedDevice ? ` · ${latestJob.resolvedDevice}` : ""}</p>{latestJob.status === "failed" && <p className="mt-2 text-xs text-red-200">The worker recorded: {latestJob.errorMessage || "No safe error detail was recorded."}</p>}</section>}
      {projectState?.stems.length ? <section className="mt-5 rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-5"><h2 className="text-sm font-extrabold text-white">Validated Demucs assets</h2><div className="mt-3 grid gap-3 sm:grid-cols-2">{projectState.stems.map((stem) => <article key={stem.id} className="rounded-xl bg-black/25 p-3" data-testid={`stem-${stem.stemType}`}><p className="text-sm font-bold capitalize text-white">{stem.stemType}</p><p className="mt-1 text-[11px] text-slate-400">{stem.durationSeconds}s · {stem.sampleRate} Hz · {stem.channels} ch</p><audio className="mt-3 w-full" controls preload="metadata" src={`/api/stems/assets/${stem.id}`} /></article>)}</div></section> : null}
    </>}
    <section className="mt-5 rounded-2xl border border-white/10 bg-black/20 p-5"><h2 className="text-sm font-extrabold text-white">Integrity boundary</h2><p className="mt-2 text-xs leading-relaxed text-slate-400">Arena does not show artificial percentage progress, generated waveform data, or placeholder stems. A source is recorded only after audio inspection; stems appear only after the worker has run Demucs, validated every output, stored private objects, and committed the database records.</p></section>
  </div>;
}
