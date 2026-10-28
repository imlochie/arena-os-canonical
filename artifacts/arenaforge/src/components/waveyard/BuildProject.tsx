"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "@/routing/navigation";
import { summariseSourceIntake } from "@workspace/arena/lib/waveyard/types";
import { computeBrowserAudioMetadata, computeBrowserWaveform } from "@workspace/arena/lib/waveyard/browser-waveform";
import { fetchDeepEngineStatus, fetchStemEngineStatus, prepareStemEngine, type StemEngineDeepStatus, type StemEngineModelStatus } from "@workspace/arena/lib/waveyard/separation/client";
import { DEEP_MODEL_ID, separationTargetOptions } from "@workspace/arena/lib/waveyard/separation/modes";

/** The upload's separation target. Empty = the machine default (vocals +
 *  instrumental, fastest). Ids are server-validated against the registry
 *  (separation/selection.ts), so this list and the server never drift. */
const SEPARATION_TARGETS = separationTargetOptions();

const AUDIO_ACCEPT = "audio/wav,audio/mpeg,audio/flac,audio/mp4,audio/aac,audio/ogg,.wav,.mp3,.flac,.m4a,.aac,.ogg";

export function BuildProject() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [urls, setUrls] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [recoveryProjectId, setRecoveryProjectId] = useState<string | null>(null);
  const [separationTarget, setSeparationTarget] = useState("");
  /** Options live behind one toggle (vision Principle 3): the cold form is
   * title + drop + build; target choice and link sources stay one click away. */
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [engine, setEngine] = useState<StemEngineModelStatus[] | null>(null);
  const [deepEngine, setDeepEngine] = useState<StemEngineDeepStatus | null>(null);
  const [engineRefresh, setEngineRefresh] = useState(0);
  const [preparingEngine, setPreparingEngine] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [status, deepStatus] = await Promise.all([fetchStemEngineStatus(), fetchDeepEngineStatus()]);
      if (!cancelled) {
        setEngine(status);
        setDeepEngine(deepStatus);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engineRefresh]);
  const engineMissing = engine !== null && engine.some((model) => !model.ready);
  async function prepareEngine() {
    const missing = engine?.find((model) => !model.ready);
    if (!missing) return;
    setPreparingEngine(true);
    setEngineError(null);
    try {
      const result = await prepareStemEngine(missing.id);
      if (!result.ok) setEngineError(result.error);
      setEngineRefresh((value) => value + 1);
    } catch (error) {
      setEngineError(error instanceof Error ? error.message : "The stem engine could not be prepared.");
    } finally {
      setPreparingEngine(false);
    }
  }
  const urlLines = useMemo(() => urls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), [urls]);
  async function build(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null);
    const intake = summariseSourceIntake({ localFileCount: files.length, urls: urlLines });
    if (!intake.requestedCount) { setMessage("Add at least one local audio file or authorized source link."); return; }
    if (intake.invalidUrls.length) { setMessage(`Fix ${intake.invalidUrls.length} invalid link${intake.invalidUrls.length === 1 ? "" : "s"} before building.`); return; }
    setBusy(true);
    setRecoveryProjectId(null);
    setProgressMessage("Creating project…");
    let projectId: string | null = null;
    try {
      const createdResponse = await fetch("/api/waveyard/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: title.trim() || "Waveyard build", description: "", licenseCode: "all-rights-reserved" }) });
      const created = await createdResponse.json().catch(() => ({}));
      if (!createdResponse.ok || typeof created.project?.id !== "string") {
        setMessage(created.error ?? "The project could not be created. Check your connection before trying again.");
        return;
      }
      const activeProjectId: string = created.project.id;
      projectId = activeProjectId;
      setProgressMessage("Starting source intake…");
      const buildResponse = await fetch(`/api/waveyard/projects/${activeProjectId}/builds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestedSourceCount: intake.requestedCount }) });
      const buildRecord = await buildResponse.json().catch(() => ({}));
      if (!buildResponse.ok || typeof buildRecord.build?.id !== "string") {
        setMessage(buildRecord.error ?? "The project exists, but its build could not start. Open the project to continue.");
        setRecoveryProjectId(activeProjectId);
        return;
      }
      const buildId = buildRecord.build.id;
      const failures: string[] = []; let accepted = 0;
      for (const [index, file] of files.entries()) {
        setProgressMessage(`Uploading audio ${index + 1} of ${intake.requestedCount}…`);
        const payload = new FormData(); payload.set("projectId", activeProjectId); payload.set("file", file); payload.set("device", "auto"); if (separationTarget !== "") payload.set("model", separationTarget); // empty = the machine default
        // The browser decodes the real audio (Web Audio) and sends the measured
        // duration/sampleRate/channels — used server-side only when no ffprobe
        // exists, and recorded as probeSource "client-webaudio".
        try {
          const probe = await computeBrowserAudioMetadata(file);
          payload.set("clientDurationSeconds", String(probe.clientDurationSeconds));
          payload.set("clientSampleRate", String(probe.clientSampleRate));
          payload.set("clientChannels", String(probe.clientChannels));
          payload.set("clientCodec", probe.clientCodec);
        } catch { /* server ffprobe remains the authority */ }
        try {
          const response = await fetch("/api/uploads", { method: "POST", body: payload }); const body = await response.json().catch(() => ({}));
          if (response.ok) accepted += 1;
          else {
            failures.push(`${file.name}: ${body.error ?? "local intake failed"}`);
            // Stored upload + worker offline: compute the REAL waveform in the
            // browser so the studio has honest peaks (stage: browser-computed).
            if (typeof body.waveformJobId === "string" && body.source) {
              try {
                const waveform = await computeBrowserWaveform(file);
                await fetch(`/api/waveform-jobs/${body.waveformJobId}/browser-computed`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ waveform }),
                });
              } catch { /* the server keeps the honest "waveform unavailable" state */ }
            }
          }
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : "upload request failed"}`);
        }
      }
      for (const [index, url] of intake.distinctUrls.entries()) {
        setProgressMessage(`Adding link ${index + 1} of ${intake.requestedCount}…`);
        try {
          const response = await fetch(`/api/waveyard/projects/${activeProjectId}/source-intake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }); const body = await response.json().catch(() => ({}));
          if (response.ok) accepted += 1; else failures.push(`${url}: ${body.error ?? "authorized acquisition failed"}`);
        } catch (error) {
          failures.push(`${url}: ${error instanceof Error ? error.message : "authorized acquisition request failed"}`);
        }
      }
      setProgressMessage("Saving intake results…");
      try {
        const statusResponse = await fetch(`/api/waveyard/projects/${activeProjectId}/builds`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buildId, status: accepted ? "processing" : "failed", stage: accepted ? "separating" : "failed", acceptedSourceCount: accepted, failedSourceCount: failures.length, errorMessage: accepted ? null : failures.join("\n"), details: { failures } }) });
        if (!statusResponse.ok) failures.push("Sources were submitted, but the intake summary could not be saved.");
      } catch {
        failures.push("Sources were submitted, but the intake summary could not be saved because the connection was interrupted.");
      }
      if (failures.length) {
        const firstFailures = failures.slice(0, 2).join(" ");
        const remainingCount = failures.length - Math.min(failures.length, 2);
        setMessage(`${accepted} source${accepted === 1 ? "" : "s"} accepted; ${failures.length} need attention. ${firstFailures}${remainingCount ? ` And ${remainingCount} more.` : ""}`);
        setRecoveryProjectId(activeProjectId);
      } else {
        router.push(`/waveyard/projects/${activeProjectId}`);
      }
    } catch (error) {
      setMessage(projectId
        ? `Intake was interrupted: ${error instanceof Error ? error.message : "connection error"}. Open the project to check what completed before retrying.`
        : `Could not confirm project creation: ${error instanceof Error ? error.message : "connection error"}. Check your project list before retrying.`);
      if (projectId) setRecoveryProjectId(projectId);
    } finally {
      setBusy(false);
      setProgressMessage(null);
    }
  }
  return <form className="build-project" onSubmit={build}>
    {engineMissing && (
      <p className="notice" role="status">
        First run: the stem engine needs a one-time download
        ({Math.round((engine!.find((model) => !model.ready)!.sizeBytes ?? 0) / 1_000_000)} MB).
        You can prepare it now or after your first upload fails — separation
        then runs fully offline on this machine.
        <button type="button" className="button secondary" disabled={preparingEngine} onClick={() => void prepareEngine()} style={{ display: "block", marginTop: "0.5rem" }}>
          {preparingEngine ? "Preparing stem engine…" : "Prepare stem engine now"}
        </button>
        {engineError && <span className="error" role="alert" style={{ display: "block", marginTop: "0.5rem" }}>{engineError}</span>}
      </p>
    )}
    <input className="build-title" aria-label="Optional project title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="Optional project title" />
    <label className="build-dropzone">Drop audio here<input aria-label="Local audio files" type="file" multiple accept={AUDIO_ACCEPT} onChange={(event: ChangeEvent<HTMLInputElement>) => setFiles(Array.from(event.target.files ?? []))} /><b>{files.length ? `${files.length} local file${files.length === 1 ? "" : "s"} ready` : "MP3 · WAV · FLAC · M4A · AAC · OGG"}</b><small>Local audio stays private and enters the same Source Asset pipeline.</small></label>
    <button type="button" className="build-advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced((current) => !current)}>
      {advanced ? "Hide options" : "Options: separate into " + (SEPARATION_TARGETS.find((target) => target.id === separationTarget)?.label.replace(/ —.*/, "") ?? "the default") + " · add links"}
    </button>
    {advanced && <>
      <label className="build-separation">Separate into
        <select aria-label="Separation target" value={separationTarget} onChange={(event) => setSeparationTarget(event.target.value)}>
          {SEPARATION_TARGETS.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
        </select>
      </label>
      {separationTarget === DEEP_MODEL_ID && deepEngine !== null && !deepEngine.prepared && (
        <p className="notice" role="status" data-testid="deep-engine-hint">
          Deep separation needs the deep engine prepared on this machine. {deepEngine.reason ?? "It is not ready yet."}
        </p>
      )}
      <div className="build-or">or</div>
      <label>Paste authorized source links<textarea aria-label="Authorized source links" value={urls} onChange={(event) => setUrls(event.target.value)} rows={4} placeholder={"https://youtube.com/...\nhttps://youtube.com/..."} /><small>One link per line. This deployment uses only a configured authorized resolver; unsupported links can always be added as local audio.</small></label>
    </>}
    {(files.length || urlLines.length) ? <p className="build-summary">{files.length} local · {urlLines.length} link{urlLines.length === 1 ? "" : "s"} · one source pool</p> : null}
    {message && <p className="error" role="alert">{message}</p>}
    {recoveryProjectId && <p><a className="button secondary" href={`/waveyard/projects/${recoveryProjectId}`}>Open project workspace</a></p>}
    {progressMessage && <p role="status" aria-live="polite">{progressMessage}</p>}
    <button className="button build-button" disabled={busy}>{busy ? progressMessage ?? "BUILDING SOURCES…" : "BUILD"}</button>
  </form>;
}
