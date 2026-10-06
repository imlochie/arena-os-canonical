"use client";

import { ChangeEvent, FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { summariseSourceIntake } from "@/lib/waveyard/types";
import { computeBrowserAudioMetadata, computeBrowserWaveform } from "@/lib/waveyard/browser-waveform";

const AUDIO_ACCEPT = "audio/wav,audio/mpeg,audio/flac,audio/mp4,audio/aac,audio/ogg,.wav,.mp3,.flac,.m4a,.aac,.ogg";

export function BuildProject() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [urls, setUrls] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const urlLines = useMemo(() => urls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), [urls]);
  async function build(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null);
    const intake = summariseSourceIntake({ localFileCount: files.length, urls: urlLines });
    if (!intake.requestedCount) { setMessage("Add at least one local audio file or authorized source link."); return; }
    if (intake.invalidUrls.length) { setMessage(`Fix ${intake.invalidUrls.length} invalid link${intake.invalidUrls.length === 1 ? "" : "s"} before building.`); return; }
    setBusy(true);
    const createdResponse = await fetch("/api/waveyard/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: title.trim() || "Waveyard build", description: "", licenseCode: "all-rights-reserved" }) });
    const created = await createdResponse.json().catch(() => ({}));
    if (!createdResponse.ok) { setBusy(false); setMessage(created.error ?? "The project could not be created."); return; }
    const projectId = created.project.id;
    const buildResponse = await fetch(`/api/waveyard/projects/${projectId}/builds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestedSourceCount: intake.requestedCount }) });
    const buildRecord = await buildResponse.json().catch(() => ({}));
    if (!buildResponse.ok) { setBusy(false); setMessage(buildRecord.error ?? "Project was created but its build could not start."); router.push(`/waveyard/projects/${projectId}`); return; }
    const failures: string[] = []; let accepted = 0;
    for (const file of files) {
      const payload = new FormData(); payload.set("projectId", projectId); payload.set("file", file); payload.set("model", "htdemucs"); payload.set("device", "auto");
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
    }
    for (const url of intake.distinctUrls) {
      const response = await fetch(`/api/waveyard/projects/${projectId}/source-intake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, model: "htdemucs" }) }); const body = await response.json().catch(() => ({}));
      if (response.ok) accepted += 1; else failures.push(`${url}: ${body.error ?? "authorized acquisition failed"}`);
    }
    await fetch(`/api/waveyard/projects/${projectId}/builds`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buildId: buildRecord.build.id, status: accepted ? "processing" : "failed", stage: accepted ? "separating" : "failed", acceptedSourceCount: accepted, failedSourceCount: failures.length, errorMessage: accepted ? null : failures.join("\n"), details: { failures } }) });
    setBusy(false); router.push(`/waveyard/projects/${projectId}`);
  }
  return <form className="build-project" onSubmit={build}>
    <input className="build-title" aria-label="Optional project title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="Optional project title" />
    <label className="build-dropzone">Drop audio here<input aria-label="Local audio files" type="file" multiple accept={AUDIO_ACCEPT} onChange={(event: ChangeEvent<HTMLInputElement>) => setFiles(Array.from(event.target.files ?? []))} /><b>{files.length ? `${files.length} local file${files.length === 1 ? "" : "s"} ready` : "MP3 · WAV · FLAC · M4A · AAC · OGG"}</b><small>Local audio stays private and enters the same Source Asset pipeline.</small></label>
    <div className="build-or">or</div>
    <label>Paste authorized source links<textarea aria-label="Authorized source links" value={urls} onChange={(event) => setUrls(event.target.value)} rows={4} placeholder={"https://youtube.com/...\nhttps://youtube.com/..."} /><small>One link per line. This deployment uses only a configured authorized resolver; unsupported links can always be added as local audio.</small></label>
    {(files.length || urlLines.length) ? <p className="build-summary">{files.length} local · {urlLines.length} link{urlLines.length === 1 ? "" : "s"} · one source pool</p> : null}
    {message && <p className="error" role="alert">{message}</p>}
    <button className="button build-button" disabled={busy}>{busy ? "BUILDING SOURCES…" : "BUILD"}</button>
  </form>;
}
