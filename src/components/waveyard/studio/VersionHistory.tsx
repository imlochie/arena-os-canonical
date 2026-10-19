"use client";

import { useEffect, useState } from "react";
import type { RemixVersionSummary } from "./types";

type ExportJob = { id: string; status: string; stage: string; format: string; errorMessage?: string | null };
function VersionExport({ version }: { version: RemixVersionSummary }) {
  const [job, setJob] = useState<ExportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 300000;
    async function poll() {
      try {
        const response = await fetch(`/api/remix-versions/${version.id}/exports`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.exports)) throw new Error(body.error ?? "Could not retrieve this version's exports.");
        if (!alive) return;
        const latest: ExportJob | undefined = body.exports.filter((entry: ExportJob) => entry.format === "wav").at(-1);
        setJob(latest ?? null); setError(null); setLoading(false);
        if (latest && !["complete", "failed", "cancelled"].includes(latest.status)) {
          if (Date.now() < deadline) timer = setTimeout(() => void poll(), 1500);
          else setError("Export is still processing. Refresh status to keep following the durable job.");
        }
      } catch (error) { if (alive) { setLoading(false); setError(error instanceof Error ? error.message : "Export status unavailable."); } }
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [version.id, refresh]);
  async function request() {
    setBusy(true); setError(null);
    try {
      const retry = job?.status === "failed";
      const response = await fetch(retry ? `/api/exports/${job.id}/retry` : `/api/remix-versions/${version.id}/exports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "wav" }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Export could not be queued.");
      setJob(body.job); setRefresh((value) => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : "Export failed."); }
    finally { setBusy(false); }
  }
  const active = job && !["complete", "failed", "cancelled"].includes(job.status);
  return <div className="version-export" aria-label={`Export ${version.name}`}>
    {job?.status === "complete" ? <a className="button" href={`/api/exports/${job.id}/media?download=1`}>Download WAV · {version.name}</a> : <button className="button secondary" disabled={busy || loading || Boolean(active)} onClick={() => void request()}>{busy ? "Requesting export…" : job?.status === "failed" ? `Retry WAV · ${version.name}` : active ? `Exporting · ${job.stage}` : `Export WAV · ${version.name}`}</button>}
    {job && <small>WAV: {job.status} · {job.stage} · immutable version</small>}
    {(error || job?.errorMessage) && <p role="alert">{error || job?.errorMessage}</p>}
    {error && <button className="button secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh export status</button>}
  </div>;
}

export function VersionHistory({ versions, onRestore }: { versions: RemixVersionSummary[]; onRestore: (id: string) => void }) {
  if (!versions.length) return null;
  return <div className="versions"><b>Versions · immutable WAV exports</b>{versions.map((version) => <section key={version.id}><button className="button secondary" onClick={() => onRestore(version.id)}>{version.name}</button><VersionExport version={version} /></section>)}</div>;
}
