"use client";

import { useEffect, useState } from "react";
import { StemMixer } from "./StemMixer";

type ProjectData = {
  project: { title: string; description: string; licenseCode: string; visibility: string };
  stems: any[];
  jobs: Array<{ id: string; status: string; stage: string; errorMessage: string | null; model: string; requestedDevice: string; resolvedDevice: string | null }>;
  sources: any[];
};

export function ProjectWorkspace({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(json.error ?? "Project could not be opened.");
        return;
      }
      setData(json);
      const active = json.jobs?.some((job: { status: string }) => ["queued", "preparing", "processing", "finalizing"].includes(job.status));
      if (active) timer = setTimeout(load, 2_500);
    };
    void load();
    return () => { if (timer) clearTimeout(timer); };
  }, [projectId]);

  async function retry(jobId: string) {
    setRetrying(true);
    setError(null);
    const response = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
    const json = await response.json().catch(() => ({}));
    setRetrying(false);
    if (!response.ok) setError(json.error ?? "Retry could not be started.");
    else window.location.reload();
  }

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!data) return <p className="notice">Opening private studio…</p>;

  const latest = data.jobs.at(-1);
  return <>
    <header className="project-header">
      <div><span className="eyebrow">Private project</span><h1>{data.project.title}</h1><p>{data.project.description || "No description yet."}</p></div>
      {latest && <div className="stage" data-testid="job-stage">{latest.status.toUpperCase()} · {latest.stage}{latest.resolvedDevice ? ` · ${latest.resolvedDevice}` : ""}</div>}
    </header>
    {latest?.status === "failed" && <div>
      <p className="error" role="alert">Separation failed: {latest.errorMessage || "No safe error detail was recorded."} Source audio remains stored; no stems were marked complete.</p>
      <button className="button" disabled={retrying} onClick={() => void retry(latest.id)}>{retrying ? "Retrying…" : "Retry separation"}</button>
    </div>}
    {latest && latest.status !== "complete" && latest.status !== "failed" && <p className="notice">The worker is at “{latest.stage}” using {latest.model}. This is a named processing stage, not an invented percentage. Keep this page open or return later.</p>}
    {data.stems.length ? <StemMixer stems={data.stems} /> : <div className="hero-card"><h2>Stems will appear here only after validation.</h2><p>The source is never replaced. Waveyard waits for real Demucs output, decodability, and signal checks before exposing stem controls.</p></div>}
    <p className="notice" style={{ marginTop: 22 }}>License: {data.project.licenseCode} · Visibility: {data.project.visibility} · Remix arrangement, waveform cache, export and publication are intentionally not represented as completed in this first slice.</p>
  </>;
}
