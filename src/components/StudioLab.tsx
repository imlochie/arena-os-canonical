"use client";

// Studio — multimodal generation lab (video · image · audio).
//
// Backends, in order of preference:
//   🟢 WanGP (Wan2GP) by DeepBeepMeep — via the local bridge (bridges/wangp_bridge.py)
//   🟢 ComfyUI — any ComfyUI server (Wan 2.1/2.2, LTX-Video, custom workflows)
//   🟡 Hosted Wan / Qwen-Image (BYOK DashScope key — never stored server-side)
//   ⚪ Demo — procedural previews, always available, fully local
//
// WanGP attribution (per WanGP's terms): the WanGP backend is powered by
// WanGP by DeepBeepMeep — https://github.com/deepbeepmeep/Wan2GP

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---- types (mirrored from src/lib/studio/types.ts) ----

type Modality = "video" | "image" | "audio";
type Backend = "wangp" | "comfyui" | "dashscope" | "demo";

interface JobFile {
  name: string;
  url: string;
  mediaType: string;
  kind: Modality;
}

interface Job {
  id: string;
  backend: Backend;
  modelType: string;
  modelName: string;
  modality: Modality;
  prompt: string;
  negativePrompt: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  progress: number;
  files: JobFile[];
  preview: string | null;
  error: string | null;
  seed: number | null;
  createdAt: string;
}

interface ModelInfo {
  modelType: string;
  name: string;
  modality: Modality;
  familyLabel?: string;
  description?: string;
  minVram?: number;
  available?: boolean;
  source: Backend;
  experimental?: boolean;
}

interface BackendStatus {
  backend: Backend;
  online: boolean;
  detail?: string;
  version?: string;
}

interface StudioSettings {
  wangpUrl: string;
  comfyUrl: string;
  dashscopeKey: string;
  dashscopeRegion: string;
}

// ---- constants ----

const LS_KEYS: { [k in keyof StudioSettings]: string } = {
  wangpUrl: "af_studio_wangp_url",
  comfyUrl: "af_studio_comfy_url",
  dashscopeKey: "af_studio_dashscope_key",
  dashscopeRegion: "af_studio_dashscope_region",
};

const DEFAULT_SETTINGS: StudioSettings = {
  wangpUrl: "",
  comfyUrl: "",
  dashscopeKey: "",
  dashscopeRegion: "intl",
};

const RESOLUTIONS: Record<Modality, { w: number; h: number; label: string }[]> = {
  video: [
    { w: 832, h: 480, label: "🖥️ 832×480 · 16:9" },
    { w: 480, h: 832, label: "📱 480×832 · 9:16" },
    { w: 640, h: 640, label: "⬛ 640×640 · 1:1" },
    { w: 1280, h: 720, label: "🎞️ 1280×720 · HD" },
  ],
  image: [
    { w: 1024, h: 1024, label: "⬛ Square 1024" },
    { w: 832, h: 1216, label: "📱 Portrait" },
    { w: 1216, h: 832, label: "🖥️ Landscape" },
    { w: 1536, h: 640, label: "🎬 Cinematic" },
  ],
  audio: [{ w: 0, h: 0, label: "🔊 audio" }],
};

const STARTERS: Record<Modality, string[]> = {
  video: [
    "A cinematic dolly shot through a neon-lit Tokyo alley in the rain, reflections on wet asphalt, slow motion",
    "A golden retriever puppy discovers snow for the first time, close-up, warm morning light, shallow depth of field",
    "Timelapse of storm clouds rolling over desert mesas, dramatic light rays, epic scale",
  ],
  image: [
    "Portrait of an elderly lighthouse keeper, weathered face, warm rim light, photorealistic",
    "Isometric cutaway of a cozy witch's bookshop, tiny glowing lamps, watercolor style",
    "Retro-futuristic travel poster of Europa, ice geysers, bold typography",
  ],
  audio: [
    "Lo-fi chill hip hop beat, warm vinyl crackle, mellow piano, rainy evening mood",
    "Epic orchestral trailer cue, building percussion, heroic brass, 30 seconds",
    "Ambient forest soundscape with soft synth pads and distant birdsong",
  ],
};

const BACKEND_META: Record<Backend, { label: string; emoji: string; color: string }> = {
  wangp: { label: "WanGP", emoji: "🚀", color: "emerald" },
  comfyui: { label: "ComfyUI", emoji: "🧩", color: "violet" },
  dashscope: { label: "Cloud", emoji: "☁️", color: "amber" },
  demo: { label: "Demo", emoji: "🧪", color: "slate" },
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

// ---- helpers ----

function loadSettings(): StudioSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    return {
      wangpUrl: localStorage.getItem(LS_KEYS.wangpUrl) || "",
      comfyUrl: localStorage.getItem(LS_KEYS.comfyUrl) || "",
      dashscopeKey: localStorage.getItem(LS_KEYS.dashscopeKey) || "",
      dashscopeRegion: localStorage.getItem(LS_KEYS.dashscopeRegion) || "intl",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function backendHeaders(s: StudioSettings): Record<string, string> {
  const h: Record<string, string> = {};
  if (s.wangpUrl.trim()) h["x-studio-wangp-url"] = s.wangpUrl.trim();
  if (s.comfyUrl.trim()) h["x-studio-comfy-url"] = s.comfyUrl.trim();
  if (s.dashscopeKey.trim()) h["x-studio-dashscope-key"] = s.dashscopeKey.trim();
  if (s.dashscopeRegion.trim()) h["x-studio-dashscope-region"] = s.dashscopeRegion.trim();
  return h;
}

function query(s: StudioSettings): string {
  const p = new URLSearchParams();
  if (s.wangpUrl.trim()) p.set("wangpUrl", s.wangpUrl.trim());
  if (s.comfyUrl.trim()) p.set("comfyUrl", s.comfyUrl.trim());
  return p.toString();
}

function MediaView({ file }: { file: JobFile }) {
  if (file.mediaType.startsWith("audio/") || /\.(wav|mp3|flac|ogg)$/i.test(file.url)) {
    return <audio controls src={file.url} className="w-full" />;
  }
  if (file.mediaType.startsWith("video/") || /\.(mp4|webm|mkv)$/i.test(file.url)) {
    return <video controls playsInline src={file.url} className="w-full rounded-xl bg-black" />;
  }
  // svg previews (demo mode) and images
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={file.url} alt={file.name} className="w-full rounded-xl bg-black/40" />
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ---- component ----

export default function StudioLab() {
  const [settings, setSettings] = useState<StudioSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState<BackendStatus[]>([]);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [models, setModels] = useState<{ wangp: ModelInfo[]; demo: ModelInfo[]; comfyui: ModelInfo[]; dashscope: ModelInfo[] }>({
    wangp: [],
    demo: [],
    comfyui: [],
    dashscope: [],
  });
  const [wangpOnline, setWangpOnline] = useState(false);

  const [modality, setModality] = useState<Modality>("video");
  const [backend, setBackend] = useState<Backend>("demo");
  const [modelType, setModelType] = useState("");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [resolutionIdx, setResolutionIdx] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [steps, setSteps] = useState(20);
  const [guidance, setGuidance] = useState(3.5);
  const [randomSeed, setRandomSeed] = useState(true);
  const [seed, setSeed] = useState(42);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedJson, setAdvancedJson] = useState("");
  const [comfyWorkflow, setComfyWorkflow] = useState("");

  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // ---- load settings + data on mount ----
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  const refreshHealth = useCallback(async () => {
    const s = settingsRef.current;
    try {
      const res = await fetch(`/api/studio/health?${query(s)}`);
      const data = await res.json();
      setStatus(data.backends || []);
      const wangpOn = data.backends?.some((b: BackendStatus) => b.backend === "wangp" && b.online);
      setWangpOnline(!!wangpOn);
      setStatusLoaded(true);
    } catch {
      setStatusLoaded(true);
    }
  }, []);

  const refreshModels = useCallback(async () => {
    const s = settingsRef.current;
    try {
      const res = await fetch(`/api/studio/models?modality=${modality}&${query(s)}`);
      const data = await res.json();
      setModels(data.models || { wangp: [], demo: [], comfyui: [], dashscope: [] });
      setWangpOnline(!!data.wangpOnline);
    } catch {
      /* keep old */
    }
  }, [modality]);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/studio/jobs?limit=24");
      const data = await res.json();
      if (Array.isArray(data.jobs)) setJobs(data.jobs);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);
  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  // pick a sensible default backend + model whenever the catalog changes
  // ---- derived backend + model selection (no cascading effects) ----
  const comfyOnline = useMemo(() => status.some((b) => b.backend === "comfyui" && b.online), [status]);
  const effectiveBackend: Backend = useMemo(() => {
    if (backend === "wangp" && !wangpOnline) return wangpOnline ? "wangp" : comfyOnline ? "comfyui" : "demo";
    if (backend === "comfyui" && !comfyOnline) return wangpOnline ? "wangp" : "demo";
    if (backend === "dashscope" && models.dashscope.length === 0) return wangpOnline ? "wangp" : "demo";
    return backend;
  }, [backend, wangpOnline, comfyOnline, models.dashscope.length]);

  const backendModels: ModelInfo[] = useMemo(() => {
    if (effectiveBackend === "wangp") return wangpOnline ? models.wangp : models.demo;
    if (effectiveBackend === "comfyui") return models.comfyui;
    if (effectiveBackend === "dashscope") return models.dashscope;
    return models.demo;
  }, [effectiveBackend, models, wangpOnline]);

  const effectiveModelType = useMemo(() => {
    if (backendModels.some((m) => m.modelType === modelType)) return modelType;
    return backendModels[0]?.modelType ?? "";
  }, [backendModels, modelType]);

  // ---- polling active jobs ----
  useEffect(() => {
    const tick = async () => {
      const s = settingsRef.current;
      const active = jobs.filter((j) => !TERMINAL.has(j.status));
      if (!active.length) return;
      const updated = await Promise.all(
        active.map(async (j) => {
          try {
            const res = await fetch(`/api/studio/jobs/${j.id}`, { headers: backendHeaders(s) });
            const data = await res.json();
            return data.job as Job | undefined;
          } catch {
            return undefined;
          }
        })
      );
      const byId = new Map(updated.filter(Boolean).map((j) => [(j as Job).id, j]));
      setJobs((prev) => prev.map((j) => byId.get(j.id) ?? j));
    };
    const iv = setInterval(tick, 2000);
    return () => clearInterval(iv);
  }, [jobs]);

  // ---- generate ----
  const generate = async () => {
    if (!prompt.trim()) {
      setError("Write a prompt first ✍️");
      return;
    }
    if (!effectiveModelType) {
      setError("Pick a model first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let settingsExtra: Record<string, unknown> = {};
      if (advancedJson.trim()) {
        try {
          settingsExtra = JSON.parse(advancedJson);
        } catch {
          throw new Error("Advanced settings JSON is invalid");
        }
      }
      const res = RESOLUTIONS[modality][resolutionIdx];
      const body: Record<string, unknown> = {
        backend: effectiveBackend,
        modality,
        modelType: effectiveModelType,
        prompt,
        negativePrompt,
        seed: randomSeed ? Math.floor(Math.random() * 2147483647) : seed,
        steps,
        guidance,
        settings: settingsExtra,
        backends: {
          wangpUrl: settings.wangpUrl.trim() || undefined,
          comfyUrl: settings.comfyUrl.trim() || undefined,
          dashscopeKey: settings.dashscopeKey.trim() || undefined,
          dashscopeRegion: settings.dashscopeRegion.trim() || undefined,
        },
      };
      if (modality === "video") {
        body.durationSeconds = durationSeconds;
        if (res.w) {
          body.width = res.w;
          body.height = res.h;
        }
      } else if (modality === "image") {
        if (res.w) {
          body.width = res.w;
          body.height = res.h;
        }
      } else {
        body.durationSeconds = durationSeconds;
      }
      if (effectiveBackend === "comfyui" && comfyWorkflow.trim()) body.workflowJson = comfyWorkflow.trim();

      const res2 = await fetch("/api/studio/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res2.json();
      if (!res2.ok) throw new Error(data?.error || "generation failed");
      setJobs((prev) => [data.job as Job, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "generation failed");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await fetch(`/api/studio/jobs/${id}/cancel`, { method: "POST", headers: backendHeaders(settingsRef.current) });
      void refreshJobs();
    } catch {
      /* ignore */
    }
  };

  const saveArtifact = async (job: Job) => {
    const media = job.files
      .map((f) => (f.kind === "audio" ? `🔊 [${f.name}](${f.url})` : `![${f.name}](${f.url})`))
      .join("\n\n");
    const body = [
      `**Prompt:** ${job.prompt}`,
      job.negativePrompt ? `**Negative:** ${job.negativePrompt}` : "",
      `**Model:** ${job.modelName} (\`${job.modelType}\`) · ${BACKEND_META[job.backend].label}`,
      job.seed !== null ? `**Seed:** ${job.seed}` : "",
      "",
      media,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const res = await fetch("/api/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `🎬 ${job.prompt.slice(0, 60)}`,
          body,
          kind: job.modality === "video" ? "concept" : job.modality === "image" ? "concept" : "brief",
          sourceType: "studio",
          sourceId: job.id,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      setSavedIds((prev) => new Set(prev).add(job.id));
    } catch {
      setError("Could not save artifact (is the database running?)");
    }
  };

  const saveSettings = (next: StudioSettings) => {
    setSettings(next);
    try {
      for (const k of Object.keys(LS_KEYS) as (keyof StudioSettings)[]) {
        if (next[k].trim()) localStorage.setItem(LS_KEYS[k], next[k].trim());
        else localStorage.removeItem(LS_KEYS[k]);
      }
    } catch {
      /* ignore */
    }
    void refreshHealth();
    void refreshModels();
  };

  // ---- render ----
  const grouped = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>();
    for (const m of backendModels) {
      const key = m.familyLabel || m.source;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    return [...groups.entries()];
  }, [backendModels]);

  const active = jobs.filter((j) => !TERMINAL.has(j.status));
  const done = jobs.filter((j) => TERMINAL.has(j.status));
  const selectedModel = backendModels.find((m) => m.modelType === effectiveModelType);

  return (
    <div className="mx-auto max-w-7xl">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-violet-400/30 bg-violet-400/10 px-4 py-1.5 text-xs font-bold text-violet-200">
            🎬 Studio · video · image · audio
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">
            Generate anything,{" "}
            <span className="bg-gradient-to-r from-violet-300 to-cyan-300 bg-clip-text text-transparent">
              GPU-poor friendly
            </span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-300">
            Drive <strong>WanGP</strong> (Wan 2.1/2.2 · LTX-2 · HunyuanVideo · Qwen Image · Flux · TTS) on your own
            GPU through the local bridge, any <strong>ComfyUI</strong> server, or an optional BYOK cloud fallback.
            No backend? Demo mode keeps everything working locally.
          </p>
        </div>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="rounded-xl bg-white/5 px-4 py-2 text-sm font-bold text-slate-200 ring-1 ring-white/10 transition hover:bg-white/10"
        >
          ⚙️ Backends {showSettings ? "▲" : "▼"}
        </button>
      </div>

      {/* backend status chips */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {(statusLoaded ? status : []).map((b) => (
          <span
            key={b.backend}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ring-1 ${
              b.online
                ? "bg-emerald-400/10 text-emerald-200 ring-emerald-400/30"
                : "bg-white/5 text-slate-400 ring-white/10"
            }`}
            title={b.detail}
          >
            <span className={`h-2 w-2 rounded-full ${b.online ? "bg-emerald-400" : "bg-slate-500"}`} />
            {BACKEND_META[b.backend].emoji} {BACKEND_META[b.backend].label}
            {b.version ? ` · ${String(b.version).slice(0, 14)}` : ""}
          </span>
        ))}
        {!statusLoaded && <span className="text-xs text-slate-500">probing backends…</span>}
      </div>

      {/* settings panel */}
      {showSettings && (
        <div className="glass mt-4 rounded-2xl p-5">
          <h2 className="text-sm font-extrabold text-white">Backend connections</h2>
          <p className="mt-1 text-xs text-slate-400">
            Stored in your browser only (localStorage) — the server never persists them. Run the WanGP bridge with{" "}
            <code className="rounded bg-black/50 px-1.5 py-0.5 text-cyan-200">
              python bridges/wangp_bridge.py --root /path/to/WanGP
            </code>{" "}
            on the machine with your GPU. See <code className="rounded bg-black/50 px-1.5 py-0.5 text-cyan-200">STUDIO.md</code>.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-bold text-slate-300">WanGP bridge URL</span>
              <input
                value={settings.wangpUrl}
                onChange={(e) => setSettings({ ...settings, wangpUrl: e.target.value })}
                placeholder="http://127.0.0.1:7862"
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-violet-400/60"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-300">ComfyUI URL</span>
              <input
                value={settings.comfyUrl}
                onChange={(e) => setSettings({ ...settings, comfyUrl: e.target.value })}
                placeholder="http://127.0.0.1:8188"
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-violet-400/60"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-300">DashScope API key (BYOK, optional cloud)</span>
              <input
                type="password"
                value={settings.dashscopeKey}
                onChange={(e) => setSettings({ ...settings, dashscopeKey: e.target.value })}
                placeholder="sk-…"
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-violet-400/60"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-300">DashScope region</span>
              <select
                value={settings.dashscopeRegion}
                onChange={(e) => setSettings({ ...settings, dashscopeRegion: e.target.value })}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-violet-400/60"
              >
                <option value="intl">International (dashscope-intl)</option>
                <option value="cn">Mainland China (dashscope)</option>
              </select>
            </label>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => saveSettings(settings)}
              className="rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-violet-900/40 transition hover:brightness-110"
            >
              Save & probe
            </button>
            <button
              onClick={() => {
                const cleared = { ...DEFAULT_SETTINGS };
                saveSettings(cleared);
              }}
              className="rounded-xl bg-white/5 px-4 py-2 text-sm font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {/* main grid */}
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(360px,420px)_1fr]">
        {/* ---- left: composer ---- */}
        <div className="glass rounded-2xl p-5">
          {/* modality tabs */}
          <div className="grid grid-cols-3 gap-2">
            {(["video", "image", "audio"] as Modality[]).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setModality(m);
                  setResolutionIdx(0);
                  setModelType("");
                }}
                className={`rounded-xl px-3 py-2 text-sm font-bold transition ${
                  modality === m
                    ? "bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-900/40"
                    : "bg-white/5 text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
                }`}
              >
                {m === "video" ? "🎬 Video" : m === "image" ? "🖼️ Image" : "🔊 Audio"}
              </button>
            ))}
          </div>

          {/* backend selector */}
          <div className="mt-4">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Backend</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(Object.keys(BACKEND_META) as Backend[]).map((b) => {
                const online = b === "demo" ? true : status.some((s) => s.backend === b && s.online);
                const hasModels = backendModelsOf(b, models, b === "wangp" && !wangpOnline).some(
                  (m) => m.modality === modality
                );
                const disabled = !online || !hasModels;
                return (
                  <button
                    key={b}
                    disabled={disabled}
                    onClick={() => setBackend(b)}
                    title={
                      b === "wangp" && !wangpOnline && models.demo.length
                        ? "Bridge offline — using demo catalog"
                        : BACKEND_META[b].label
                    }
                    className={`rounded-xl px-3 py-1.5 text-xs font-bold ring-1 transition ${
                      effectiveBackend === b
                        ? "bg-violet-600/25 text-white ring-violet-500/50"
                        : disabled
                          ? "cursor-not-allowed bg-white/[0.02] text-slate-600 ring-white/5"
                          : "bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10"
                    }`}
                  >
                    {BACKEND_META[b].emoji} {BACKEND_META[b].label}
                    {!online && b !== "demo" && <span className="ml-1 text-slate-500">· offline</span>}
                    {b === "wangp" && !wangpOnline && <span className="ml-1 text-slate-500">· demo catalog</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* model picker */}
          <label className="mt-4 block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Model</span>
            <select
              value={effectiveModelType}
              onChange={(e) => setModelType(e.target.value)}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white outline-none focus:border-violet-400/60"
            >
              {grouped.map(([family, list]) => (
                <optgroup key={family} label={family}>
                  {list.map((m) => (
                    <option key={m.modelType} value={m.modelType}>
                      {m.name}
                      {m.available === false ? " (files missing)" : ""}
                      {m.experimental ? " · experimental" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
              {!backendModels.length && <option value="">— no models for this backend/modality —</option>}
            </select>
          </label>
          {selectedModel?.description && (
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              {selectedModel.description}
              {selectedModel.minVram ? ` · ~${selectedModel.minVram}GB VRAM class` : ""}
            </p>
          )}

          {/* prompt */}
          <label className="mt-4 block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Prompt</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder={
                modality === "audio"
                  ? "Describe the sound, mood, instruments…"
                  : "Describe the shot: subject, action, camera, lighting, style…"
              }
              className="scroll-thin mt-2 w-full resize-y rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white outline-none focus:border-violet-400/60"
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {STARTERS[modality].map((s) => (
              <button
                key={s}
                onClick={() => setPrompt(s)}
                className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10"
              >
                {s.slice(0, 34)}…
              </button>
            ))}
          </div>

          {modality !== "audio" && (
            <label className="mt-3 block">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Negative prompt</span>
              <input
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder="blurry, low quality, distorted…"
                className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-violet-400/60"
              />
            </label>
          )}

          {/* controls */}
          {modality !== "audio" && (
            <div className="mt-4">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Resolution</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {RESOLUTIONS[modality].map((r, i) => (
                  <button
                    key={r.label}
                    onClick={() => setResolutionIdx(i)}
                    className={`rounded-xl px-3 py-1.5 text-xs font-bold ring-1 transition ${
                      resolutionIdx === i
                        ? "bg-cyan-400/15 text-cyan-100 ring-cyan-400/40"
                        : "bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10"
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-bold text-slate-300">
                {modality === "audio" ? "Duration (s)" : "Length (s)"}
              </span>
              <input
                type="number"
                min={1}
                max={30}
                value={durationSeconds}
                onChange={(e) => setDurationSeconds(Number(e.target.value) || 5)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-violet-400/60"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-300">Steps</span>
              <input
                type="number"
                min={1}
                max={60}
                value={steps}
                onChange={(e) => setSteps(Number(e.target.value) || 20)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-violet-400/60"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-300">Guidance (CFG)</span>
              <input
                type="number"
                step="0.1"
                min={0}
                max={20}
                value={guidance}
                onChange={(e) => setGuidance(Number(e.target.value) || 3.5)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-violet-400/60"
              />
            </label>
            <div className="flex items-end gap-2">
              <label className="flex-1">
                <span className="text-xs font-bold text-slate-300">Seed</span>
                <input
                  type="number"
                  min={0}
                  disabled={randomSeed}
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-violet-400/60 disabled:opacity-40"
                />
              </label>
              <button
                onClick={() => setSeed(Math.floor(Math.random() * 2147483647))}
                disabled={randomSeed}
                title="Randomize seed"
                className="mb-0.5 rounded-xl bg-white/5 px-2.5 py-2 text-sm ring-1 ring-white/10 disabled:opacity-40"
              >
                🎲
              </button>
            </div>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={randomSeed} onChange={(e) => setRandomSeed(e.target.checked)} />
            random seed each run
          </label>

          {/* comfyui workflow */}
          {effectiveBackend === "comfyui" && (
            <div className="mt-4 rounded-xl bg-violet-500/5 p-3 ring-1 ring-violet-400/20">
              <p className="text-xs font-bold text-violet-200">
                🧩 Custom workflow (optional — API format JSON)
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                Leave empty to use the built-in template above. Or export any ComfyUI workflow (File → Export
                Workflow (API)) and paste it here — use <code className="text-cyan-200">{"{{PROMPT}}"}</code>,{" "}
                <code className="text-cyan-200">{"{{NEGATIVE}}"}</code>, <code className="text-cyan-200">{"{{SEED}}"}</code>,{" "}
                <code className="text-cyan-200">{"{{WIDTH}}"}</code>, <code className="text-cyan-200">{"{{HEIGHT}}"}</code>,{" "}
                <code className="text-cyan-200">{"{{LENGTH}}"}</code>, <code className="text-cyan-200">{"{{STEPS}}"}</code>,{" "}
                <code className="text-cyan-200">{"{{CFG}}"}</code>, <code className="text-cyan-200">{"{{FPS}}"}</code> tokens.
              </p>
              <textarea
                value={comfyWorkflow}
                onChange={(e) => setComfyWorkflow(e.target.value)}
                rows={4}
                placeholder='{"6": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{PROMPT}}", ...}}, ...}'
                className="scroll-thin mt-2 w-full resize-y rounded-xl border border-white/10 bg-black/50 px-3 py-2 font-mono text-[11px] text-cyan-100 outline-none focus:border-violet-400/60"
              />
            </div>
          )}

          {/* advanced settings */}
          <div className="mt-4">
            <button
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="text-xs font-bold text-slate-400 hover:text-slate-200"
            >
              ⚙️ Advanced {advancedOpen ? "▲" : "▼"}
            </button>
            {advancedOpen && (
              <div className="mt-2">
                <p className="text-[11px] leading-relaxed text-slate-400">
                  Raw settings JSON merged into the request — WanGP keys (<code className="text-cyan-200">resolution</code>,{" "}
                  <code className="text-cyan-200">video_length</code>, <code className="text-cyan-200">seed</code>, …) or
                  ComfyUI workflow extras. Pro tip: in the WanGP web UI use <em>Export Settings</em> and paste the JSON
                  here.
                </p>
                <textarea
                  value={advancedJson}
                  onChange={(e) => setAdvancedJson(e.target.value)}
                  rows={4}
                  placeholder='{"video_length": "8s", "lora_accelerator_profile": "lightning"}'
                  className="scroll-thin mt-2 w-full resize-y rounded-xl border border-white/10 bg-black/50 px-3 py-2 font-mono text-[11px] text-cyan-100 outline-none focus:border-violet-400/60"
                />
              </div>
            )}
          </div>

          <button
            onClick={generate}
            disabled={busy || !effectiveModelType}
            className="mt-5 w-full rounded-2xl bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-500 px-4 py-3.5 text-base font-black text-white shadow-xl shadow-violet-900/40 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Submitting…" : `✨ Generate ${modality}`}
          </button>
          {error && (
            <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 ring-1 ring-red-400/30">
              {error}
            </p>
          )}
        </div>

        {/* ---- right: jobs ---- */}
        <div className="space-y-4">
          {/* active */}
          {active.length > 0 && (
            <div className="space-y-3">
              {active.map((j) => (
                <JobCard key={j.id} job={j} onCancel={cancel} onSave={saveArtifact} saved={savedIds.has(j.id)} />
              ))}
            </div>
          )}

          {/* history */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-extrabold text-white">
              📚 Gallery {done.length ? <span className="text-slate-500">· {done.length}</span> : null}
            </h2>
            <button
              onClick={() => void refreshJobs()}
              className="rounded-lg bg-white/5 px-2.5 py-1 text-xs font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
            >
              ↻ Refresh
            </button>
          </div>
          {jobs.length === 0 && (
            <div className="glass rounded-2xl p-8 text-center">
              <p className="text-3xl">🎬</p>
              <p className="mt-2 text-sm font-bold text-white">Nothing generated yet</p>
              <p className="mt-1 text-xs text-slate-400">
                Pick a model, write a prompt, hit Generate. Jobs appear here with live progress.
              </p>
            </div>
          )}
          <div className="grid gap-3 xl:grid-cols-2">
            {done.map((j) => (
              <JobCard key={j.id} job={j} onCancel={cancel} onSave={saveArtifact} saved={savedIds.has(j.id)} />
            ))}
          </div>

          <p className="pt-2 text-center text-[11px] leading-relaxed text-slate-500">
            Generation via the WanGP backend is powered by{" "}
            <a
              href="https://github.com/deepbeepmeep/Wan2GP"
              target="_blank"
              rel="noreferrer"
              className="font-bold text-slate-400 hover:text-cyan-300"
            >
              WanGP (Wan2GP) by DeepBeepMeep
            </a>{" "}
            · ComfyUI workflows via your own server · cloud path is optional BYOK · demo mode is 100% local.
          </p>
        </div>
      </div>
    </div>
  );
}

function backendModelsOf(
  b: Backend,
  models: { wangp: ModelInfo[]; demo: ModelInfo[]; comfyui: ModelInfo[]; dashscope: ModelInfo[] },
  wangpOffline: boolean
): ModelInfo[] {
  if (b === "wangp") return wangpOffline ? models.demo : models.wangp;
  if (b === "comfyui") return models.comfyui;
  if (b === "dashscope") return models.dashscope;
  return models.demo;
}

function JobCard({
  job,
  onCancel,
  onSave,
  saved,
}: {
  job: Job;
  onCancel: (id: string) => void;
  onSave: (job: Job) => void;
  saved: boolean;
}) {
  const meta = BACKEND_META[job.backend];
  const isDone = job.status === "completed";
  const pct = Math.round((job.progress || 0) * 100);
  return (
    <div className="glass rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-extrabold text-white">{job.modelName}</p>
          <p className="mt-0.5 truncate text-xs text-slate-400">{job.prompt}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
            <span className="rounded-full bg-white/5 px-2 py-0.5 font-bold text-slate-300 ring-1 ring-white/10">
              {meta.emoji} {meta.label}
            </span>
            <span>{job.modality}</span>
            {job.seed !== null && job.seed !== undefined && <span>· seed {job.seed}</span>}
            <span>· {timeAgo(job.createdAt)}</span>
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {isDone && (
            <>
              <a
                href={job.files[0]?.url}
                download={job.files[0]?.name}
                title="Download"
                className="rounded-lg bg-white/5 px-2 py-1 text-xs ring-1 ring-white/10 hover:bg-white/10"
              >
                ⬇️
              </a>
              {(job.modality === "video" || job.modality === "image") && job.files[0] && (
                <a
                  href={`/cut?import=${job.id}&f=${encodeURIComponent(job.files[0].name)}`}
                  title="Edit in Cut Lab"
                  className="rounded-lg bg-fuchsia-500/15 px-2 py-1 text-xs text-fuchsia-200 ring-1 ring-fuchsia-400/30 hover:bg-fuchsia-500/25"
                >
                  ✂️
                </a>
              )}
              <button
                onClick={() => onSave(job)}
                disabled={saved}
                title={saved ? "Saved to artifacts" : "Save as artifact"}
                className={`rounded-lg px-2 py-1 text-xs ring-1 ${
                  saved
                    ? "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30"
                    : "bg-white/5 ring-white/10 hover:bg-white/10"
                }`}
              >
                {saved ? "✓" : "📦"}
              </button>
            </>
          )}
          {!TERMINAL.has(job.status) && (
            <button
              onClick={() => onCancel(job.id)}
              className="rounded-lg bg-red-500/15 px-2.5 py-1 text-xs font-bold text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/25"
            >
              ✕ Stop
            </button>
          )}
        </div>
      </div>

      {/* progress */}
      {!TERMINAL.has(job.status) && (
        <div className="mt-3">
          <div className="h-2 overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all duration-500"
              style={{ width: `${Math.max(3, pct)}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] font-medium text-slate-400">
            {job.phase || job.status}
            {pct > 0 ? ` · ${pct}%` : ""}
          </p>
        </div>
      )}

      {job.status === "failed" && job.error && (
        <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-300 ring-1 ring-red-400/30">
          {job.error}
        </p>
      )}
      {job.status === "cancelled" && (
        <p className="mt-3 text-xs font-bold text-slate-500">cancelled</p>
      )}

      {/* preview (live) */}
      {job.preview && !isDone && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={job.preview} alt="preview" className="mt-3 w-full rounded-xl opacity-80" />
      )}

      {/* results */}
      {isDone && job.files.length > 0 && (
        <div className="mt-3 space-y-2">
          {job.files.map((f) => (
            <div key={f.name}>
              <MediaView file={f} />
              {f.mediaType === "image/svg+xml" && job.backend === "demo" && (
                <p className="mt-1 text-[11px] text-amber-300/80">
                  🧪 demo mode · procedural preview — connect the WanGP bridge (or ComfyUI) for real generation
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
