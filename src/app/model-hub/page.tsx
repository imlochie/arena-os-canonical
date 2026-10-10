"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Model Hub — download and connect AI models to the entire app.
 *
 * Three connection paths, all honestly labeled:
 *   1. LOCAL: an Ollama / LM Studio / llama.cpp server on this machine —
 *      auto-detected, models registered app-wide (chat, battles, council),
 *      downloadable through the Ollama pull catalog.
 *   2. CLOUD: keyless Pollinations (the default remote route), free-tier
 *      BYOK keys (OpenRouter/Groq/OpenAI) via the keys bar, provider env
 *      keys for the Waveyard AI studio.
 *   3. AGENT: the agent bridge — you or an AI agent session answer the app
 *      through scripts/agent-bridge.mjs.
 */

type Connection = {
  id: string; kind: string; baseUrl: string; label: string;
  online: boolean; models: string[]; detail: string;
};
type Discovered = { kind: string; baseUrl: string; online: boolean; models: string[]; detail: string };
type CatalogEntry = { tag: string; name: string; sizeGb: number; minRamGb: number; description: string };
type RegisteredModel = { id: string; name: string; provider: string; description: string };
type HubStatus = {
  connections: Connection[];
  discovered: Discovered[];
  catalog: CatalogEntry[];
  registered: RegisteredModel[];
  agentBridge: { connected: boolean; name: string | null; lastPolledAt: string | null };
};

export default function ModelHubPage() {
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const [pullFor, setPullFor] = useState<string | null>(null);
  const [pullLog, setPullLog] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/model-hub", { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setError(body.error ?? "Model Hub status failed."); return; }
    setStatus(body);
    setError(null);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  const act = async (payload: Record<string, unknown>, key: string, success?: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/model-hub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setError(body.error ?? "The action failed."); return null; }
      if (success) setNotice(success);
      await refresh();
      return body;
    } finally {
      setBusy(null);
    }
  };

  const pull = async (tag: string) => {
    const ollama = status?.connections.find((c) => c.kind === "ollama" && c.online)
      ?? status?.discovered.find((c) => c.kind === "ollama");
    if (!ollama) {
      setError("Downloading needs a connected Ollama runtime (install from ollama.com, then `ollama serve`).");
      return;
    }
    setPullFor(tag);
    setPullLog([`pulling ${tag}…`]);
    abortRef.current = new AbortController();
    try {
      const response = await fetch("/api/model-hub/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: ollama.baseUrl, model: tag }),
        signal: abortRef.current.signal,
      });
      if (!response.ok || response.body === null) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? "The pull failed to start.");
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            const progress = typeof event.completed === "number" && typeof event.total === "number" && event.total > 0
              ? ` (${Math.round((event.completed / event.total) * 100)}%)` : "";
            setPullLog((current) => [...current.slice(-6), `${event.status ?? "…"}${progress}`]);
          } catch { /* partial line */ }
        }
      }
      setPullLog((current) => [...current.slice(-6), "done — the model is installed and can be connected above."]);
      await refresh();
    } catch (pullError) {
      if (!(pullError instanceof DOMException && pullError.name === "AbortError")) {
        setError(pullError instanceof Error ? pullError.message : "The pull failed.");
      }
    } finally {
      setPullFor(null);
      abortRef.current = null;
    }
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <p className="inline-flex items-center gap-2 rounded-full border border-violet-400/30 bg-violet-400/10 px-4 py-1.5 text-xs font-bold text-violet-200">
        🧰 Model Hub · download & connect models
      </p>
      <h1 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">Every brain, one place.</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-300">
        Connect local runtimes (Ollama, LM Studio, llama.cpp) and their models become selectable{" "}
        <strong>everywhere in the app</strong> — chat, battles, council, collab. Download models straight from here.
        Or bridge an agent, or paste a cloud key. Everything states what actually runs.
      </p>
      {error && <p className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-sm text-rose-200" role="alert">{error}</p>}
      {notice && <p className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-sm text-emerald-200" role="status">{notice}</p>}

      {/* ---- Local runtimes ---- */}
      <section className="glass mt-6 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">🦙 Local runtimes</h2>
        <p className="mt-1 text-xs text-slate-400">
          Install <a className="font-bold text-cyan-200" href="https://ollama.com" target="_blank" rel="noreferrer">Ollama</a> (free, ~1&nbsp;GB) or run LM&nbsp;Studio / llama.cpp — then connect here. Loopback only; nothing leaves this machine.
        </p>
        <div className="mt-3 space-y-2">
          {status?.connections.map((connection) => (
            <div key={connection.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-white">
                    {connection.label} <span className="font-mono text-[11px] font-normal text-slate-500">{connection.baseUrl}</span>
                  </p>
                  <p className="text-xs text-slate-400">{connection.online ? connection.detail : "offline — start the runtime and refresh"}</p>
                </div>
                <button onClick={() => void act({ action: "disconnect", connectionId: connection.id }, `disc-${connection.id}`, "Runtime disconnected; its models were removed from the app.")}
                  className="rounded-lg bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10">
                  disconnect
                </button>
              </div>
              {connection.online && connection.models.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {connection.models.map((model) => {
                    const registered = status.registered.some((r) => r.name.startsWith(`${model} (`));
                    return (
                      <button key={model}
                        onClick={() => void act({ action: registered ? "unregister" : "register", connectionId: connection.id, remoteModel: model, modelId: status.registered.find((r) => r.name.startsWith(`${model} (`))?.id }, `reg-${model}`,
                          registered ? "Model removed from the app." : `"${model}" is now selectable app-wide.`)}
                        className={`rounded-lg px-2.5 py-1 text-[11px] font-bold ring-1 ${registered ? "bg-emerald-400/15 text-emerald-200 ring-emerald-400/30" : "bg-white/5 text-slate-200 ring-white/10 hover:bg-white/10"}`}>
                        {registered ? "✓ " : "+ "}{model}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {status?.discovered.map((found) => (
            <div key={found.baseUrl} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.04] p-3">
              <div>
                <p className="text-sm font-bold text-white">Discovered: {found.kind} <span className="font-mono text-[11px] font-normal text-slate-500">{found.baseUrl}</span></p>
                <p className="text-xs text-slate-400">{found.detail}</p>
              </div>
              <button onClick={() => void act({ action: "connect", baseUrl: found.baseUrl }, `conn-${found.baseUrl}`, "Runtime connected.")}
                className="rounded-lg bg-cyan-500/15 px-3 py-1.5 text-xs font-bold text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25">
                {busy === `conn-${found.baseUrl}` ? "connecting…" : "connect"}
              </button>
            </div>
          ))}
          {status && status.connections.length === 0 && status.discovered.length === 0 && (
            <p className="rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-3 text-xs leading-5 text-amber-200">
              No local runtime found on the default ports (11434 · 1234 · 8080). Install Ollama and run <code className="rounded bg-black/40 px-1">ollama serve</code>, or add a URL below.
            </p>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <input value={manualUrl} onChange={(event) => setManualUrl(event.target.value)} placeholder="http://127.0.0.1:11434"
            className="w-64 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600" />
          <button onClick={() => { if (manualUrl.trim() !== "") void act({ action: "connect", baseUrl: manualUrl.trim() }, "conn-manual", "Runtime connected."); }}
            disabled={busy !== null} className="rounded-lg bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-50">
            {busy === "conn-manual" ? "connecting…" : "connect URL"}
          </button>
        </div>
        {status && status.registered.length > 0 && (
          <p className="mt-3 text-xs text-slate-400">
            Registered app-wide: {status.registered.map((r) => r.name).join(" · ")}
          </p>
        )}
      </section>

      {/* ---- Download models (Ollama) ---- */}
      <section className="glass mt-4 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">⬇️ Download models</h2>
        <p className="mt-1 text-xs text-slate-400">Curated Ollama library tags with honest sizes. Pulling streams real progress from the runtime.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {status?.catalog.map((entry) => (
            <div key={entry.tag} className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold text-white">{entry.name}</p>
                <span className="font-mono text-[10px] text-slate-500">~{entry.sizeGb} GB · {entry.minRamGb} GB RAM class</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">{entry.description}</p>
              <button onClick={() => void pull(entry.tag)} disabled={pullFor !== null}
                className="mt-2 rounded-lg bg-violet-600/20 px-3 py-1.5 text-xs font-bold text-violet-200 ring-1 ring-violet-400/30 hover:bg-violet-600/30 disabled:opacity-50">
                {pullFor === entry.tag ? "downloading…" : `pull ${entry.tag}`}
              </button>
              {pullFor === entry.tag && (
                <div className="mt-2 rounded-lg bg-black/40 p-2 font-mono text-[10px] leading-4 text-slate-400">
                  {pullLog.map((line, index) => <p key={index}>{line}</p>)}
                  <button onClick={() => abortRef.current?.abort()} className="mt-1 text-rose-300 underline">cancel</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ---- Agent bridge ---- */}
      <section className="glass mt-4 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">🛰️ Agent bridge — wire an agent in</h2>
        <p className="mt-1 text-xs leading-5 text-slate-400">
          Select the <strong className="text-slate-200">Arena Agent (bridge)</strong> model anywhere in the app and answer its prompts from your terminal —
          or let an AI agent session answer through a command. Every answer is labeled <code className="rounded bg-black/40 px-1">agent-bridge</code>, never as a language model.
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 p-2.5 font-mono text-[11px] leading-4 text-slate-300">node scripts/agent-bridge.mjs{"\n"}node scripts/agent-bridge.mjs --command &quot;your-agent-command&quot;</pre>
        <p className="mt-2 text-xs">
          {status?.agentBridge.connected
            ? <span className="font-bold text-emerald-300">● bridge connected ({status.agentBridge.name}) — prompts will be answered.</span>
            : <span className="text-slate-500">○ no bridge connected — selecting the model falls back visibly until one runs.</span>}
        </p>
      </section>

      {/* ---- Cloud & keys ---- */}
      <section className="glass mt-4 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">☁️ Cloud & keys</h2>
        <ul className="mt-2 space-y-2 text-xs leading-5 text-slate-300">
          <li><strong className="text-white">Free, no key:</strong> Pollinations is the built-in default remote route — every remote model (GPT, Mistral, DeepSeek…) already answers through it when the network allows.</li>
          <li><strong className="text-white">Free tiers (BYOK):</strong> paste OpenRouter / Groq keys in the keys bar on Chat or Benchmark — stored only in your browser.</li>
          <li><strong className="text-white">ChatGPT subscription:</strong> a ChatGPT Plus/Pro plan <em>cannot</em> be used as an API — OpenAI bills the API separately. To use OpenAI models, add pay-as-you-go credits and paste the resulting key in the keys bar (routed as <code className="rounded bg-black/40 px-1">openai:gpt-4o-mini</code>). For everything else, the free routes above need no subscription at all.</li>
          <li><strong className="text-white">Server-side providers:</strong> the Waveyard AI studio reads OPENAI_API_KEY / ANTHROPIC_API_KEY from the environment (see .env.example).</li>
        </ul>
      </section>
    </main>
  );
}
