"use client";

import { useEffect, useState } from "react";
import { StudioCore } from "./StudioCore";
import { PublicationPanel } from "./PublicationPanel";

type ProjectData = {
  project: {
    title: string;
    description: string;
    licenseCode: string;
    visibility: string;
    publicationStatus: string;
    moderationStatus: string;
  };
  role: "viewer" | "contributor" | "editor" | "owner";
  stems: any[];
  waveforms: any[];
  waveformJobs: Array<{
    id: string;
    status: string;
    stage: string;
    errorMessage: string | null;
  }>;
  jobs: Array<{
    id: string;
    status: string;
    stage: string;
    errorMessage: string | null;
    model: string;
    requestedDevice: string;
    resolvedDevice: string | null;
  }>;
  sources: any[];
};

export function ProjectWorkspace({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const response = await fetch(`/api/projects/${projectId}`, {
        cache: "no-store",
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(json.error ?? "Project could not be opened.");
        return;
      }
      setData(json);
      const active = [...(json.jobs ?? []), ...(json.waveformJobs ?? [])].some(
        (job: { status: string }) =>
          ["queued", "preparing", "processing", "finalizing"].includes(
            job.status,
          ),
      );
      if (active) timer = setTimeout(load, 2_500);
    };
    void load();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);

  async function retry(jobId: string) {
    setRetrying(true);
    setError(null);
    const response = await fetch(`/api/jobs/${jobId}/retry`, {
      method: "POST",
    });
    const json = await response.json().catch(() => ({}));
    setRetrying(false);
    if (!response.ok) setError(json.error ?? "Retry could not be started.");
    else window.location.reload();
  }

  async function retryWaveform(jobId: string) {
    setRetrying(true);
    setError(null);
    const response = await fetch(`/api/waveform-jobs/${jobId}/retry`, {
      method: "POST",
    });
    const json = await response.json().catch(() => ({}));
    setRetrying(false);
    if (!response.ok)
      setError(json.error ?? "Waveform retry could not be started.");
    else window.location.reload();
  }

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!data) return <p className="notice">Opening private studio…</p>;

  const latest = data.jobs.at(-1);
  return (
    <>
      <header className="project-header">
        <div>
          <span className="eyebrow">Private project</span>
          <h1>{data.project.title}</h1>
          <p>{data.project.description || "No description yet."}</p>
        </div>
        {latest && (
          <div className="stage" data-testid="job-stage">
            {latest.status.toUpperCase()} · {latest.stage}
            {latest.resolvedDevice ? ` · ${latest.resolvedDevice}` : ""}
          </div>
        )}
      </header>
      {latest?.status === "failed" && (
        <div>
          <p className="error" role="alert">
            Separation failed:{" "}
            {latest.errorMessage || "No safe error detail was recorded."} Source
            audio remains stored; no stems were marked complete.
          </p>
          <button
            className="button"
            disabled={retrying}
            onClick={() => void retry(latest.id)}
          >
            {retrying ? "Retrying…" : "Retry separation"}
          </button>
        </div>
      )}
      {latest && latest.status !== "complete" && latest.status !== "failed" && (
        <p className="notice">
          The worker is at “{latest.stage}” using {latest.model}. This is a
          named processing stage, not an invented percentage. Keep this page
          open or return later.
        </p>
      )}
      <PublicationPanel
        projectId={projectId}
        editable={data.role === "owner" || data.role === "editor"}
      />
      {data.stems.length ? (
        <StudioCore
          projectId={projectId}
          stems={data.stems}
          sources={data.sources}
        />
      ) : (
        <div className="hero-card">
          <h2>Stems will appear here only after validation.</h2>
          <p>
            The source is never replaced. Waveyard waits for real Demucs output,
            decodability, and signal checks before exposing Studio controls.
          </p>
        </div>
      )}
      {data.waveformJobs?.some(
        (job) => job.status !== "complete" && job.status !== "failed",
      ) && (
        <p className="notice">
          Waveform worker jobs are still running. Studio renders peaks only
          after a real decoded waveform artifact is stored and validated.
        </p>
      )}
      {data.waveformJobs
        ?.filter((job) => job.status === "failed")
        .map((job) => (
          <div key={job.id}>
            <p className="error" role="alert">
              Waveform generation failed at {job.stage}:{" "}
              {job.errorMessage || "No safe error detail was recorded."} Audio
              playback/download remains available; no substitute peaks are
              drawn.
            </p>
            <button
              className="button secondary"
              disabled={retrying}
              onClick={() => void retryWaveform(job.id)}
            >
              {retrying ? "Retrying…" : "Retry waveform"}
            </button>
          </div>
        ))}
      <p className="notice" style={{ marginTop: 22 }}>
        License: {data.project.licenseCode} · Visibility:{" "}
        {data.project.visibility} · original stems remain private and
        non-destructive.
      </p>
    </>
  );
}
