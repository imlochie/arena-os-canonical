"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * App Foundry — describe an app, get a real one (vibe coding, Arena-style).
 * Previews run in a sandboxed iframe (allow-scripts, NO same-origin) with an
 * injected no-network CSP; every version shows the engine that wrote it.
 * Local Engine → honest offline scaffold; a bigger brain → the real build.
 */

type App = { id: string; name: string; versionCount?: number; updatedAt: string };
type Version = { id: string; version: number; prompt: string; code: string; engine: string; via: string; fallback: boolean };

const keys = () => ({
  elevenlabs: localStorage.getItem("af_key_elevenlabs") || undefined,
  groq: localStorage.getItem("af_key_groq") || undefined,
  openai: localStorage.getItem("af_key_openai") || undefined,
  openrouter: localStorage.getItem("af_key_openrouter") || undefined,
  mistral: localStorage.getItem("af_key_mistral") || undefined,
});

const input =
  "w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none";
const button =
  "rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50";

export default function FoundryPage() {
  const [apps, setApps] = useState<App[]>([]);
  const [current, setCurrent] = useState<{ id: string; name: string } | null>(null);
  const [version, setVersion] = useState<Version | null>(null);
  const [description, setDescription] = useState("");
  const [change, setChange] = useState("");
  const [needsReload, setNeedsReload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Full-stack bridge: the sandboxed app (no network, no same-origin) asks us
  // over postMessage; we proxy to its strictly scoped /data API and reply.
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const data = event.data as { __arena?: string; requestId?: string; op?: string; key?: string; value?: string } | null;
      if (!data || data.__arena !== "request" || !current?.id || !data.requestId) return;
      if (event.source !== iframeRef.current?.contentWindow) return; // only our preview
      const appId = current.id;
      let result: unknown = { ok: false, error: "bridge error" };
      try {
        if (data.op === "get") {
          const response = await fetch(`/api/foundry/${appId}/data?key=${encodeURIComponent(String(data.key ?? ""))}`);
          const body=await response.json(); if(!response.ok)throw new Error(body.error??"App storage read failed; no empty value was substituted."); result=body.value??null;
        } else if (data.op === "set") {
          const response = await fetch(`/api/foundry/${appId}/data`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: data.key, value: data.value }),
          });
          result = response.ok ? { ok: true } : { ok: false, error: (await response.json()).error };
        } else if (data.op === "del") {
          const response = await fetch(`/api/foundry/${appId}/data?key=${encodeURIComponent(String(data.key ?? ""))}`, { method: "DELETE" });
          result = { ok: response.ok };
        } else if (data.op === "keys") {
          const response = await fetch(`/api/foundry/${appId}/data`);
          const body=await response.json(); if(!response.ok||!Array.isArray(body.keys))throw new Error(body.error??"App storage listing failed; no empty library was substituted."); result=body.keys;
        }
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : "bridge error" };
      }
      if(event.source!==iframeRef.current?.contentWindow)return; // stale app/version response
      (event.source as Window | null)?.postMessage({ __arena: "response", requestId: data.requestId, result }, "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [current]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/foundry");
      const data = await response.json();
      if(!response.ok||!Array.isArray(data.apps))throw new Error(data.error??"App library unavailable. Existing apps were not removed; retry."); setApps(data.apps);
    } catch(error) { setError(error instanceof Error?error.message:"App library unavailable. Retry."); }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openApp = useCallback(async (id: string, keepChange = false) => {
    setBusy(true);
    setError(null);
    try {
    const response = await fetch("/api/foundry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", appId: id }),
    });
    if (!response.ok) {
      const body = await response.json();
      setError(body.error ?? "App retrieval was not acknowledged; current preview retained.");
      return;
    }
    const data = await response.json();
    setCurrent({ id: data.app.id, name: data.app.name });
    setVersion(data.app.latest ?? null);
    setShowCode(false);
    if (!keepChange) setChange("");
    setNeedsReload(false);
    }catch(error){setError(error instanceof Error?error.message:"App retrieval unavailable. Current version retained; retry.");}finally{setBusy(false);}
  }, []);

  const create = useCallback(async () => {
    if (!description.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/foundry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", description, keys: keys() }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      setCurrent({ id: data.app.id, name: data.app.name });
      setVersion(data.app.latest ?? null);
      setDescription("");
      setShowCode(false);
      refresh();
    } catch(error) { setError(error instanceof Error?error.message:"App operation not acknowledged. Retained version unchanged; retry."); } finally {
      setBusy(false);
    }
  }, [description, busy, refresh]);

  const iterate = useCallback(async () => {
    if (!current || !version || !change.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/foundry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "iterate", appId: current.id, change, expectedVersionId: version.id, keys: keys() }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) setNeedsReload(true);
        setError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      setNeedsReload(false);
      setVersion(data.version ?? null);
      setChange("");
      refresh();
    } catch(error) { setError(error instanceof Error?error.message:"App operation not acknowledged. Retained version unchanged; retry."); } finally {
      setBusy(false);
    }
  }, [current, version, change, busy, refresh]);

  const remove = useCallback(async () => {
    if (!current || busy) return;
    setBusy(true);setError(null);
    try {
      const response=await fetch("/api/foundry",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"delete",appId:current.id})});
      const body=await response.json();if(!response.ok||body.removed!==true)throw new Error(body.error??"Deletion was not acknowledged. Current app retained; refresh before retrying.");
      setCurrent(null);setVersion(null);await refresh();
    }catch(error){setError(error instanceof Error?error.message:"Deletion not acknowledged. Current app unchanged; retry.");}finally{setBusy(false);}
  }, [current, busy, refresh]);

  return (
    <main className="mx-auto flex max-w-7xl gap-6 px-6 py-10">
      <aside className="w-64 shrink-0">
        <h1 className="text-xl font-black text-white">App Foundry</h1>
        <p className="mt-1 text-[11px] leading-4 text-slate-500">
          Describe it → get it. Runs sandboxed with resource-fetch restrictions, version by version. The engine label on every build is the truth.
        </p>
        <p className="text-xs text-amber-200">Generated apps are untrusted. Do not provide credentials or secrets. Sandbox/CSP resource restrictions are not a general navigation/network firewall.</p>
        <button
          className="mt-4 w-full rounded-lg border border-violet-500/40 px-3 py-2 text-sm font-semibold text-violet-300 hover:bg-violet-500/10"
          disabled={busy}
          onClick={() => {
            setCurrent(null);
            setVersion(null);
            setNeedsReload(false);
            setChange("");
          }}
        >
          + New app
        </button>
        <button disabled={busy} onClick={()=>void refresh()} className="mt-3 text-xs text-violet-300">Refresh apps</button>
        <ul className="mt-4 space-y-1">
          {apps.map((app) => (
            <li key={app.id}>
              <button
                className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm ${current?.id === app.id ? "bg-violet-600/20 text-white" : "text-slate-400 hover:bg-white/5"}`}
                disabled={busy}
                onClick={() => void openApp(app.id)}
                title={app.name}
              >
                {app.name} <span className="text-[10px] text-slate-500">v{app.versionCount}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="min-w-0 flex-1">
        {error && <p role="alert" className="mb-3 text-sm text-rose-400">{error}</p>}
        {needsReload && current && <button className={button} disabled={busy} onClick={() => void openApp(current.id, true)}>Load latest, keep change</button>}
        {!current && !version && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
            <h2 className="text-lg font-bold text-white">What should it be?</h2>
            <p className="mt-1 text-xs text-slate-400">
              One paragraph. &ldquo;A pomodoro timer with a big start button and session log.&rdquo; With only the Local Engine you get an honest
              offline scaffold; add a key or connect a hub model for the real build.
            </p>
            <textarea
              className={`${input} mt-4 h-28`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the app you want…"
            />
            <button className={`${button} mt-3`} onClick={create} disabled={busy || !description.trim()}>
              {busy ? "Building…" : "Build v1"}
            </button>
          </div>
        )}

        {version && current && (
          <div className="flex h-full flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-bold text-white">{current.name}</h2>
              <span className="rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-slate-400">
                v{version.version} · {version.via}
                {version.fallback ? " · offline scaffold" : ""}
              </span>
              <div className="ml-auto flex gap-2">
                <button className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5" onClick={() => setShowCode(!showCode)}>
                  {showCode ? "Preview" : "Code"}
                </button>
                <button
                  className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
                  onClick={() => {
                    const blob = new Blob([version.code], { type: "text/html" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${current.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v${version.version}.html`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  Download
                </button>
                <button className="rounded-lg border border-rose-500/30 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10" onClick={remove}>
                  Delete
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/40 p-1">
              {showCode ? (
                <pre className="max-h-[60vh] overflow-auto p-4 text-[11px] leading-4 text-slate-300">{version.code}</pre>
              ) : (
                <iframe
                  key={`${current.id}:${version.version}`}
                  ref={iframeRef}
                  title={`${current.name} preview`}
                  sandbox="allow-scripts allow-forms allow-modals"
                  srcDoc={version.code}
                  className="h-[60vh] w-full rounded-xl border-0 bg-white"
                />
              )}
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Change something</label>
              <div className="mt-2 flex gap-2">
                <input
                  className={input}
                  value={change}
                  onChange={(e) => setChange(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && iterate()}
                  placeholder="e.g. add a dark/light toggle and persist the count"
                />
                <button className={button} onClick={iterate} disabled={busy || !change.trim()}>
                  {busy ? "…" : `Build v${version.version + 1}`}
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                v{version.version} prompt: {version.prompt.slice(0, 140)}
              </p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
