"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { StudioCore } from "./StudioCore";
import { SourceAnalysisSummary } from "./studio/SourceAnalysisSummary";
import { SourceSectionSummary } from "./studio/SourceSectionSummary";
import { VocalAnalysisSummary } from "./studio/VocalAnalysisSummary";
import type { Source, SourceAnalysis, SourceSectionAnalysis, Stem } from "./studio/types";
import { PublicationPanel } from "./PublicationPanel";
import { WaveyardHandoffPanel } from "./arena/WaveyardHandoffPanel";
import { evaluateAutomaticBuildFinalization } from "@/lib/automatic-build-finalization";

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
  build?: { id: string; status: "processing" | "complete" | "failed"; stage: string; requestedSourceCount: number; acceptedSourceCount: number; failedSourceCount: number; remixSessionId: string | null; errorMessage: string | null } | null;
  stems: Stem[];
  waveforms: any[];
  waveformJobs: Array<{
    id: string;
    status: string;
    stage: string;
    errorMessage: string | null;
  }>;
  jobs: Array<{
    id: string;
    sourceAssetId: string;
    status: string;
    stage: string;
    errorMessage: string | null;
    model: string;
    requestedDevice: string;
    resolvedDevice: string | null;
  }>;
  sources: Source[];
};

const AUDIO_ACCEPT = "audio/wav,audio/mpeg,audio/flac,audio/mp4,audio/aac,audio/ogg,.wav,.mp3,.flac,.m4a,.aac,.ogg";

export function ProjectWorkspace({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [addingSource, setAddingSource] = useState(false);
  const [selectedSourceName, setSelectedSourceName] = useState("");
  const [sourceMessage, setSourceMessage] = useState<string | null>(null);
  const finalizingBuild = useRef<string | null>(null);

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
      const active = [
        ...(json.jobs ?? []),
        ...(json.waveformJobs ?? []),
        ...(json.sources ?? [])
          .flatMap((source: { analysis?: { status?: string } | null; sectionAnalysis?: { status?: string } | null; eventAnalysis?: { status?: string } | null; harmonyAnalysis?: { status?: string } | null }) => [source.analysis, source.sectionAnalysis, source.eventAnalysis, source.harmonyAnalysis])
          .filter(Boolean),
        ...(json.stems ?? []).flatMap((stem: { drumAnalysis?: { status?: string } | null; vocalAnalysis?: { status?: string } | null }) => [stem.drumAnalysis, stem.vocalAnalysis]).filter(Boolean),
      ].some(
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
  }, [projectId, refresh]);

  useEffect(() => {
    const build = data?.build;
    if (!data || !build || build.status !== "processing" || finalizingBuild.current === build.id) return;
    const processing = data.jobs.some((job) => ["queued", "preparing", "processing", "finalizing"].includes(job.status));
    const finalization = evaluateAutomaticBuildFinalization({
      acceptedSourceCount: build.acceptedSourceCount,
      persistedFailedSourceCount: build.failedSourceCount,
      processing,
      failedJobSourceIds: data.jobs
        .filter((job) => job.status === "failed")
        .map((job) => job.sourceAssetId),
      sources: data.sources.map((source) => ({
        id: source.id,
        analysisStatus: source.analysis?.status,
        sectionStatus: source.sectionAnalysis?.status,
        hasRealStems: data.stems.some((stem) => stem.sourceAssetId === source.id),
      })),
    });
    if (finalization.stage !== build.stage || finalization.failedSourceCount !== build.failedSourceCount || finalization.reportedAcceptedSourceCount !== build.acceptedSourceCount) void fetch(`/api/projects/${projectId}/builds`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buildId: build.id, status: finalization.expectedReadySourceCount ? "processing" : "failed", stage: finalization.expectedReadySourceCount ? finalization.stage : "failed", acceptedSourceCount: finalization.reportedAcceptedSourceCount, failedSourceCount: finalization.failedSourceCount, errorMessage: finalization.expectedReadySourceCount ? null : "No source completed the build pipeline." }) });
    if (!finalization.canBuildAutomaticRemix) return;
    finalizingBuild.current = build.id;
    void (async () => {
      const automatic = await fetch(`/api/projects/${projectId}/automatic-remixes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variant: "original" }) });
      const body = await automatic.json().catch(() => ({}));
      await fetch(`/api/projects/${projectId}/builds`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buildId: build.id, status: automatic.ok ? "complete" : "failed", stage: automatic.ok ? "ready" : "failed", acceptedSourceCount: build.acceptedSourceCount, failedSourceCount: build.failedSourceCount, remixSessionId: automatic.ok ? body.remix?.id : null, errorMessage: automatic.ok ? null : body.error ?? "Waveyard could not build the initial arrangement." }) });
      setRefresh((value) => value + 1);
    })();
  }, [data, projectId]);

  async function retry(jobId: string) {
    setRetrying(true);
    setError(null);
    const response = await fetch(`/api/jobs/${jobId}/retry`, {
      method: "POST",
    });
    const json = await response.json().catch(() => ({}));
    setRetrying(false);
    if (!response.ok) setError(json.error ?? "Retry could not be started.");
    else setRefresh((value) => value + 1);
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
    else setRefresh((value) => value + 1);
  }

  async function retryAnalysis(analysis: SourceAnalysis) {
    setRetrying(true);
    setError(null);
    const response = await fetch(`/api/source-analyses/${analysis.id}/retry`, {
      method: "POST",
    });
    const json = await response.json().catch(() => ({}));
    setRetrying(false);
    if (!response.ok)
      setError(json.error ?? "Analysis retry could not be started.");
    else setRefresh((value) => value + 1);
  }

  async function retrySectionAnalysis(analysis: SourceSectionAnalysis) {
    setRetrying(true);
    setError(null);
    const response = await fetch(`/api/source-section-analyses/${analysis.id}/retry`, { method: "POST" });
    const json = await response.json().catch(() => ({}));
    setRetrying(false);
    if (!response.ok) setError(json.error ?? "Structural analysis retry could not be started.");
    else setRefresh((value) => value + 1);
  }

  async function requestVocalAnalysis(stemId: string) {
    const response = await fetch(`/api/stems/${stemId}/vocal-analysis`, { method: "POST" });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) return json.error ?? "Could not queue isolated-vocal analysis.";
    setRefresh((value) => value + 1);
    return null;
  }

  async function addSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const selected = new FormData(form).get("file");
    if (!(selected instanceof File) || selected.size <= 0) {
      setSourceMessage("Choose an audio file to add to this private project.");
      return;
    }
    setAddingSource(true);
    setSourceMessage(null);
    const payload = new FormData();
    payload.set("projectId", projectId);
    payload.set("file", selected);
    payload.set("model", "htdemucs");
    payload.set("device", "auto");
    const response = await fetch("/api/uploads", { method: "POST", body: payload });
    const body = await response.json().catch(() => ({}));
    setAddingSource(false);
    if (!response.ok) {
      setSourceMessage(body.error ?? "The additional source could not be queued.");
      return;
    }
    form.reset();
    setSelectedSourceName("");
    setSourceMessage(`Queued ${selected.name}. The existing worker will separate it and derive private waveforms.`);
    setRefresh((value) => value + 1);
  }

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!data) return <p className="notice">Opening private studio…</p>;

  const latest = data.jobs.at(-1);
  const editable = data.role === "owner" || data.role === "editor";
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
      <WaveyardHandoffPanel
        waveyardProjectId={projectId}
        projectTitle={data.project.title}
        projectDescription={data.project.description}
        editable={editable}
      />
      {data.build && <section className={`build-progress ${data.build.status}`} aria-label="Build progress" data-testid="build-progress"><span className="eyebrow">Waveyard build</span><h2>{({ "resolving-sources": "Resolving sources", separating: "Separating", understanding: "Understanding", "finding-structure": "Finding structure", building: "Building", ready: "Ready", failed: "Build needs attention" } as Record<string, string>)[data.build.stage] ?? "Building"}</h2><p>{data.build.status === "complete" ? "Your automatic starting arrangement is ready in Play." : data.build.status === "failed" ? data.build.errorMessage ?? "No sources could complete the build." : `${data.build.acceptedSourceCount} source${data.build.acceptedSourceCount === 1 ? "" : "s"} accepted${data.build.failedSourceCount ? ` · ${data.build.failedSourceCount} source failure${data.build.failedSourceCount === 1 ? "" : "s"}` : ""}`}</p><div className="build-progress-steps"><span className={data.build.stage === "resolving-sources" ? "active" : ""}>Sources</span><span className={["separating", "understanding", "finding-structure", "building", "ready"].includes(data.build.stage) ? "active" : ""}>Stems</span><span className={["understanding", "finding-structure", "building", "ready"].includes(data.build.stage) ? "active" : ""}>Structure</span><span className={["building", "ready"].includes(data.build.stage) ? "active" : ""}>Build</span><span className={data.build.stage === "ready" ? "active" : ""}>Play</span></div></section>}
      {editable && data.build?.status !== "complete" && (
        <section className="add-source-panel" aria-label="Add source audio">
          <div>
            <span className="eyebrow">Two-source workflow</span>
            <h2>Add source audio</h2>
            <p>Queue another private song in this project. It uses the same validated local separation pipeline and never replaces an existing source.</p>
          </div>
          <form className="add-source-form" onSubmit={(event) => void addSource(event)}>
            <label>
              Add source audio
              <input
                aria-label="Add source audio"
                name="file"
                type="file"
                accept={AUDIO_ACCEPT}
                disabled={addingSource}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setSelectedSourceName(event.target.files?.[0]?.name ?? "")}
              />
            </label>
            {selectedSourceName && <small>Selected: {selectedSourceName}</small>}
            <button className="button" disabled={addingSource}>
              {addingSource ? "Queuing source…" : "Separate added source"}
            </button>
          </form>
          {sourceMessage && <p className={sourceMessage.startsWith("Queued") ? "notice" : "error"} role="status">{sourceMessage}</p>}
        </section>
      )}
      {data.build?.status !== "complete" && <section className="project-sources" aria-label="Project sources">
        <div className="panel-title"><h2>Sources</h2><span>{data.sources.length} private source{data.sources.length === 1 ? "" : "s"}</span></div>
        {data.sources.map((source, index) => {
          const sourceStems = data.stems.filter(
            (stem: { sourceAssetId: string }) => stem.sourceAssetId === source.id,
          );
          return (
            <article className="project-source" data-testid={`project-source-${source.id}`} key={source.id}>
              <div className="project-source-head">
                <span>Source {index + 1}</span>
                <b>{source.originalFilename}</b>
                <small>Stems: {sourceStems.length ? sourceStems.map((stem: { stemType: string }) => `${stem.stemType[0].toUpperCase()}${stem.stemType.slice(1)}`).join(" · ") : "Pending validation"}</small>
              </div>
              <SourceAnalysisSummary
                source={source}
                onRetry={editable ? (analysis) => void retryAnalysis(analysis) : undefined}
              />
              <SourceSectionSummary
                source={source}
                onRetry={editable ? (analysis) => void retrySectionAnalysis(analysis) : undefined}
              />
              {sourceStems.filter((stem): stem is Stem => stem.stemType === "vocals").map((stem) => <VocalAnalysisSummary key={stem.id} stem={stem} editable={editable} onRequestAnalysis={() => requestVocalAnalysis(stem.id)} />)}
            </article>
          );
        })}
      </section>}
      {latest?.status === "failed" && (
        <div>
          <p className="error" role="alert">
            Separation failed:{" "}
            {latest.errorMessage || "No safe error detail was recorded."} Source
            audio remains stored; no stems were marked complete.
          </p>
          {editable && <button
            className="button"
            disabled={retrying}
            onClick={() => void retry(latest.id)}
          >
            {retrying ? "Retrying…" : "Retry separation"}
          </button>}
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
          onDerivedAnalysisRequested={() => setRefresh((value) => value + 1)}
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
            {editable && <button
              className="button secondary"
              disabled={retrying}
              onClick={() => void retryWaveform(job.id)}
            >
              {retrying ? "Retrying…" : "Retry waveform"}
            </button>}
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
