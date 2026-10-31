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
type RegisteredModel = { id: string; name: string; provider: string; description: string; kind?: string };
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
  const [refreshing, setRefreshing] = useState(false);
  const [hostContext, setHostContext] = useState<"checking" | "this-device" | "replit-preview" | "remote">("checking");
  const [manualUrl, setManualUrl] = useState("");
  const [pullFor, setPullFor] = useState<string | null>(null);
  const [pullLog, setPullLog] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/model-hub", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setError(body.error ?? "Model Hub status failed."); return; }
      setStatus(body);
      setError(null);
    } catch {
      setError("Could not check the Arena host for a local runtime. Check the connection and refresh.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    const hostname = window.location.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      setHostContext("this-device");
    } else if (hostname.endsWith(".replit.dev") || hostname.endsWith(".replit.app")) {
      setHostContext("replit-preview");
    } else {
      setHostContext("remote");
    }
  }, []);

  const ollamaRuntime = status?.connections.find((connection) => connection.kind === "ollama" && connection.online)
    ?? status?.discovered.find((connection) => connection.kind === "ollama" && connection.online)
    ?? null;
  const activeRuntimeFound = Boolean(
    status?.connections.some((connection) => connection.online) || status?.discovered.length,
  );
  const installedModelNames = [...new Set([
    ...(status?.connections.filter((connection) => connection.online).flatMap((connection) => connection.models) ?? []),
    ...(status?.discovered.flatMap((connection) => connection.models) ?? []),
  ])];
  const localRegistered = status?.registered.filter((model) => model.provider.toLowerCase().startsWith("local")) ?? [];
  const localGameModels = localRegistered.filter((model) => model.kind === "text");

  let setupStatus = "Checking for a runtime on the Arena host…";
  if (status) {
    if (localRegistered.length > 0) {
      setupStatus = `${localRegistered.length} local model${localRegistered.length === 1 ? "" : "s"} registered. Select one in a room; this status does not prove it can complete a real task.`;
    } else if (installedModelNames.length > 0) {
      setupStatus = "Runtime and model found. Connect the runtime below, then add the model to Arena.";
    } else if (ollamaRuntime) {
      setupStatus = "Ollama is running, but no model is installed yet. Download one below.";
    } else if (activeRuntimeFound) {
      setupStatus = "A runtime is running, but it has no model listed. Load a model in that runtime, then refresh.";
    } else {
      setupStatus = "No local runtime found on the Arena host.";
    }
  }

  const hostExplanation = hostContext === "checking"
    ? "Checking where Arena is running…"
    : hostContext === "this-device"
      ? "Arena is running on this device. Runtime checks and model downloads below use this PC."
      : hostContext === "replit-preview"
        ? "This is a Replit-hosted preview. Runtime checks and model downloads use Replit’s server, not your Windows laptop. To use a model on your laptop, open the installed Arena Windows app and set it up there."
        : "Arena is running on a server separate from this browser. Model Hub checks and downloads on the Arena server, not on this computer.";

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
    if (!ollamaRuntime) {
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
        body: JSON.stringify({ baseUrl: ollamaRuntime.baseUrl, model: tag }),
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
      <h1 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">Connect a model to Arena</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-300">
        Connect a model once, then select it in the room where you want to use it. Runtime connection, model download,
        and choosing a model in Arcade or Spaces are separate steps; each step below shows what is ready.
      </p>
      {error && <p className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-sm text-rose-200" role="alert">{error}</p>}
      {notice && <p className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-sm text-emerald-200" role="status">{notice}</p>}

      <section className="glass mt-5 rounded-2xl border border-cyan-400/20 p-5" aria-labelledby="local-model-setup-title" data-testid="local-model-setup">
        <h2 id="local-model-setup-title" className="text-lg font-extrabold text-white">Start here: set up a local model</h2>
        <p className="mt-1 text-xs leading-5 text-slate-300">
          Arena does not install Ollama or model files automatically. A runtime is the app that runs models; the model is a separate download.
        </p>
        <p
          className={`mt-3 rounded-xl border p-3 text-xs leading-5 ${
            hostContext === "replit-preview"
              ? "border-amber-400/30 bg-amber-400/[0.06] text-amber-100"
              : "border-white/10 bg-black/20 text-slate-300"
          }`}
          role="status"
          data-testid="status-model-host"
        >
          {hostExplanation}
        </p>
        <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3" role="status" data-testid="status-model-setup">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Setup status</span>
          <p className="mt-1 text-sm font-semibold text-white">{setupStatus}</p>
        </div>
        <ol className="mt-4 grid gap-3 text-xs leading-5 text-slate-300 sm:grid-cols-2">
          <li className="rounded-xl border border-white/10 bg-black/15 p-3">
            <b className="text-white">1. Install and open Ollama</b>
            <p className="mt-1">Install it on the same computer that runs Arena, then keep Ollama open. Arena checks that computer’s local service.</p>
            <a className="mt-2 inline-block font-bold text-cyan-200 underline underline-offset-2" href="https://ollama.com/download" target="_blank" rel="noreferrer">
              Get Ollama
            </a>
          </li>
          <li className="rounded-xl border border-white/10 bg-black/15 p-3">
            <b className="text-white">2. Download a model</b>
            <p className="mt-1">Choose a model below after Ollama is found. The listed download size uses disk space on the Arena host; RAM guidance is approximate.</p>
          </li>
          <li className="rounded-xl border border-white/10 bg-black/15 p-3">
            <b className="text-white">3. Add it to Arena</b>
            <p className="mt-1">Connect the detected runtime, then press “Add to Arena” beside an installed model. This makes it available in the room selectors.</p>
          </li>
          <li className="rounded-xl border border-white/10 bg-black/15 p-3">
            <b className="text-white">4. Select and try it</b>
            <p className="mt-1">For a real local-model check, open Arcade and run its temporary game test. It generates code and starts it in an isolated preview; the test is not saved.</p>
            <div className="mt-2 flex gap-3 font-bold text-cyan-200 underline underline-offset-2">
              <a href="/arcade">Open Arcade</a>
              <a href="/spaces">Open Spaces</a>
            </div>
            {localGameModels.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {localGameModels.map((model) => (
                  <a
                    key={model.id}
                    href={`/arcade?testModel=${encodeURIComponent(model.id)}`}
                    className="font-bold text-emerald-200 underline underline-offset-2"
                  >
                    Test {model.name} in Arcade
                  </a>
                ))}
              </div>
            )}
          </li>
        </ol>
      </section>

      {/* ---- Local runtimes ---- */}
      <section className="glass mt-6 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-extrabold text-white">🦙 Local runtimes</h2>
          <button
            onClick={() => void refresh()}
            disabled={refreshing}
            data-testid="button-refresh-model-hub"
            className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-50"
          >
            {refreshing ? "Checking…" : "Refresh runtime status"}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Connect a local runtime such as Ollama, LM Studio, or llama.cpp. “Local” means local to the Arena server shown above; a browser preview cannot reach a model running only on another computer.
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
                  data-testid={`button-disconnect-runtime-${connection.id}`}
                  className="rounded-lg bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10">
                  Disconnect runtime
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
                        data-testid={`button-register-model-${model.replace(/[^a-z0-9]+/gi, "-")}`}
                        title={registered ? `Remove ${model} from Arena` : `Add ${model} to Arena so it can be selected in rooms`}
                        className={`rounded-lg px-2.5 py-1 text-[11px] font-bold ring-1 ${registered ? "bg-emerald-400/15 text-emerald-200 ring-emerald-400/30" : "bg-white/5 text-slate-200 ring-white/10 hover:bg-white/10"}`}>
                        {registered ? `✓ Added · ${model}` : `+ Add ${model} to Arena`}
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
                data-testid={`button-connect-runtime-${found.kind}`}
                className="rounded-lg bg-cyan-500/15 px-3 py-1.5 text-xs font-bold text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25">
                {busy === `conn-${found.baseUrl}` ? "Connecting…" : "Connect runtime"}
              </button>
            </div>
          ))}
          {status && status.connections.length === 0 && status.discovered.length === 0 && (
            <p className="rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-3 text-xs leading-5 text-amber-200">
              No runtime found on the Arena host’s default ports (11434 · 1234 · 8080). Install and open Ollama on that host, then use “Refresh runtime status”.
            </p>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <input value={manualUrl} onChange={(event) => setManualUrl(event.target.value)} placeholder="http://127.0.0.1:11434" aria-label="Local runtime URL" data-testid="input-runtime-url"
            className="w-64 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600" />
          <button onClick={() => { if (manualUrl.trim() !== "") void act({ action: "connect", baseUrl: manualUrl.trim() }, "conn-manual", "Runtime connected."); }}
            disabled={busy !== null || manualUrl.trim() === ""} data-testid="button-connect-runtime-url" className="rounded-lg bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-50">
            {busy === "conn-manual" ? "Connecting…" : "Connect runtime"}
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
        <p className="mt-1 text-xs text-slate-400">
          These are separate downloads stored by Ollama on the Arena host. Check the approximate disk size and RAM guidance before downloading; the pull streams live progress.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {status?.catalog.map((entry) => (
            <div key={entry.tag} className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold text-white">{entry.name}</p>
                <span className="font-mono text-[10px] text-slate-500">~{entry.sizeGb} GB · {entry.minRamGb} GB RAM class</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">{entry.description}</p>
              <button onClick={() => void pull(entry.tag)} disabled={pullFor !== null || !ollamaRuntime}
                data-testid={`button-model-pull-${entry.tag.replace(/[^a-z0-9]+/gi, "-")}`}
                title={!ollamaRuntime ? "Start Ollama on the Arena host, then refresh runtime status." : `Download ${entry.name} to the Arena host.`}
                className="mt-2 rounded-lg bg-violet-600/20 px-3 py-1.5 text-xs font-bold text-violet-200 ring-1 ring-violet-400/30 hover:bg-violet-600/30 disabled:opacity-50">
                {pullFor === entry.tag ? "Downloading…" : ollamaRuntime ? `Download ${entry.tag}` : "Start Ollama first"}
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
