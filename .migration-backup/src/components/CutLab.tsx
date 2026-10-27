"use client";

// Cut Lab — a lightweight, OpenCut-inspired video editor that runs 100% in the
// browser. Import clips from the Studio (or upload files, or spin up procedural
// clips), trim + reorder them on a timeline, preview through a canvas
// compositor, and export a real video file via MediaRecorder — zero
// dependencies, zero egress.
//
// Heavyweight companion: OpenCut (MIT) — https://github.com/OpenCut-app/OpenCut
// See CUT.md for the full guide.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ASPECT_DIMS,
  buildTimeline,
  clampTime,
  clipLength,
  createMediaPoolSafe,
  driveMediaAt,
  fmtTime,
  newClipId,
  probeDurationSafe,
  renderFrameSafe,
  type CutAspect,
  type CutClip,
} from "@/lib/cut/client";
import { downloadBlob, exportTimeline, type ExportHandle } from "@/lib/cut/exporter";

interface StudioJobLite {
  id: string;
  modelName: string;
  status: string;
  files: { name: string; url: string; mediaType: string; kind: string }[];
  createdAt: string;
}

interface SavedProject {
  id: string;
  title: string;
  aspect: CutAspect;
  clips: CutClip[];
  updatedAt?: string;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function CutLabInner() {
  // ---- project state ----
  const [title, setTitle] = useState("Untitled cut");
  const [aspect, setAspect] = useState<CutAspect>("16:9");
  const [clips, setClips] = useState<CutClip[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // ---- sources ----
  const [studioJobs, setStudioJobs] = useState<StudioJobLite[]>([]);
  const [projects, setProjects] = useState<SavedProject[]>([]);

  // ---- playback ----
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const poolRef = useRef<ReturnType<typeof createMediaPoolSafe>>(createMediaPoolSafe());
  const timeRef = useRef(0);
  const wallRef = useRef(0); // performance.now() at play start
  const startRef = useRef(0); // timeline time at play start
  const rafRef = useRef(0);
  const playingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [uiTime, setUiTime] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ---- export ----
  const exportRef = useRef<ExportHandle | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const [exportNote, setExportNote] = useState<string | null>(null);

  // ---- misc ----
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const relinkTarget = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const clipsRef = useRef(clips);
  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  const { segments, duration } = useMemo(() => buildTimeline(clips), [clips]);
  const dims = ASPECT_DIMS[aspect];
  const selected = clips.find((c) => c.id === selectedId) ?? null;

  // ---------- rendering / playback engine ----------

  const drawAt = useCallback((t: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { segments: segs } = buildTimeline(clipsRef.current);
    const seg = segs.length ? segs.find((s) => t >= s.start && t < s.end) ?? segs[segs.length - 1] : null;
    renderFrameSafe({ ctx, pool: poolRef.current, segment: seg, time: t });
  }, []);

// keep active video element synced; pause the rest (module-level: media
// elements must be mutated, which hook callbacks can't do per the compiler)
  const driveMedia = useCallback((t: number, wantPlaying: boolean) => {
    driveMediaAt(poolRef.current, clipsRef.current, t, wantPlaying);
  }, []);

  const stopLoop = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    cancelAnimationFrame(rafRef.current);
    driveMedia(timeRef.current, false);
  }, [driveMedia]);

  const startLoop = useCallback(() => {
    if (playingRef.current) return;
    if (duration <= 0.01) return;
    playingRef.current = true;
    setPlaying(true);
    if (timeRef.current >= duration - 0.05) timeRef.current = 0;
    wallRef.current = performance.now();
    startRef.current = timeRef.current;
    let lastUi = 0;
    const tick = () => {
      if (!playingRef.current) return;
      const t = startRef.current + (performance.now() - wallRef.current) / 1000;
      if (t >= duration) {
        timeRef.current = duration;
        drawAt(duration);
        stopLoop();
        setUiTime(duration);
        return;
      }
      timeRef.current = t;
      driveMedia(t, true);
      drawAt(t);
      if (t - lastUi > 0.1) {
        lastUi = t;
        setUiTime(t);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [duration, drawAt, driveMedia, stopLoop]);

  // redraw on clip/aspect changes when paused
  useEffect(() => {
    if (!playingRef.current) drawAt(timeRef.current);
  }, [clips, aspect, drawAt]);

  // resize canvas to aspect
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = dims.w;
      canvas.height = dims.h;
      drawAt(timeRef.current);
    }
  }, [dims, drawAt]);

  const seek = useCallback(
    (t: number) => {
      const { segments: segs } = buildTimeline(clipsRef.current);
      const clamped = clampTime(segs, t);
      timeRef.current = clamped;
      setUiTime(clamped);
      driveMedia(clamped, playingRef.current);
      drawAt(clamped);
    },
    [drawAt, driveMedia]
  );

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // ---------- data loading ----------

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/cut?limit=20");
      const data = await res.json();
      if (Array.isArray(data.projects)) setProjects(data.projects);
    } catch {
      /* offline */
    }
  }, []);

  const refreshStudioJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/studio/jobs?limit=24");
      const data = await res.json();
      if (Array.isArray(data.jobs)) setStudioJobs(data.jobs.filter((j: StudioJobLite) => TERMINAL.has(j.status) && j.files?.length));
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      await refreshProjects();
      await refreshStudioJobs();
    })();
  }, [refreshProjects, refreshStudioJobs]);

  // ---------- clip operations ----------

  const addClip = useCallback((clip: CutClip, select = true) => {
    setClips((prev) => [...prev, clip]);
    if (select) setSelectedId(clip.id);
  }, []);

  const addProcedural = useCallback(() => {
    addClip({
      id: newClipId(),
      name: `demo ${Math.floor(Math.random() * 900 + 100)}`,
      kind: "procedural",
      seed: Math.floor(Math.random() * 2147483647),
      duration: 4,
      trimStart: 0,
      trimEnd: 4,
      volume: 1,
    });
  }, [addClip]);

  const addFromUrl = useCallback(
    async (url: string, name: string, mediaType: string, fallbackDur = 4) => {
      setBusy(`loading ${name}…`);
      try {
        let dur = fallbackDur;
        let kind: CutClip["kind"] = "image";
        if (mediaType.startsWith("video/")) {
          kind = "video";
          dur = (await probeDurationSafe(url)) || fallbackDur;
        }
        addClip({
          id: newClipId(),
          name,
          kind,
          src: url,
          duration: Math.max(0.5, dur),
          trimStart: 0,
          trimEnd: Math.max(0.5, dur),
          volume: 1,
        });
      } finally {
        setBusy(null);
      }
    },
    [addClip]
  );

  const onUpload = useCallback(
    (files: FileList | null) => {
      if (!files?.length) return;
      for (const f of Array.from(files).slice(0, 12)) {
        const isVideo = f.type.startsWith("video/");
        const isImage = f.type.startsWith("image/");
        if (!isVideo && !isImage) continue;
        const url = URL.createObjectURL(f);
        void addFromUrl(url, f.name, isVideo ? "video/mp4" : f.type || "image/png", isVideo ? 5 : 4);
      }
    },
    [addFromUrl]
  );

  const autoMontage = useCallback(async () => {
    setBusy("building montage…");
    try {
      const usable = studioJobs
        .flatMap((j) => j.files.map((f) => ({ ...f, modelName: j.modelName })))
        .filter((f) => f.mediaType.startsWith("video/") || f.mediaType.startsWith("image/"))
        .slice(0, 6);
      if (!usable.length) {
        setError("No Studio clips yet — generate some in the Studio first (or add demo clips).");
        return;
      }
      const built: CutClip[] = [];
      for (const f of usable) {
        const isVideo = f.mediaType.startsWith("video/");
        const dur = isVideo ? (await probeDurationSafe(f.url)) || 5 : 3;
        built.push({
          id: newClipId(),
          name: f.name,
          kind: isVideo ? "video" : "image",
          src: f.url,
          duration: Math.max(0.5, dur),
          trimStart: 0,
          trimEnd: Math.max(0.5, Math.min(dur, isVideo ? 8 : 3)),
          volume: 1,
        });
      }
      setClips(built);
      setProjectId(null);
      setTitle(`Auto montage · ${new Date().toLocaleDateString()}`);
      setSelectedId(built[0]?.id ?? null);
      seek(0);
    } finally {
      setBusy(null);
    }
  }, [studioJobs, seek]);

  const updateClip = useCallback((id: string, patch: Partial<CutClip>) => {
    setClips((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const removeClip = useCallback((id: string) => {
    setClips((prev) => prev.filter((c) => c.id !== id));
    setSelectedId((s) => (s === id ? null : s));
  }, []);

  const duplicateClip = useCallback((id: string) => {
    setClips((prev) => {
      const i = prev.findIndex((c) => c.id === id);
      if (i < 0) return prev;
      const copy = { ...prev[i], id: newClipId(), name: `${prev[i].name} copy` };
      const next = [...prev];
      next.splice(i + 1, 0, copy);
      return next;
    });
  }, []);

  const moveClip = useCallback((id: string, dir: -1 | 1) => {
    setClips((prev) => {
      const i = prev.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  // ---------- import from Studio via query params ----------

  const searchParams = useSearchParams();
  useEffect(() => {
    const importJob = searchParams.get("import");
    const importFile = searchParams.get("f");
    if (!importJob) return;
    let cancelled = false;
    (async () => {
      setBusy("importing from Studio…");
      try {
        const res = await fetch(`/api/studio/jobs/${importJob}`);
        const data = await res.json();
        const job = data.job as StudioJobLite | undefined;
        if (cancelled || !job) return;
        const file = job.files.find((f) => f.name === importFile) ?? job.files[0];
        if (!file) return;
        await addFromUrl(file.url, file.name, file.mediaType);
        if (job.modelName) setTitle(`${job.modelName} cut`);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // run once on mount for the import handoff
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- projects ----------

  const saveProject = useCallback(async () => {
    setBusy("saving…");
    setError(null);
    try {
      const res = await fetch("/api/cut", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: projectId, title, aspect, clips }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "save failed");
      setProjectId(data.project.id);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      void refreshProjects();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(null);
    }
  }, [aspect, clips, projectId, refreshProjects, title]);

  const loadProject = useCallback(
    (p: SavedProject) => {
      setProjectId(p.id);
      setTitle(p.title);
      setAspect(p.aspect);
      setClips(p.clips ?? []);
      setSelectedId(null);
      seek(0);
    },
    [seek]
  );

  const deleteProjectById = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/cut/${id}`, { method: "DELETE" });
        void refreshProjects();
      } catch {
        /* ignore */
      }
    },
    [refreshProjects]
  );

  // ---------- export ----------

  const runExport = useCallback(async () => {
    if (duration <= 0.01) {
      setError("Nothing to export — add clips first");
      return;
    }
    stopLoop();
    setExporting(true);
    setExportPct(0);
    setExportNote(null);
    setError(null);
    try {
      // preload all media before starting the clock
      const { preloadPoolSafe } = await import("@/lib/cut/client");
      await preloadPoolSafe(poolRef.current, clipsRef.current);
      const audioEls: HTMLVideoElement[] = [];
      const volumes = new Map<HTMLVideoElement, number>();
      for (const c of clipsRef.current) {
        if (c.kind === "video" && c.src && !c.unlinked && c.volume > 0) {
          const el = poolRef.current.videos.get(c.src);
          if (el) {
            audioEls.push(el);
            volumes.set(el, c.volume);
          }
        }
      }
      const handle = exportTimeline({
        canvas: canvasRef.current!,
        duration,
        fps: 30,
        audioElements: audioEls,
        volumes,
        onFrame: (t) => {
          timeRef.current = t;
          driveMedia(t, true);
          drawAt(t);
        },
        onProgress: (r) => setExportPct(r),
      });
      exportRef.current = handle;
      const { blob, mime } = await handle.promise;
      const ext = mime.includes("mp4") ? "mp4" : "webm";
      const safeTitle = (title || "cut").replace(/[^a-z0-9-_]+/gi, "_").slice(0, 40);
      const url = downloadBlob(blob, `${safeTitle}.${ext}`);
      setExportNote(`Exported ${(blob.size / 1e6).toFixed(1)} MB → download started (${ext}). File stays on your machine.`);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      // MediaElementSource nodes are single-use: rebuild the pool so preview
      // audio keeps working after export.
      poolRef.current = createMediaPoolSafe();
      drawAt(0);
      seek(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "export failed");
    } finally {
      exportRef.current = null;
      setExporting(false);
    }
  }, [drawAt, driveMedia, duration, seek, stopLoop, title]);

  // ---------- render ----------

  const studioFiles = studioJobs.flatMap((j) => j.files.map((f) => ({ ...f, modelName: j.modelName }))).slice(0, 12);

  return (
    <div className="mx-auto max-w-7xl">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-4 py-1.5 text-xs font-bold text-fuchsia-200">
            ✂️ Cut Lab · browser-native editor · inspired by OpenCut
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">
            Cut your{" "}
            <span className="bg-gradient-to-r from-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
              generations
            </span>{" "}
            together
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-300">
            Trim, reorder and export — entirely in your browser, nothing uploaded anywhere. Import Studio clips,
            upload files, or drop in procedural demo clips to try it with zero assets.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={aspect}
            onChange={(e) => setAspect(e.target.value as CutAspect)}
            className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none"
          >
            <option value="16:9">🖥️ 16:9</option>
            <option value="9:16">📱 9:16</option>
            <option value="1:1">⬛ 1:1</option>
          </select>
          <button
            onClick={saveProject}
            className="rounded-xl bg-white/5 px-4 py-2 text-sm font-bold text-slate-200 ring-1 ring-white/10 hover:bg-white/10"
          >
            {savedFlash ? "✓ Saved" : "💾 Save"}
          </button>
          <button
            onClick={runExport}
            disabled={exporting || duration <= 0.01}
            className="rounded-xl bg-gradient-to-r from-fuchsia-600 to-cyan-500 px-4 py-2 text-sm font-black text-white shadow-lg shadow-fuchsia-900/40 hover:brightness-110 disabled:opacity-40"
          >
            {exporting ? `⏺ Exporting ${Math.round(exportPct * 100)}%` : "⬇️ Export video"}
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[300px_1fr]">
        {/* ---- left: sources + projects ---- */}
        <div className="space-y-4">
          <div className="glass rounded-2xl p-4">
            <h2 className="text-sm font-extrabold text-white">🎬 Sources</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={addProcedural}
                className="rounded-xl bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 ring-1 ring-white/10 hover:bg-white/10"
              >
                ✨ Demo clip
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="rounded-xl bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 ring-1 ring-white/10 hover:bg-white/10"
              >
                📁 Upload
              </button>
              <button
                onClick={autoMontage}
                className="rounded-xl bg-violet-500/15 px-3 py-1.5 text-xs font-bold text-violet-200 ring-1 ring-violet-400/30 hover:bg-violet-500/25"
              >
                🪄 Auto-montage Studio
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,image/*"
              multiple
              hidden
              onChange={(e) => {
                if (relinkTarget.current) {
                  const f = e.target.files?.[0];
                  const id = relinkTarget.current;
                  relinkTarget.current = null;
                  if (f) {
                    updateClip(id, {
                      src: URL.createObjectURL(f),
                      unlinked: false,
                      kind: f.type.startsWith("video/") ? "video" : "image",
                    });
                  }
                } else {
                  onUpload(e.target.files);
                }
                e.target.value = "";
              }}
            />
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              Uploads live in this browser session only; saving a project keeps durable links (Studio clips) and
              marks session uploads for re-linking.
            </p>

            {studioFiles.length > 0 && (
              <>
                <p className="mt-4 text-xs font-bold uppercase tracking-wider text-slate-400">From Studio</p>
                <div className="scroll-thin mt-2 max-h-52 space-y-1.5 overflow-y-auto pr-1">
                  {studioFiles.map((f, i) => (
                    <button
                      key={`${f.url}-${i}`}
                      onClick={() => void addFromUrl(f.url, f.name, f.mediaType)}
                      className="w-full rounded-xl bg-white/[0.03] px-3 py-2 text-left ring-1 ring-white/5 hover:bg-white/[0.07]"
                    >
                      <p className="truncate text-xs font-bold text-white">
                        {f.mediaType.startsWith("video/") ? "🎬" : "🖼️"} {f.name}
                      </p>
                      <p className="truncate text-[11px] text-slate-500">{f.modelName}</p>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="glass rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-extrabold text-white">📁 Projects</h2>
              <button
                onClick={() => void refreshProjects()}
                className="rounded-lg bg-white/5 px-2 py-1 text-xs font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
              >
                ↻
              </button>
            </div>
            {projects.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">No saved projects yet.</p>
            ) : (
              <div className="scroll-thin mt-2 max-h-44 space-y-1.5 overflow-y-auto pr-1">
                {projects.map((p) => (
                  <div key={p.id} className="flex items-center gap-1.5">
                    <button
                      onClick={() => loadProject(p)}
                      className="min-w-0 flex-1 rounded-xl bg-white/[0.03] px-3 py-2 text-left ring-1 ring-white/5 hover:bg-white/[0.07]"
                    >
                      <p className="truncate text-xs font-bold text-white">{p.title}</p>
                      <p className="text-[11px] text-slate-500">
                        {p.aspect} · {p.clips?.length ?? 0} clips
                      </p>
                    </button>
                    <button
                      onClick={() => void deleteProjectById(p.id)}
                      className="rounded-lg bg-red-500/10 px-2 py-1.5 text-xs text-red-300 ring-1 ring-red-400/20 hover:bg-red-500/20"
                      title="Delete project"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ---- right: preview + timeline ---- */}
        <div className="space-y-4">
          <div className="glass rounded-2xl p-4">
            <div className="overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
              <canvas ref={canvasRef} className="block h-auto w-full" />
            </div>

            {/* transport */}
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={() => (playing ? stopLoop() : startLoop())}
                disabled={duration <= 0.01}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-fuchsia-600 to-cyan-500 text-lg text-white shadow-lg shadow-fuchsia-900/40 disabled:opacity-40"
              >
                {playing ? "⏸" : "▶"}
              </button>
              <input
                type="range"
                min={0}
                max={Math.max(duration, 0.01)}
                step={0.01}
                value={Math.min(uiTime, duration)}
                onChange={(e) => seek(Number(e.target.value))}
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-white/10 accent-fuchsia-400"
              />
              <span className="shrink-0 font-mono text-xs text-slate-300">
                {fmtTime(uiTime)} / {fmtTime(duration)}
              </span>
            </div>

            {exporting && (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-white/5">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-cyan-400 transition-all"
                    style={{ width: `${Math.max(2, exportPct * 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  Real-time capture in progress — keep this tab visible. {Math.round(exportPct * 100)}%
                  <button
                    onClick={() => exportRef.current?.cancel()}
                    className="ml-2 font-bold text-red-300 hover:underline"
                  >
                    cancel
                  </button>
                </p>
              </div>
            )}
            {(exportNote || busy || error) && (
              <div className="mt-3 space-y-1.5">
                {busy && <p className="text-xs font-bold text-cyan-300">{busy}</p>}
                {error && (
                  <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 ring-1 ring-red-400/30">
                    {error}
                  </p>
                )}
                {exportNote && (
                  <p className="rounded-xl bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-300 ring-1 ring-emerald-400/30">
                    {exportNote}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* timeline */}
          <div className="glass rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-extrabold text-white">🎞️ Timeline</h2>
              <p className="text-xs text-slate-500">
                {clips.length} clip{clips.length === 1 ? "" : "s"} · {fmtTime(duration)} total
              </p>
            </div>
            {clips.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-white/10 p-6 text-center">
                <p className="text-sm font-bold text-slate-300">Empty timeline</p>
                <p className="mt-1 text-xs text-slate-500">
                  Add a demo clip, import from Studio, or upload a file to begin.
                </p>
              </div>
            ) : (
              <>
                <div className="scroll-thin mt-3 flex gap-2 overflow-x-auto pb-2">
                  {clips.map((c, i) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setSelectedId(c.id);
                        const seg = segments.find((s) => s.clip.id === c.id);
                        if (seg) seek(seg.start + 0.01);
                      }}
                      className={`relative w-44 shrink-0 rounded-xl p-3 text-left ring-1 transition ${
                        selectedId === c.id
                          ? "bg-fuchsia-500/15 ring-fuchsia-400/40"
                          : "bg-white/[0.03] ring-white/10 hover:bg-white/[0.07]"
                      }`}
                    >
                      <p className="flex items-center gap-1.5 text-[11px] font-bold text-white">
                        <span>{c.kind === "video" ? "🎬" : c.kind === "image" ? "🖼️" : "✨"}</span>
                        <span className="truncate">{c.name}</span>
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-slate-400">
                        {clipLength(c).toFixed(1)}s · in {c.trimStart.toFixed(1)} / out {c.trimEnd.toFixed(1)}
                      </p>
                      {c.unlinked && (
                        <span className="mt-1 inline-block rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                          re-link needed
                        </span>
                      )}
                      <span className="absolute right-2 top-2 text-[10px] font-black text-slate-500">#{i + 1}</span>
                    </button>
                  ))}
                </div>

                {/* selected clip inspector */}
                {selected && (
                  <div className="mt-3 rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/10">
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="block">
                        <span className="text-[11px] font-bold text-slate-400">Name</span>
                        <input
                          value={selected.name}
                          onChange={(e) => updateClip(selected.id, { name: e.target.value })}
                          className="mt-1 w-40 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white outline-none"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] font-bold text-slate-400">In (s)</span>
                        <input
                          type="number"
                          min={0}
                          max={selected.duration}
                          step={0.1}
                          value={Number(selected.trimStart.toFixed(1))}
                          onChange={(e) =>
                            updateClip(selected.id, {
                              trimStart: Math.max(0, Math.min(selected.duration, Number(e.target.value) || 0)),
                            })
                          }
                          className="mt-1 w-20 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white outline-none"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] font-bold text-slate-400">Out (s)</span>
                        <input
                          type="number"
                          min={0.1}
                          max={selected.duration}
                          step={0.1}
                          value={Number(selected.trimEnd.toFixed(1))}
                          onChange={(e) =>
                            updateClip(selected.id, {
                              trimEnd: Math.max(0.1, Math.min(selected.duration, Number(e.target.value) || 0.1)),
                            })
                          }
                          className="mt-1 w-20 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white outline-none"
                        />
                      </label>
                      {selected.kind === "video" && (
                        <label className="block">
                          <span className="text-[11px] font-bold text-slate-400">Volume</span>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={selected.volume}
                            onChange={(e) => updateClip(selected.id, { volume: Number(e.target.value) })}
                            className="mt-2 block w-24 accent-cyan-400"
                          />
                        </label>
                      )}
                      <div className="ml-auto flex gap-1.5">
                        <button
                          onClick={() => moveClip(selected.id, -1)}
                          className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs ring-1 ring-white/10 hover:bg-white/10"
                          title="Move left"
                        >
                          ◀
                        </button>
                        <button
                          onClick={() => moveClip(selected.id, 1)}
                          className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs ring-1 ring-white/10 hover:bg-white/10"
                          title="Move right"
                        >
                          ▶
                        </button>
                        <button
                          onClick={() => duplicateClip(selected.id)}
                          className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs ring-1 ring-white/10 hover:bg-white/10"
                          title="Duplicate"
                        >
                          ⧉
                        </button>
                        {selected.unlinked && (
                          <button
                            onClick={() => {
                              relinkTarget.current = selected.id;
                              fileInputRef.current?.click();
                            }}
                            className="rounded-lg bg-amber-400/15 px-2.5 py-1.5 text-xs font-bold text-amber-300 ring-1 ring-amber-400/30 hover:bg-amber-400/25"
                          >
                            🔗 Re-link
                          </button>
                        )}
                        <button
                          onClick={() => removeClip(selected.id)}
                          className="rounded-lg bg-red-500/15 px-2.5 py-1.5 text-xs text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/25"
                          title="Delete clip"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <p className="pb-2 text-center text-[11px] leading-relaxed text-slate-500">
            Cut Lab is a lightweight, dependency-free editor inspired by{" "}
            <a
              href="https://github.com/OpenCut-app/OpenCut"
              target="_blank"
              rel="noreferrer"
              className="font-bold text-slate-400 hover:text-fuchsia-300"
            >
              OpenCut
            </a>{" "}
            (MIT) — for full timelines, effects and keyframes run OpenCut itself; everything here stays local:
            canvas + Web Audio + MediaRecorder, files never leave your machine.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function CutLab() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl">
          <div className="glass rounded-2xl p-10 text-center">
            <p className="text-sm font-bold text-slate-300">Loading Cut Lab…</p>
          </div>
        </div>
      }
    >
      <CutLabInner />
    </Suspense>
  );
}
