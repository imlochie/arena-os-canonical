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

/**
 * AI Runtime — the three tiers, their honest status, and opt-in configuration.
 * Nothing here is required: the Local Engine tier works immediately with zero config.
 */

type RemoteStatus = "unknown" | "testing" | "reachable" | "unavailable";
type TurboStatus = "unknown" | "unconfigured" | "testing" | "reachable" | "unavailable";

export default function RuntimePage() {
  // ── Local LLM tier state ────────────────────────────────────────────────
  const [webgpu, setWebgpu] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [engineLoaded, setEngineLoaded] = useState(false);
  const [engineModel, setEngineModel] = useState<string | null>(null);
  const [cachedModel, setCachedModel] = useState<string | null>(null);
  const [webllmModel, setWebllmModel] = useState(WEBLLM_MODELS[0]?.id ?? "");
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── TurboAgent state ────────────────────────────────────────────────────
  const [taUrl, setTaUrl] = useState("");
  const [taStatus, setTaStatus] = useState<TurboStatus>("unconfigured");
  const [taDetail, setTaDetail] = useState<string>("");

  // ── Remote tier state ───────────────────────────────────────────────────
  const [remote, setRemote] = useState<RemoteStatus>("unknown");
  const [hasOrKey, setHasOrKey] = useState(false);
  const [hasGroqKey, setHasGroqKey] = useState(false);

  useEffect(() => {
    checkWebGPU().then(setWebgpu);
    setEngineLoaded(isEngineLoaded());
    setEngineModel(loadedModelId());
    setCachedModel(modelReadyOffline());
    try {
      setTaUrl(localStorage.getItem("af_url_turboagent") ?? "");
      if (localStorage.getItem("af_url_turboagent")) setTaStatus("unknown");
      setHasOrKey(!!localStorage.getItem("af_key_openrouter"));
      setHasGroqKey(!!localStorage.getItem("af_key_groq"));
    } catch {}
  }, []);

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

  async function testTurboAgent() {
    const url = taUrl.trim();
    if (!url) return;
    localStorage.setItem("af_url_turboagent", url);
    setTaStatus("testing");
    setTaDetail("");
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${url.replace(/\/$/, "")}/v1/models`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        setTaStatus("reachable");
        const j = await res.json().catch(() => null);
        const n = Array.isArray(j?.data) ? j.data.length : "?";
        setTaDetail(`HTTP ${res.status} · ${n} model(s) listed`);
      } else {
        setTaStatus("unavailable");
        setTaDetail(`HTTP ${res.status}`);
      }
    } catch (e: any) {
      setTaStatus("unavailable");
      setTaDetail(e?.name === "AbortError" ? "timeout after 5s" : (e?.message ?? "connection failed"));
    }
  }

  async function testRemote() {
    setRemote("testing");
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      await fetch("https://text.pollinations.ai/", { mode: "no-cors", signal: ctrl.signal });
      clearTimeout(t);
      setRemote("reachable");
    } catch {
      setRemote("unavailable");
    }
  }

  const statusPill = (tone: "ready" | "warn" | "bad" | "idle", label: string) => (
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
      {label}
    </span>
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-3xl font-black text-white">⚙️ AI Runtime</h1>
      <p className="mt-2 text-sm text-slate-400">
        Three tiers, honestly labelled. <strong className="text-slate-200">Works immediately</strong> with the
        Local Engine — upgrade the intelligence when you want.
      </p>

      {/* ── LOCAL ENGINE ─────────────────────────────────────────────────── */}
      <section className="glass mt-6 rounded-2xl border-emerald-400/20 p-5" data-testid="tier-local-engine">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-black text-white">⚙️ Local Engine</h2>
          {statusPill("ready", "READY — zero config")}
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          A deterministic offline engine — <strong>not an LLM</strong>. It produces structured responses from
          heuristics: term extraction, templating, synthesis, and judging. It never runs a foundation model and
          never lists one.
        </p>
        <ul className="mt-2 grid gap-1 text-xs text-slate-400 sm:grid-cols-3">
          <li>🔒 No network egress</li>
          <li>🔑 No keys</li>
          <li>⚡ Instant, no download</li>
        </ul>
      </section>

      {/* ── LOCAL LLM ────────────────────────────────────────────────────── */}
      <section className="glass mt-4 rounded-2xl border-sky-400/20 p-5" data-testid="tier-local-llm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-black text-white">💻 Local LLM</h2>
          {engineLoaded
            ? statusPill("ready", `RUNNING — ${engineModel}`)
            : webgpu === null
              ? statusPill("idle", "checking…")
              : webgpu.ok
                ? statusPill("idle", "NOT LOADED — download required")
                : statusPill("bad", "UNAVAILABLE — no WebGPU")}
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          Real model inference <strong>on this device</strong>, via WebLLM (browser, WebGPU) or TurboAgent (your
          own server). Model weights must be downloaded once and cached — generation is then fully local.
        </p>

        <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">WebLLM (in-browser)</p>
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
                cached after.
              </p>
            </div>
          )}
          {loadError && <p className="mt-2 text-xs text-red-300">⚠️ {loadError}</p>}
          <p className="mt-2 text-[11px] leading-4 text-slate-500">
            Server-side pages cannot use WebLLM — it runs only in a WebGPU-capable browser. Server-side requests
            for WebLLM models fall back honestly to the Local Engine with a visible notice.
          </p>
        </div>

        <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">TurboAgent (your server)</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={taUrl}
              onChange={(e) => {
                setTaUrl(e.target.value);
                setTaStatus(e.target.value.trim() ? "unconfigured" : "unconfigured");
              }}
              placeholder="http://127.0.0.1:7860"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
            />
            <button
              onClick={testTurboAgent}
              disabled={!taUrl.trim() || taStatus === "testing"}
              className="whitespace-nowrap rounded-lg border border-sky-400/30 bg-sky-400/10 px-4 py-2 text-sm font-bold text-sky-200 hover:bg-sky-400/20 disabled:opacity-40"
            >
              {taStatus === "testing" ? "Testing…" : "Test connection"}
            </button>
          </div>
          <p className="mt-1.5 text-xs">
            {taStatus === "reachable" ? (
              <span className="text-emerald-300">✓ Reachable — {taDetail}</span>
            ) : taStatus === "unavailable" ? (
              <span className="text-red-300">✗ Unavailable — {taDetail}</span>
            ) : taStatus === "testing" ? (
              <span className="text-slate-400">Testing…</span>
            ) : (
              <span className="text-slate-500">
                Not configured — start one with <code className="text-slate-400">turboagent serve</code> and paste
                its URL. Requests that can&apos;t reach it fall back visibly to the Local Engine.
              </span>
            )}
          </p>
        </div>
      </section>

      {/* ── REMOTE FREE ──────────────────────────────────────────────────── */}
      <section className="glass mt-4 rounded-2xl border-amber-400/20 p-5" data-testid="tier-remote-free">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-black text-white">☁️ Remote Free Models</h2>
          {remote === "reachable"
            ? statusPill("ready", "REACHABLE")
            : remote === "unavailable"
              ? statusPill("bad", "UNAVAILABLE — will fall back")
              : remote === "testing"
                ? statusPill("warn", "testing…")
                : statusPill("idle", "UNKNOWN — test to check")}
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          Real foundation models (GPT, Mistral, DeepSeek, Claude, Gemini, Llama, Qwen, Grok, Kimi) served free
          via Pollinations, plus optional BYOK OpenRouter/Groq. <strong>Every request leaves this machine</strong>{" "}
          — that is the trade for real model intelligence. If a provider is down, requests fall back{" "}
          <em>visibly</em> to the Local Engine.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={testRemote}
            disabled={remote === "testing"}
            className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-sm font-bold text-amber-200 hover:bg-amber-400/20 disabled:opacity-40"
          >
            {remote === "testing" ? "Testing…" : "Test Pollinations reachability"}
          </button>
          <span className="text-xs text-slate-500">
            OpenRouter key: {hasOrKey ? "configured" : "not configured"} · Groq key:{" "}
            {hasGroqKey ? "configured" : "not configured"}
          </span>
        </div>
        <div className="mt-4">
          <KeysBar />
        </div>
      </section>

      <p className="mt-6 text-center text-xs text-slate-500">
        Latency labels shown around the app are <strong>expectations</strong>, except the{" "}
        <code>ms</code> reported per response, which is measured.
      </p>
    </div>
  );
}
