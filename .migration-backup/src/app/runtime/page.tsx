"use client";

import { useEffect, useState } from "react";
import KeysBar from "@/components/KeysBar";
import {
  checkWebGPU,
  isEngineLoaded,
  loadedModelId,
  loadEngine,
  modelReadyOffline,
  WEBLLM_MODELS,
  type LoadProgress,
} from "@/lib/webllm";
import type { BackendProbe } from "@/lib/runtimeStatus";
import type { ExecutionStatus } from "@/lib/runtime";

/**
 * AI Runtime — the three levels, their honest runtime-detected status, and
 * opt-in configuration. Nothing here is required: LEVEL 0 works immediately
 * with zero config.
 */

const STATUS_LABEL: Record<string, string> = {
  ready: "READY",
  loading: "LOADING",
  "download-required": "DOWNLOAD REQUIRED",
  connecting: "CONNECTING",
  connected: "CONNECTED",
  "api-key-required": "API KEY REQUIRED",
  "network-unavailable": "NETWORK UNAVAILABLE",
  "webgpu-unavailable": "WEBGPU UNAVAILABLE",
  "server-unavailable": "SERVER UNAVAILABLE",
  "provider-error": "PROVIDER ERROR",
  unavailable: "NOT CONFIGURED",
  error: "ERROR",
};

function statusTone(status: ExecutionStatus | string): "ready" | "warn" | "bad" | "idle" {
  if (status === "ready" || status === "connected") return "ready";
  if (status === "loading" || status === "connecting" || status === "download-required") return "warn";
  if (status === "unavailable" || status === "api-key-required") return "idle";
  return "bad";
}

function Pill({ status, prefix }: { status: ExecutionStatus | string; prefix?: string }) {
  const tone = statusTone(status);
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ring-1 ${
        tone === "ready"
          ? "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30"
          : tone === "warn"
            ? "bg-amber-400/15 text-amber-300 ring-amber-400/30"
            : tone === "bad"
              ? "bg-red-400/15 text-red-300 ring-red-400/30"
              : "bg-white/5 text-slate-400 ring-white/10"
      }`}
    >
      {prefix ? `${prefix} ` : ""}{STATUS_LABEL[status] ?? String(status).toUpperCase()}
    </span>
  );
}

export default function RuntimePage() {
  // ── LEVEL 1: WebLLM (browser) ────────────────────────────────────────────
  const [webgpu, setWebgpu] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [engineLoaded, setEngineLoaded] = useState(false);
  const [engineModel, setEngineModel] = useState<string | null>(null);
  const [cachedModel, setCachedModel] = useState<string | null>(null);
  const [webllmModel, setWebllmModel] = useState(WEBLLM_MODELS[0]?.id ?? "");
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── LEVEL 1: TurboAgent (local server) ──────────────────────────────────
  const [taUrl, setTaUrl] = useState("");
  const [probes, setProbes] = useState<Record<string, BackendProbe>>({});
  const [probing, setProbing] = useState(false);
  const [probeNotes, setProbeNotes] = useState<string[]>([]);

  // ── LEVEL 2: BYOK state (client-side only) ──────────────────────────────
  const [hasOrKey, setHasOrKey] = useState(false);
  const [hasGroqKey, setHasGroqKey] = useState(false);

  useEffect(() => {
    checkWebGPU().then(setWebgpu);
    setEngineLoaded(isEngineLoaded());
    setEngineModel(loadedModelId());
    setCachedModel(modelReadyOffline());
    try {
      setTaUrl(localStorage.getItem("af_url_turboagent") ?? "");
      setHasOrKey(!!localStorage.getItem("af_key_openrouter"));
      setHasGroqKey(!!localStorage.getItem("af_key_groq"));
    } catch {}
  }, []);

  async function runProbes() {
    setProbing(true);
    try {
      const res = await fetch("/api/runtime/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turboagent: taUrl.trim() || null }),
      });
      const j = await res.json();
      const byBackend: Record<string, BackendProbe> = {};
      for (const p of j.probes ?? []) byBackend[p.backend] = p;
      setProbes(byBackend);
      setProbeNotes(j.notes ?? []);
    } catch {
      setProbes({});
      setProbeNotes(["status probe failed — cannot reach the Arena server itself"]);
    } finally {
      setProbing(false);
    }
  }

  async function loadWebLLM() {
    setLoading(true);
    setLoadError(null);
    setLoadProgress(null);
    try {
      await loadEngine(webllmModel, setLoadProgress);
      setEngineLoaded(true);
      setEngineModel(webllmModel);
      setCachedModel(modelReadyOffline());
    } catch (e: any) {
      setLoadError(e?.message ?? "load failed");
    } finally {
      setLoading(false);
    }
  }

  const turboStatus: ExecutionStatus = probes.turboagent
    ? probes.turboagent.status
    : taUrl.trim()
      ? "unavailable"
      : "unavailable";
  const pollinationsStatus: ExecutionStatus | undefined = probes.pollinations?.status;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-3xl font-black text-white">⚙️ AI Runtime</h1>
      <p className="mt-2 text-sm text-slate-400">
        Three execution levels, honestly labelled. <strong className="text-slate-200">Works immediately</strong>{" "}
        with LEVEL 0 — upgrade the intelligence when you want. Levels describe HOW an answer is produced, not
        how smart it is.
      </p>

      <button
        onClick={runProbes}
        disabled={probing}
        className="mt-4 rounded-lg border border-violet-400/30 bg-violet-500/15 px-4 py-2 text-sm font-bold text-violet-200 hover:bg-violet-500/25 disabled:opacity-40"
      >
        {probing ? "Probing runtimes…" : "🔍 Run live status check"}
      </button>

      {/* ── LEVEL 0 ──────────────────────────────────────────────────────── */}
      <section className="glass mt-6 rounded-2xl border-emerald-400/20 p-5" data-testid="level-arena-local">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-black text-white">
            LEVEL 0 · <span className="text-emerald-300">Arena Local Engine</span>
          </h2>
          <Pill status="ready" />
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          A deterministic offline reasoning layer — <strong>not an LLM</strong>. Heuristic templates, term
          extraction, synthesis, and judging. It never runs a foundation model and never lists one. This is the
          Arena baseline: useful for flows, demos, and deterministic regression — not a model battle
          contestant.
        </p>
        <ul className="mt-2 grid gap-1 text-xs text-slate-400 sm:grid-cols-3">
          <li>🔒 No network egress</li>
          <li>🔑 No keys</li>
          <li>⚡ Instant, no download</li>
        </ul>
        <p className="mt-2 text-[11px] text-slate-500">No configuration. This is the guaranteed floor.</p>
      </section>

      {/* ── LEVEL 1 ──────────────────────────────────────────────────────── */}
      <section className="glass mt-4 rounded-2xl border-sky-400/20 p-5" data-testid="level-on-device">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-black text-white">
            LEVEL 1 · <span className="text-sky-300">On-Device LLM</span>
          </h2>
          {engineLoaded ? (
            <Pill status="ready" prefix={`RUNNING ${engineModel}`} />
          ) : webgpu === null ? (
            <Pill status="connecting" />
          ) : webgpu.ok ? (
            <Pill status="download-required" />
          ) : (
            <Pill status="webgpu-unavailable" />
          )}
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          Real model inference <strong>on this device</strong>, via WebLLM (browser, WebGPU) or TurboAgent
          (your own server). Model weights must be downloaded once and cached — generation is then fully local.
        </p>

        <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Backend: WebLLM · Hardware: WebGPU</p>
            {webgpu !== null && !webgpu.ok && <Pill status="webgpu-unavailable" />}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            WebGPU:{" "}
            {webgpu === null ? (
              <span className="text-slate-500">checking…</span>
            ) : webgpu.ok ? (
              <span className="font-bold text-emerald-300">available</span>
            ) : (
              <span className="font-bold text-red-300">unavailable ({webgpu.reason ?? "not supported"})</span>
            )}
            {" · "}engine: {engineLoaded ? <span className="font-bold text-emerald-300">loaded</span> : <span className="text-slate-500">not loaded</span>}
            {cachedModel && (
              <>
                {" · "}cache: <span className="font-bold text-emerald-300">{cachedModel} ready offline</span>
              </>
            )}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <select
              value={webllmModel}
              onChange={(e) => setWebllmModel(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-semibold text-white focus:border-sky-500 focus:outline-none"
            >
              {WEBLLM_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.size}
                </option>
              ))}
            </select>
            <button
              onClick={loadWebLLM}
              disabled={loading || !webgpu?.ok}
              className="whitespace-nowrap rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-40"
            >
              {loading ? "Downloading…" : "⬇ Download & load"}
            </button>
          </div>
          {loadProgress && (
            <div className="mt-2">
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-sky-400 transition-all"
                  style={{ width: `${Math.round((loadProgress.progress ?? 0) * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {loadProgress.text} · {Math.round((loadProgress.progress ?? 0) * 100)}% — download is one-time;
                cached after. Download time is reported separately from generation latency.
              </p>
            </div>
          )}
          {loadError && <p className="mt-2 text-xs text-red-300">⚠️ {loadError}</p>}
          <p className="mt-2 text-[11px] leading-4 text-slate-500">
            Server-side pages cannot use WebLLM — it runs only in a WebGPU-capable browser. Server-side requests
            for WebLLM models fall back honestly to the Arena Local Engine with a visible notice.
          </p>
        </div>

        <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Backend: TurboAgent · your server</p>
            <Pill status={turboStatus} />
          </div>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={taUrl}
              onChange={(e) => setTaUrl(e.target.value)}
              placeholder="http://127.0.0.1:7860"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
            />
            <button
              onClick={() => {
                const u = taUrl.trim();
                try {
                  if (u) localStorage.setItem("af_url_turboagent", u);
                  else localStorage.removeItem("af_url_turboagent");
                } catch {}
                runProbes();
              }}
              disabled={probing}
              className="whitespace-nowrap rounded-lg border border-sky-400/30 bg-sky-400/10 px-4 py-2 text-sm font-bold text-sky-200 hover:bg-sky-400/20 disabled:opacity-40"
            >
              Save & test connection
            </button>
          </div>
          <p className="mt-1.5 text-xs">
            {probes.turboagent ? (
              probes.turboagent.status === "connected" ? (
                <span className="text-emerald-300">
                  ✓ Connected — {probes.turboagent.detail}
                  {probes.turboagent.latencyMs !== undefined ? ` · ${probes.turboagent.latencyMs}ms` : ""}
                </span>
              ) : (
                <span className="text-red-300">
                  ✗ {STATUS_LABEL[probes.turboagent.status]} — {probes.turboagent.detail}
                </span>
              )
            ) : (
              <span className="text-slate-500">
                Not configured — start one with <code className="text-slate-400">turboagent serve</code> and
                paste its URL. Requests that can&apos;t reach it fall back visibly to the Arena Local Engine.
              </span>
            )}
          </p>
        </div>
      </section>

      {/* ── LEVEL 2 ──────────────────────────────────────────────────────── */}
      <section className="glass mt-4 rounded-2xl border-amber-400/20 p-5" data-testid="level-remote">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-black text-white">
            LEVEL 2 · <span className="text-amber-300">Remote Model</span>
          </h2>
          {pollinationsStatus ? <Pill status={pollinationsStatus} prefix="POLLINATIONS" /> : <Pill status="unavailable" prefix="UNPROBED" />}
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          Real foundation models (GPT, Mistral, DeepSeek, Claude, Gemini, Llama, Qwen, Grok, Kimi) served free
          via Pollinations, plus optional BYOK OpenRouter/Groq. <strong>Every request leaves this machine</strong>{" "}
          — that is the trade for real model intelligence. If a provider is down, requests fall back{" "}
          <em>visibly</em> to the Arena Local Engine, and ELO never moves on a fallback battle.
        </p>
        <p className="mt-1.5 text-xs">
          {probes.pollinations ? (
            probes.pollinations.status === "connected" ? (
              <span className="text-emerald-300">
                ✓ Pollinations reachable — {probes.pollinations.detail}
                {probes.pollinations.latencyMs !== undefined ? ` · ${probes.pollinations.latencyMs}ms` : ""}
              </span>
            ) : (
              <span className="text-red-300">
                ✗ {STATUS_LABEL[probes.pollinations.status]} — {probes.pollinations.detail}. Remote picks will
                fall back visibly to the Arena Local Engine.
              </span>
            )
          ) : (
            <span className="text-slate-500">Run a live status check to probe the provider.</span>
          )}
        </p>
        <div className="mt-2 text-xs text-slate-500">
          OpenRouter key: {hasOrKey ? "configured (browser-only)" : "not configured"} · Groq key:{" "}
          {hasGroqKey ? "configured (browser-only)" : "not configured"}
        </div>
        <div className="mt-4">
          <KeysBar />
        </div>
      </section>

      {probeNotes.length > 0 && (
        <ul className="mt-4 space-y-1 text-[11px] text-slate-500">
          {probeNotes.map((n, i) => (
            <li key={i}>· {n}</li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-center text-xs text-slate-500">
        Speed/quality labels around the app are <strong>expectations</strong>; the <code>ms</code> on each
        response is <strong>measured</strong>. Download/load times are reported separately from generation
        latency.
      </p>
    </div>
  );
}
