"use client";

// Spaces — a multi-window workbench where agents run small recurring tasks.
// Each panel is a "window" into one agent space; ⤢ pops it out into a real
// browser window that keeps its agent ticking while open. All tasks produce
// drafts for human review — nothing auto-posts anywhere.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import { loadKeys } from "@/components/KeysBar";
import { privacyFlags } from "@workspace/arena/lib/privacyClient";
import { SPACE_TEMPLATES, SPACE_TEMPLATE_GROUPS, getSpaceTemplate } from "@workspace/arena/lib/spaceTemplates";
import BrainCard from "@/components/BrainCard";
import { readBrain } from "@workspace/arena/lib/connectedBrain";
import SpaceBrowserPanel from "./SpaceBrowserPanel";

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
  const [openingBrowserWorkspace, setOpeningBrowserWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // new-space form (seeded from the default template via lazy initial state)
  const [watchType, setWatchType] = useState("");
  const [watchSource, setWatchSource] = useState("");
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
        body: JSON.stringify({ title, prompt, briefcase, modelId, intervalMinutes, watchType: watchType || undefined, watchSource: watchSource || undefined }),
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

  const openBrowserWorkspace = async () => {
    setOpeningBrowserWorkspace(true);
    setWorkspaceError(null);
    try {
      const res = await fetch("/api/spaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Browser workspace",
          emoji: "🌐",
          prompt: "Run browser tasks only when I start a mission. Keep page observations and saved files in this workspace.",
          modelId: readBrain().modelId,
          intervalMinutes: 1440,
          status: "paused",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.space?.id) throw new Error(data?.error ?? "Could not create browser workspace");
      await refresh();
      setExpanded(data.space.id);
    } catch (e) {
      setWorkspaceError(e instanceof Error ? e.message : "Could not create browser workspace");
    } finally {
      setOpeningBrowserWorkspace(false);
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
            <span className="bg-gradient-to-r from-cyan-300 to-violet-300 bg-clip-text text-transparent">
              Browser tasks in private workspaces
            </span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-300">
            Each workspace keeps its own browser session, task history, and files. Page changes wait for your approval.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-bold">
          <button
            type="button"
            onClick={() => void openBrowserWorkspace()}
            disabled={openingBrowserWorkspace}
            className="rounded-xl bg-cyan-500/15 px-3 py-2 text-cyan-100 ring-1 ring-cyan-400/30 disabled:opacity-40"
          >
            {openingBrowserWorkspace ? "Creating workspace…" : "New browser workspace"}
          </button>
          <span className="rounded-full bg-emerald-400/10 px-3 py-1.5 text-emerald-300 ring-1 ring-emerald-400/30">
            ● {runningCount} scheduled
          </span>
          <span className="rounded-full bg-white/5 px-3 py-1.5 text-slate-400 ring-1 ring-white/10">
            {spaces.length} space{spaces.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      {workspaceError && <p role="alert" className="mt-3 text-sm text-red-300">{workspaceError}</p>}

      <div className="mt-6 grid gap-5 lg:grid-cols-[330px_1fr]">
        {/* ---- left: new space ---- */}
        <div className="glass h-fit rounded-2xl p-4">
          <BrainCard context="spaces" />
          <details className="mt-3">
          <summary className="cursor-pointer text-sm font-extrabold text-white">Recurring agents</summary>
          <div className="mt-3">
          <h2 className="text-sm font-extrabold text-white">➕ New recurring agent</h2>
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

          <div className="mt-2 grid gap-1.5">
            <select
              value={watchType}
              onChange={(e) => setWatchType(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-[#0c1428] px-2.5 py-2 text-xs text-white outline-none"
              title="Optionally let this space watch a real source on every run"
            >
              <option value="">No watcher — agent space only</option>
              <option value="youtube-channel">▶ Watch YouTube channel</option>
              <option value="youtube-playlist">▶ Watch YouTube playlist</option>
            </select>
            <input
              value={watchSource}
              onChange={(e) => setWatchSource(e.target.value)}
              placeholder={watchType ? "channel id (UC…), @handle, or playlist id (PL…)" : "—"}
              disabled={!watchType}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-xs text-white outline-none placeholder:text-slate-600 disabled:opacity-40"
            />
            <p className="text-[10px] leading-snug text-slate-600">
              A watcher fetches the real feed every run (free — no YouTube API key) and feeds new titles + descriptions to the space as notes.
            </p>
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
          </details>
        </div>

        {/* ---- right: the windows ---- */}
        <div>
          {spaces.length === 0 ? (
            <div className="glass rounded-2xl p-10 text-center">
              <p className="text-4xl">🌐</p>
              <h2 className="mt-3 text-xl font-extrabold text-white">Create a browser workspace</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
                Give it a task, and its agent can browse pages, save observations, and keep files here.
                Clicks and form entries require your approval.
              </p>
              <button
                type="button"
                onClick={() => void openBrowserWorkspace()}
                disabled={openingBrowserWorkspace}
                className="mt-5 rounded-xl bg-gradient-to-r from-cyan-600 to-violet-600 px-5 py-3 text-sm font-black text-white disabled:opacity-50"
              >
                {openingBrowserWorkspace ? "Creating workspace…" : "Create browser workspace"}
              </button>
            </div>
          ) : (
            <div className="grid gap-4">
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
                  onRefresh={() => void refresh()}
                  onRemove={() => void remove(s.id)}
                  onPopOut={() => popOut(s.id)}
                />
              ))}
            </div>
          )}
          <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-500">
            Browser workspaces run only when you start a task. Recurring agents run while their workbench is open.
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
  onRefresh,
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
  onRefresh: () => void;
  onRemove: () => void;
  onPopOut: () => void;
}) {
  const nextIn = space.nextRunAt ? new Date(space.nextRunAt).getTime() - now : 0;
  const modelName = models.find((m) => m.id === space.modelId)?.name ?? space.modelId;
  return (
    <div className="glass overflow-hidden rounded-2xl" data-space-id={space.id}>
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
            {space.status === "running" ? (space.due ? "● scheduled: due" : `● scheduled in ${fmtCountdown(nextIn)}`) : "Schedule off"}
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

        {(space.lastOutput || space.status === "running") && <div className={`scroll-thin mt-2.5 overflow-y-auto rounded-xl bg-black/30 p-3 ring-1 ring-white/5 ${expanded ? "max-h-[420px]" : "max-h-40"}`}>
          {space.lastOutput ? (
            <div className="text-xs">
              <Markdown text={space.lastOutput} />
            </div>
          ) : (
            <p className="text-xs italic text-slate-600">
              no output yet — {space.status === "running" ? "first run on the next tick (or hit ⚡)" : "paused"}
            </p>
          )}
        </div>}

        <SpaceBrowserPanel spaceId={space.id} />
        <MissionPanel spaceId={space.id} />
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-bold text-slate-400">Multi-agent setup</summary>
          <AgentFleet spaceId={space.id} models={models} />
        </details>
        <ApprovalsPanel spaceId={space.id} onDecided={onRefresh} />

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button
            onClick={onRunNow}
            disabled={busy}
            className="rounded-lg bg-cyan-500/15 px-2.5 py-1.5 text-xs font-bold text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-40"
            title="Run once now"
          >
            Run recurring draft
          </button>
          <button
            onClick={() => onPatch({ status: space.status === "running" ? "paused" : "running" })}
            disabled={busy}
            className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
          >
            {space.status === "running" ? "Pause schedule" : "Enable schedule"}
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

// ---------------- agent fleet panel ----------------

interface FleetAgent {
  id: string;
  name: string;
  role: string;
  modelId: string;
  systemPrompt: string;
}

interface FleetRunResult {
  agent: { id: string; name: string; role: string; modelId: string };
  ok: boolean;
  output: string;
  via: string;
  ms: number;
  runtime?: { backend?: string; via?: string; fallback?: boolean; fallbackReason?: string } | null;
}

function runtimeBadge(r: FleetRunResult["runtime"]): string {
  if (!r) return "";
  const fb = r.fallback ? " · fallback" : "";
  return (r.backend ?? r.via ?? "?") + fb;
}

function AgentFleet({ spaceId, models }: { spaceId: string; models: ModelInfo[] }) {
  const [agents, setAgents] = useState<FleetAgent[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState("worker");
  const [modelId, setModelId] = useState(() => readBrain().modelId);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<FleetRunResult[]>([]);
  const [synthesis, setSynthesis] = useState<FleetRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/spaces/${spaceId}/agents`, { cache: "no-store" });
      const body = await res.json();
      if (Array.isArray(body.agents)) setAgents(body.agents);
    } catch {
      /* offline — panel shows the honest error on action */
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addAgent() {
    setError(null);
    if (!name.trim()) {
      setError("Give the agent a name.");
      return;
    }
    const res = await fetch(`/api/spaces/${spaceId}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, role, modelId, systemPrompt }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "agent could not be added");
      return;
    }
    setName("");
    setSystemPrompt("");
    setShowForm(false);
    await load();
  }

  async function removeAgent(id: string) {
    await fetch(`/api/spaces/${spaceId}/agents/${id}`, { method: "DELETE" });
    await load();
  }

  async function runFleet() {
    setRunning(true);
    setError(null);
    setResults([]);
    setSynthesis(null);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/fleet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: loadKeys(), ...privacyFlags() }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "fleet run failed");
        return;
      }
      setResults(body.results ?? []);
      setSynthesis(body.synthesis ?? null);
    } catch {
      setError("fleet run failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-2.5 rounded-xl bg-black/20 p-3 ring-1 ring-white/5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-violet-200/70">
          Agent fleet · {agents.length}
        </span>
        <button
          onClick={runFleet}
          disabled={running || !agents.length}
          className="rounded-lg bg-violet-500/15 px-2.5 py-1 text-xs font-bold text-violet-200 ring-1 ring-violet-400/30 hover:bg-violet-500/25 disabled:opacity-40"
          title={agents.length ? "Run every agent concurrently, then synthesize" : "Add agents first"}
        >
          {running ? "Running…" : "🚀 Run fleet"}
        </button>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-lg bg-white/5 px-2.5 py-1 text-xs font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
        >
          {showForm ? "× Cancel" : "+ Agent"}
        </button>
      </div>

      {showForm && (
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. Researcher)"
            className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-slate-600"
          />
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Role (worker, critic, planner…)"
            className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-slate-600"
          />
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="rounded-lg border border-white/10 bg-[#0c1428] px-2.5 py-1.5 text-xs text-white outline-none"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <input
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="System prompt (optional)"
            className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-slate-600"
          />
          <button
            onClick={addAgent}
            className="rounded-lg bg-violet-500/25 px-2.5 py-1.5 text-xs font-bold text-violet-100 ring-1 ring-violet-400/30 hover:bg-violet-500/35"
          >
            Add agent
          </button>
        </div>
      )}

      {agents.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {agents.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300"
              title={a.systemPrompt || a.role}
            >
              <b className="text-white">{a.name}</b>
              <span className="text-slate-500">{a.role}</span>
              <span className="text-cyan-300/70">{models.find((m) => m.id === a.modelId)?.name ?? a.modelId}</span>
              <button
                onClick={() => removeAgent(a.id)}
                className="text-red-300/60 hover:text-red-300"
                title="Remove agent"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-amber-300">{error}</p>}

      {(results.length > 0 || synthesis) && (
        <div className="scroll-thin mt-2.5 max-h-72 space-y-2 overflow-y-auto">
          {results.map((r) => (
            <div key={r.agent.id} className="rounded-lg bg-black/30 p-2.5 ring-1 ring-white/5">
              <p className="flex flex-wrap items-center gap-2 text-[11px]">
                <b className="text-white">{r.agent.name}</b>
                <span className="text-slate-500">{r.agent.role}</span>
                <span className="text-emerald-300/80">{runtimeBadge(r.runtime)}</span>
                <span className="text-slate-600">{r.ms}ms</span>
              </p>
              <div className="mt-1 text-xs">
                <Markdown text={r.output} />
              </div>
            </div>
          ))}
          {synthesis && (
            <div className="rounded-lg bg-violet-500/10 p-2.5 ring-1 ring-violet-400/20">
              <p className="flex flex-wrap items-center gap-2 text-[11px]">
                <b className="text-violet-100">🧵 Synthesis</b>
                <span className="text-emerald-300/80">{runtimeBadge(synthesis.runtime)}</span>
              </p>
              <div className="mt-1 text-xs">
                <Markdown text={synthesis.output} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- mission panel ----------------

interface MissionStepLite {
  agent: string;
  turn: number;
  thought: string;
  done: boolean;
  actions: { tool: string; ok: boolean; output: string; input: Record<string, unknown> }[];
  runtime?: { backend?: string; modelId?: string; fallback?: boolean };
  ms: number;
}

interface MissionLite {
  id: string;
  goal: string;
  status: string;
  statusDetail: string;
  timeBudgetMs: number;
  agentPlan: { name: string; role: string }[];
  journal: MissionStepLite[];
  artifacts: { path: string; bytes: number }[];
  handoff: string;
}

function MissionPanel({ spaceId }: { spaceId: string }) {
  const [taskMode, setTaskMode] = useState<"browser" | "build">("browser");
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState(5);
  const [turns, setTurns] = useState(3);
  const [extraCommands, setExtraCommands] = useState("");
  const [isolation, setIsolation] = useState<"auto" | "container" | "host">("auto");
  const [isolationNetwork, setIsolationNetwork] = useState<"none" | "bridge">("none");
  const [showAdv, setShowAdv] = useState(false);
  const [githubToken, setGithubToken] = useState("");
  const [showGit, setShowGit] = useState(false);
  const [running, setRunning] = useState(false);
  const [mission, setMission] = useState<MissionLite | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/spaces/${spaceId}/mission`, { cache: "no-store" })
      .then((r) => r.json())
      .then((b) => { if (alive && b.mission) setMission(b.mission); })
      .catch(() => {});
    return () => { alive = false; };
  }, [spaceId]);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    const timer = setInterval(() => {
      fetch(`/api/spaces/${spaceId}/mission`, { cache: "no-store" })
        .then(response => response.json())
        .then(data => { if (alive && data.mission) setMission(data.mission); })
        .catch(() => {});
    }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [running, spaceId]);

  async function start(continueMission: boolean) {
    const brain = readBrain();
    if (brain.provider === "local") {
      setError("Agent-planned browser tasks need a connected model. Open page above works without one; the offline engine cannot automate the task.");
      return;
    }
    if (privacyFlags().localOnly && brain.provider !== "turboagent") {
      setError("Local Mode is on, so remote AI models are disabled. Change the AI mode before starting an agent-planned browser task.");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/mission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: taskMode === "browser" ? "browser" : undefined,
          modelId: brain.modelId,
          keys: loadKeys(),
          ...privacyFlags(),
          githubToken: githubToken || undefined,
          maxTurnsPerAgent: turns,
          isolation,
          isolationNetwork,
          extraCommands: extraCommands
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
            .slice(0, 12),
          ...(continueMission ? {} : { goal, timeBudgetMinutes: budget }),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "mission failed");
        return;
      }
      setMission(body.mission);
    } catch {
      setError("mission failed");
    } finally {
      setRunning(false);
    }
  }

  const checkpointed = mission?.status === "checkpointed" || mission?.status === "awaiting_approval";

  return (
    <div className="mt-2.5 rounded-xl bg-black/20 p-3 ring-1 ring-white/5">
      <div className="flex flex-wrap items-center gap-1.5">
        <select aria-label="Task capability" value={taskMode} onChange={event => setTaskMode(event.target.value as "browser" | "build")} className="rounded-lg border border-white/15 bg-[#0c1428] px-2 py-1 text-xs font-bold text-cyan-100">
          <option value="browser">Browser automation</option>
          <option value="build">Build files</option>
        </select>
        {mission && (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              mission.status === "done"
                ? "bg-emerald-400/10 text-emerald-300"
                : mission.status === "checkpointed" || mission.status === "awaiting_approval"
                  ? "bg-amber-400/10 text-amber-300"
                  : mission.status === "failed"
                    ? "bg-red-400/10 text-red-300"
                    : "bg-white/5 text-slate-300"
            }`}
            title={mission.statusDetail}
          >
            {mission.status}
          </span>
        )}
        {taskMode === "build" && <button
          onClick={() => setShowGit((v) => !v)}
          className="rounded-lg bg-white/5 px-2 py-1 text-[11px] font-bold text-slate-400 ring-1 ring-white/10 hover:bg-white/10"
          title="Connect GitHub (token stays in this browser)"
        >
          {showGit ? "× GitHub" : "🐙 GitHub"}
        </button>}
        {taskMode === "build" && <button
          onClick={() => setShowAdv((v) => !v)}
          className="rounded-lg bg-white/5 px-2 py-1 text-[11px] font-bold text-slate-400 ring-1 ring-white/10 hover:bg-white/10"
          title="Agent iteration budget + extra command allowlist"
        >
          {showAdv ? "× ⚙" : "⚙"}
        </button>}
      </div>

      {showAdv && taskMode === "build" && (
        <div className="mt-2 grid gap-1.5 sm:grid-cols-[110px_1fr]">
          <select
            value={turns}
            onChange={(e) => setTurns(Number(e.target.value))}
            className="rounded-lg border border-white/10 bg-[#0c1428] px-2 py-1.5 text-xs text-white outline-none"
            title="Turns per agent — more turns = more fix-fail-verify loops"
          >
            {[1, 3, 5, 8, 12, 16].map((t) => (
              <option key={t} value={t}>
                {t} turns
              </option>
            ))}
          </select>
          <select
            value={isolation}
            onChange={(e) => setIsolation(e.target.value as "auto" | "container" | "host")}
            className="rounded-lg border border-white/10 bg-[#0c1428] px-2 py-1.5 text-xs text-white outline-none"
            title="Where commands run: auto = container when a runtime exists (honest host fallback otherwise); container = require isolation; host = this machine's jail"
          >
            <option value="auto">isolated: auto</option>
            <option value="container">isolated: required</option>
            <option value="host">host jail</option>
          </select>
          <select
            value={isolationNetwork}
            onChange={(e) => setIsolationNetwork(e.target.value as "none" | "bridge")}
            className="rounded-lg border border-white/10 bg-[#0c1428] px-2 py-1.5 text-xs text-white outline-none"
            title="Container network: none = fully offline (strict default); bridge = bounded internet for installs"
          >
            <option value="none">net: offline</option>
            <option value="bridge">net: bounded</option>
          </select>
          <input
            value={extraCommands}
            onChange={(e) => setExtraCommands(e.target.value)}
            placeholder="extra commands: python, pip, make… (opt-in only)"
            className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-slate-600"
            title="Comma-separated extra binaries agents may run (beyond node, npm, npx, git, python3, ls, cat)"
          />
        </div>
      )}

      <p className="mt-1 text-[11px] text-slate-400">
        Needs a connected AI model. Uses this workspace’s browser, pauses for approval before clicks or typing, and saves its results to downloadable reports.
      </p>

      {showGit && taskMode === "build" && (
        <input
          value={githubToken}
          onChange={(e) => setGithubToken(e.target.value)}
          type="password"
          placeholder="GitHub PAT (repo scope) — used for github_publish during missions"
          className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-slate-600"
        />
      )}

      <div className="mt-2 grid gap-1.5 sm:grid-cols-[1fr_90px_auto]">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          aria-label={taskMode === "browser" ? "Browser task" : "Build task"}
          rows={3}
          placeholder={checkpointed ? `resume: ${mission?.goal.slice(0, 60)}…` : taskMode === "browser" ? "Describe the browser task, the page URL, and the result you need." : "Describe the files or application to build."}
          className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-slate-600"
        />
        <select
          value={budget}
          onChange={(e) => setBudget(Number(e.target.value))}
          className="rounded-lg border border-white/10 bg-[#0c1428] px-2 py-1.5 text-xs text-white outline-none"
          title="Time budget — the mission checkpoints and can be resumed"
        >
          {[1, 2, 5, 10, 20, 60].map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>
        {checkpointed ? (
          <button
            onClick={() => start(true)}
            disabled={running}
            className="rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-bold text-amber-200 ring-1 ring-amber-400/30 hover:bg-amber-500/30 disabled:opacity-40"
          >
            {running ? "Resuming…" : "▶ Resume"}
          </button>
        ) : (
          <button
            onClick={() => {
              if (!goal.trim()) {
                setError("Give the mission a goal.");
                return;
              }
              start(false);
            }}
            disabled={running}
            className="rounded-lg bg-cyan-500/15 px-3 py-1.5 text-xs font-bold text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-40"
            title="Agents get a real workspace: files, allowlisted commands, fetch, and GitHub publish — journaled, time-budgeted, checkpointable"
          >
            {running ? "Running task…" : taskMode === "browser" ? "Run browser task" : "Run build mission"}
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-amber-300">{error}</p>}

      {mission && (
        <div className="scroll-thin mt-2.5 max-h-72 space-y-2 overflow-y-auto">
          <p className="text-[11px] text-slate-500">
            plan: {mission.agentPlan.map((a) => `${a.name} (${a.role})`).join(" → ") || "—"} · budget{" "}
            {Math.round(mission.timeBudgetMs / 60000)}m
          </p>
          {mission.journal.map((s, i) => (
            <div key={i} className="rounded-lg bg-black/30 p-2.5 ring-1 ring-white/5">
              <p className="flex flex-wrap items-center gap-2 text-[11px]">
                <b className="text-white">{s.agent}</b>
                <span className="text-slate-600">turn {s.turn}</span>
                <span className="text-emerald-300/80">{s.runtime?.backend ?? "?"}</span>
                <span className="text-slate-600">{s.ms}ms</span>
                {s.done && <span className="text-emerald-300">done</span>}
              </p>
              <p className="mt-1 text-[11px] italic text-slate-400">{s.thought}</p>
              {s.actions.map((a, j) => (
                <p key={j} className={`mt-1 break-all font-mono text-[10px] ${a.ok ? "text-slate-400" : "text-red-300/80"}`}>
                  {a.ok ? "✓" : "✗"} {a.tool} {JSON.stringify(a.input).slice(0, 90)} → {a.output.slice(0, 140)}
                </p>
              ))}
            </div>
          ))}
          {mission.artifacts.length > 0 && (
            <div className="flex flex-wrap gap-2 text-[11px] text-slate-400">
              {mission.artifacts.map(artifact => {
                const report = artifact.path.replaceAll("\\", "/").startsWith("reports/");
                const image = /^browser-\d+\.png$/.test(artifact.path);
                return report || image ? (
                  <a key={artifact.path} className="rounded-lg bg-cyan-500/10 px-2 py-1 font-bold text-cyan-200 underline" href={`/api/spaces/${spaceId}/browser?${report ? "file" : "image"}=${encodeURIComponent(artifact.path)}`} target="_blank" rel="noreferrer">
                    {report ? "Download" : "View"} {artifact.path}
                  </a>
                ) : <span key={artifact.path}>{artifact.path}</span>;
              })}
            </div>
          )}
          {mission.handoff && (
            <p className="rounded-lg bg-white/[0.03] p-2 text-[11px] text-slate-400 ring-1 ring-white/5">
              <b className="text-slate-300">handoff:</b> {mission.handoff.slice(0, 300)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- approvals panel (check-in environment) ----------------

interface ApprovalLite {
  id: string;
  actionClass: string;
  summary: string;
  status: string;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  result: unknown;
  failureReason: string | null;
}

const APPROVAL_CLASS_LABELS: Record<string, string> = {
  "github.publish": "GitHub publish",
  "browser.interact": "Browser action",
  "external.call": "Phone call",
  "external.sms": "SMS",
  "payment.link": "Payment",
};

function ApprovalsPanel({ spaceId, onDecided }: { spaceId: string; onDecided: () => void }) {
  const [approvals, setApprovals] = useState<ApprovalLite[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/spaces/approvals?spaceId=${spaceId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((b) => { if (Array.isArray(b.approvals)) setApprovals(b.approvals.slice(0, 20)); })
      .catch(() => {});
  }, [spaceId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  async function decide(id: string, decision: "approve" | "deny") {
    setBusyId(id);
    try {
      await fetch("/api/spaces/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision, decidedBy: "workbench" }),
      });
      load();
      onDecided();
    } finally {
      setBusyId(null);
    }
  }

  const pending = approvals.filter((a) => a.status === "pending");
  const recent = approvals.filter((a) => a.status !== "pending").slice(0, 5);
  if (pending.length === 0 && recent.length === 0) return null; // nothing gated yet — no clutter

  return (
    <div className="mt-2.5 rounded-xl bg-black/20 p-3 ring-1 ring-white/5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-200/70">Check-in required</span>
        {pending.length > 0 && (
          <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
            {pending.length} awaiting you
          </span>
        )}
        <span className="text-[10px] text-slate-500" title="These action classes never run without your explicit decision; denials are permanent for that exact action.">
          gated: publish · browser act · calls · SMS · payments
        </span>
      </div>

      {pending.map((a) => (
        <div key={a.id} className="mt-2 rounded-lg bg-amber-400/5 p-2 ring-1 ring-amber-400/20">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-bold text-amber-200">
                {APPROVAL_CLASS_LABELS[a.actionClass] ?? a.actionClass}
              </p>
              <p className="truncate text-[11px] text-slate-400" title={a.summary}>{a.summary}</p>
              <p className="text-[10px] text-slate-600">requested {new Date(a.requestedAt).toLocaleString()}</p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button
                onClick={() => decide(a.id, "approve")}
                disabled={busyId === a.id}
                className="rounded-lg bg-emerald-500/15 px-2.5 py-1.5 text-xs font-bold text-emerald-200 ring-1 ring-emerald-400/30 hover:bg-emerald-500/25 disabled:opacity-40"
                title="Approve exactly once — the mission executes it and the ledger records the execution"
              >
                ✓ Approve
              </button>
              <button
                onClick={() => decide(a.id, "deny")}
                disabled={busyId === a.id}
                className="rounded-lg bg-red-500/15 px-2.5 py-1.5 text-xs font-bold text-red-200 ring-1 ring-red-400/30 hover:bg-red-500/25 disabled:opacity-40"
                title="Deny permanently — the agent is told the human refused and must adapt"
              >
                ✕ Deny
              </button>
            </div>
          </div>
        </div>
      ))}

      {recent.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-slate-500 hover:text-slate-400">
            decision history
          </summary>
          <div className="mt-1.5 space-y-1">
            {recent.map((a) => (
              <p key={a.id} className="truncate text-[10px] text-slate-600" title={a.summary}>
                <span className={a.status === "executed" ? "text-emerald-400" : a.status === "denied" ? "text-red-400" : "text-slate-400"}>
                  {a.status}
                </span>{" "}
                · {APPROVAL_CLASS_LABELS[a.actionClass] ?? a.actionClass} · {a.summary}
                {a.decidedBy ? ` · by ${a.decidedBy}` : ""}
              </p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
