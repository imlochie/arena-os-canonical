"use client";

// Spaces — a multi-window workbench where agents run small recurring tasks.
// Each panel is a "window" into one agent space; ⤢ pops it out into a real
// browser window that keeps its agent ticking while open. All tasks produce
// drafts for human review — nothing auto-posts anywhere.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import { loadKeys } from "@/components/KeysBar";
import { privacyFlags } from "@/lib/privacyClient";
import { SPACE_TEMPLATES, SPACE_TEMPLATE_GROUPS, getSpaceTemplate } from "@/lib/spaceTemplates";

interface SpaceState {
  id: string;
  title: string;
  emoji: string;
  prompt: string;
  modelId: string;
  intervalMinutes: number;
  status: "running" | "paused";
  briefcase: string;
  lastOutput: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  okCount: number;
  due: boolean;
  createdAt: string;
}

interface ModelInfo {
  id: string;
  name: string;
  emoji: string;
  kind: string;
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "due now";
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function timeAgo(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(1, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function SpacesWorkbench() {
  const [spaces, setSpaces] = useState<SpaceState[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // new-space form (seeded from the default template via lazy initial state)
  const [templateId, setTemplateId] = useState("youtube-copilot");
  const [title, setTitle] = useState(() => getSpaceTemplate("youtube-copilot")?.name ?? "");
  const [prompt, setPrompt] = useState(() => getSpaceTemplate("youtube-copilot")?.prompt ?? "");
  const [briefcase, setBriefcase] = useState(() => getSpaceTemplate("youtube-copilot")?.briefcaseSeed ?? "");
  const [modelId, setModelId] = useState("openai");
  const [intervalMinutes, setIntervalMinutes] = useState(
    () => getSpaceTemplate("youtube-copilot")?.intervalMinutes ?? 60
  );

  const spacesRef = useRef(spaces);
  useEffect(() => {
    spacesRef.current = spaces;
  }, [spaces]);
  const tickInFlight = useRef(false);

  const textModels = useMemo(() => models.filter((m) => m.kind === "text"), [models]);

  // ---- data ----
  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      try {
        const res = await fetch("/api/models");
        const data = await res.json();
        if (Array.isArray(data.models)) setModels(data.models);
      } catch {
        /* offline */
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/spaces");
      const data = await res.json();
      if (Array.isArray(data.spaces)) setSpaces(data.spaces);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      await refresh();
    })();
  }, [refresh]);

  // ---- the heartbeat: tick due spaces while the workbench is visible ----
  const tick = useCallback(async () => {
    if (tickInFlight.current) return;
    const anyRunning = spacesRef.current.some((s) => s.status === "running");
    if (!anyRunning) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    tickInFlight.current = true;
    try {
      const res = await fetch("/api/spaces/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 2, keys: loadKeys(), ...privacyFlags() }),
      });
      const data = await res.json();
      if (Array.isArray(data.spaces)) setSpaces(data.spaces);
    } catch {
      /* transient */
    } finally {
      tickInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const iv = setInterval(() => void tick(), 20000);
    return () => clearInterval(iv);
  }, [tick]);

  // local countdown refresh (state-driven so render stays pure)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  // ---- actions ----
  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = getSpaceTemplate(id);
    if (!t) return;
    setTitle(t.name);
    setPrompt(t.prompt);
    setBriefcase(t.briefcaseSeed ?? "");
    setIntervalMinutes(t.intervalMinutes);
  };

  const create = async () => {
    if (!prompt.trim()) {
      setError("Write the task prompt first");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/spaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, prompt, briefcase, modelId, intervalMinutes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "create failed");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    } finally {
      setCreating(false);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/spaces/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data?.space) setSpaces((prev) => prev.map((s) => (s.id === id ? data.space : s)));
    } catch {
      /* ignore */
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/spaces/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: loadKeys(), ...privacyFlags() }),
      });
      const data = await res.json();
      if (data?.space) setSpaces((prev) => prev.map((s) => (s.id === id ? data.space : s)));
    } catch {
      /* ignore */
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await fetch(`/api/spaces/${id}`, { method: "DELETE" });
      setSpaces((prev) => prev.filter((s) => s.id !== id));
    } catch {
      /* ignore */
    } finally {
      setBusyId(null);
    }
  };

  const popOut = (id: string) => {
    window.open(`/spaces/${id}`, `space_${id}`, "width=560,height=780");
  };

  const runningCount = spaces.filter((s) => s.status === "running").length;

  return (
    <div className="mx-auto max-w-7xl">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-1.5 text-xs font-bold text-cyan-200">
            🪟 Spaces · agents at work, in windows
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">
            A workbench of{" "}
            <span className="bg-gradient-to-r from-cyan-300 to-violet-300 bg-clip-text text-transparent">
              small repetitive tasks
            </span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-300">
            Each space is one recurring agent task on its own clock — with a persistent <em>briefcase</em> of notes it
            carries between runs. Pop spaces out into real browser windows; each open window keeps its agent ticking.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-bold">
          <span className="rounded-full bg-emerald-400/10 px-3 py-1.5 text-emerald-300 ring-1 ring-emerald-400/30">
            ● {runningCount} running
          </span>
          <span className="rounded-full bg-white/5 px-3 py-1.5 text-slate-400 ring-1 ring-white/10">
            {spaces.length} space{spaces.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[330px_1fr]">
        {/* ---- left: new space ---- */}
        <div className="glass h-fit rounded-2xl p-4">
          <h2 className="text-sm font-extrabold text-white">➕ New space</h2>
          <div className="mt-3 space-y-2.5">
            {SPACE_TEMPLATE_GROUPS.map((g) => (
              <div key={g.id}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{g.label}</div>
                <div className="mt-1 grid grid-cols-2 gap-1.5">
                  {SPACE_TEMPLATES.filter((t) => t.group === g.id).map((t) => (
                    <button
                      key={t.id}
                      onClick={() => applyTemplate(t.id)}
                      title={t.tagline}
                      className={`rounded-xl px-2.5 py-2 text-left text-[11px] font-bold ring-1 transition ${
                        templateId === t.id
                          ? "bg-cyan-400/15 text-cyan-100 ring-cyan-400/40"
                          : "bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10"
                      }`}
                    >
                      {t.emoji} {t.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            Templates produce <strong className="text-slate-400">drafts for your review</strong> — comments, proposals
            and replies you post or send yourself. That keeps accounts safe and engagement authentic.
          </p>

          <label className="mt-3 block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/60"
            />
          </label>

          <label className="mt-2 block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Task prompt</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              className="scroll-thin mt-1.5 w-full resize-y rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs leading-relaxed text-white outline-none focus:border-cyan-400/60"
            />
          </label>

          <label className="mt-2 block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Briefcase (starting notes)
            </span>
            <textarea
              value={briefcase}
              onChange={(e) => setBriefcase(e.target.value)}
              rows={3}
              placeholder="What the agent should carry between runs…"
              className="scroll-thin mt-1.5 w-full resize-y rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/60"
            />
          </label>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs font-bold text-slate-400">Model</span>
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-2 py-2 text-xs text-white outline-none"
              >
                {textModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.emoji} {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-400">Every (min)</span>
              <input
                type="number"
                min={5}
                max={1440}
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(Number(e.target.value) || 60)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-2 py-2 text-xs text-white outline-none"
              />
            </label>
          </div>

          <button
            onClick={create}
            disabled={creating}
            className="mt-3 w-full rounded-2xl bg-gradient-to-r from-cyan-600 to-violet-600 px-4 py-3 text-sm font-black text-white shadow-xl shadow-cyan-900/30 transition hover:brightness-110 disabled:opacity-40"
          >
            {creating ? "Opening space…" : "🪟 Create space"}
          </button>
          {error && (
            <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 ring-1 ring-red-400/30">
              {error}
            </p>
          )}
        </div>

        {/* ---- right: the windows ---- */}
        <div>
          {spaces.length === 0 ? (
            <div className="glass rounded-2xl p-10 text-center">
              <p className="text-4xl">🪟</p>
              <p className="mt-3 text-sm font-bold text-slate-300">No spaces yet</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
                Pick a template on the left, give it a briefcase of notes, and the agent starts working its schedule —
                drafting while you do other things.
              </p>
            </div>
          ) : (
            <div className={`grid gap-4 ${expanded ? "grid-cols-1" : "xl:grid-cols-2"}`}>
              {spaces.map((s) => (
                <SpaceWindow
                  key={s.id}
                  space={s}
                  expanded={expanded === s.id}
                  busy={busyId === s.id}
                  now={now}
                  models={models}
                  onToggleExpand={() => setExpanded(expanded === s.id ? null : s.id)}
                  onRunNow={() => void runNow(s.id)}
                  onPatch={(body) => void patch(s.id, body)}
                  onRemove={() => void remove(s.id)}
                  onPopOut={() => popOut(s.id)}
                />
              ))}
            </div>
          )}
          <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-500">
            Spaces tick when a workbench window is open (every ~20s, a couple of due agents per tick) · agents draft,
            you act — no auto-posting by design.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------- one window panel ----------------

function SpaceWindow({
  space,
  expanded,
  busy,
  now,
  models,
  onToggleExpand,
  onRunNow,
  onPatch,
  onRemove,
  onPopOut,
}: {
  space: SpaceState;
  expanded: boolean;
  busy: boolean;
  now: number;
  models: ModelInfo[];
  onToggleExpand: () => void;
  onRunNow: () => void;
  onPatch: (body: Record<string, unknown>) => void;
  onRemove: () => void;
  onPopOut: () => void;
}) {
  const nextIn = space.nextRunAt ? new Date(space.nextRunAt).getTime() - now : 0;
  const modelName = models.find((m) => m.id === space.modelId)?.name ?? space.modelId;
  return (
    <div className="glass overflow-hidden rounded-2xl">
      {/* title bar */}
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2">
        <span className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/60" />
        </span>
        <span className="ml-1 min-w-0 flex-1 truncate text-xs font-extrabold text-white">
          {space.emoji} {space.title}
        </span>
        <span
          className={`shrink-0 text-[10px] font-bold ${
            space.status === "running" ? (space.due ? "text-amber-300" : "text-emerald-300") : "text-slate-500"
          }`}
        >
          {space.status === "running" ? (space.due ? "● due" : `● ${fmtCountdown(nextIn)}`) : "⏸ paused"}
        </span>
      </div>

      {/* body */}
      <div className="p-3.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
          <span className="font-bold text-slate-400">{modelName}</span>
          <span>· every {space.intervalMinutes}m</span>
          <span>· {space.runCount} runs</span>
          <span>· last {timeAgo(space.lastRunAt, now)}</span>
        </p>

        <div className={`scroll-thin mt-2.5 overflow-y-auto rounded-xl bg-black/30 p-3 ring-1 ring-white/5 ${expanded ? "max-h-[420px]" : "max-h-40"}`}>
          {space.lastOutput ? (
            <div className="text-xs">
              <Markdown text={space.lastOutput} />
            </div>
          ) : (
            <p className="text-xs italic text-slate-600">
              no output yet — {space.status === "running" ? "first run on the next tick (or hit ⚡)" : "paused"}
            </p>
          )}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button
            onClick={onRunNow}
            disabled={busy}
            className="rounded-lg bg-cyan-500/15 px-2.5 py-1.5 text-xs font-bold text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-40"
            title="Run once now"
          >
            ⚡ Run
          </button>
          <button
            onClick={() => onPatch({ status: space.status === "running" ? "paused" : "running" })}
            disabled={busy}
            className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
          >
            {space.status === "running" ? "⏸ Pause" : "▶ Resume"}
          </button>
          <button
            onClick={onPopOut}
            className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
            title="Pop out into its own browser window"
          >
            ⤢ Window
          </button>
          <button
            onClick={onToggleExpand}
            className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "⤡" : "⤢"}
          </button>
          <button
            onClick={() => {
              if (confirm(`Delete "${space.title}" and its run history?`)) onRemove();
            }}
            disabled={busy}
            className="ml-auto rounded-lg bg-red-500/10 px-2 py-1.5 text-xs text-red-300 ring-1 ring-red-400/20 hover:bg-red-500/20 disabled:opacity-40"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
