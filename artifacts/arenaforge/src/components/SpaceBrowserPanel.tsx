"use client";

import { useEffect, useState } from "react";

interface BrowserObservation {
  url: string;
  title: string;
  text: string;
  screenshotFile: string;
  capturedAt: string;
}

export default function SpaceBrowserPanel({ spaceId }: { spaceId: string }) {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<BrowserObservation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/spaces/${spaceId}/browser`;

  useEffect(() => {
    let alive = true;
    fetch(endpoint, { cache: "no-store" })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not load browser state");
        if (alive && data.state) {
          setState(data.state);
          setUrl(data.state.url);
        }
      })
      .catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [endpoint]);

  async function openPage() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not open page");
      setState(data.state);
      setUrl(data.state.url);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not open page");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-3 rounded-xl bg-black/20 p-3 ring-1 ring-white/10" aria-label="Workspace browser">
      <h3 className="text-sm font-extrabold text-white">Workspace browser</h3>
      <p className="mt-1 text-[11px] text-slate-400">Open and inspect a page here. No AI connection is needed for this control.</p>
      <form
        className="mt-2 flex flex-wrap gap-2"
        onSubmit={event => { event.preventDefault(); void openPage(); }}
      >
        <input
          type="url"
          required
          aria-label="Page URL"
          value={url}
          onChange={event => setUrl(event.target.value)}
          placeholder="https://"
          className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/60"
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="rounded-lg bg-cyan-500/20 px-4 py-2 text-sm font-bold text-cyan-100 ring-1 ring-cyan-400/30 disabled:opacity-40"
        >
          {busy ? "Opening page…" : "Open page"}
        </button>
      </form>
      {error && <p role="alert" className="mt-2 break-words text-xs text-red-300">{error}</p>}
      {state && (
        <div className="mt-3">
          <p className="text-xs font-bold text-white">{state.title || state.url}</p>
          <p className="mt-0.5 break-all text-[11px] text-slate-400">Last capture · {new Date(state.capturedAt).toLocaleString()} · {state.url}</p>
          <a href={`${endpoint}?image=${encodeURIComponent(state.screenshotFile)}`} target="_blank" rel="noreferrer">
            <img
              src={`${endpoint}?image=${encodeURIComponent(state.screenshotFile)}`}
              alt={`Last browser capture: ${state.title || state.url}`}
              className="mt-2 max-h-80 w-full rounded-lg border border-white/10 object-contain object-top"
            />
          </a>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-bold text-cyan-200">Read captured page text</summary>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3 text-xs text-slate-300">{state.text}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
