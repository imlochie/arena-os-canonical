"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import TunePatBridge from "./TunePatBridge";
import PlaylistImport from "./PlaylistImport";

type Tags = Record<string, string>;
type Review = { trackId: string; name: string; tags: Tags; truncatedTags?: string[] };
type Item = { tags: Tags; history: Array<{at:string;event:string;reason?:string}>; createdAt: string; id: string; batchId: string; index: number; name: string; status: string; stage: string; error?: string; attempts: number; outputTrackId?: string; outputSourceId?: string; verification?: { checksumSha256: string; fullyDecoded: boolean; warnings: string[]; actual: { codec: string; sampleRate: number; channels: number } } };
function downloadLyrics(text: string, extension: "lrc" | "txt") {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `user-provided-lyrics.${extension}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fields = ["title", "artist", "album", "album_artist", "track", "disc", "date", "genre", "lyrics"];
async function request(url: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal } : { cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}); previous work retained.`);
  return data;
}
// Folder selection uses the browser's user-granted File objects, never host paths.
async function droppedFiles(transfer: DataTransfer): Promise<File[]> {
  type Entry = { isFile: boolean; isDirectory: boolean; file: (ok: (file: File) => void, fail: (error: unknown) => void) => void; createReader: () => { readEntries: (ok: (entries: Entry[]) => void, fail: (error: unknown) => void) => void } };
  const files: File[] = [];
  async function visit(entry: Entry) {
    if (files.length >= 1000) throw new Error("Select at most 1000 files per intake.");
    if (entry.isFile) files.push(await new Promise<File>((resolve, reject) => entry.file(resolve, reject)));
    else if (entry.isDirectory) { const reader = entry.createReader(); for (;;) { const entries = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject)); if (!entries.length) break; for (const child of entries) await visit(child); } }
  }
  const entries = Array.from(transfer.items).map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) for (const entry of entries) await visit(entry as unknown as Entry);
  else files.push(...Array.from(transfer.files));
  return files;
}
export default function ConversionWorkbench() {
  const [executor, setExecutor] = useState<{ available: boolean; reason?: string }>({ available: false });
  const [open, setOpen] = useState(false), [review, setReview] = useState<Review[]>([]), [jobs, setJobs] = useState<Item[]>([]);
  const [codecs, setCodecs] = useState<Array<{ id: string; available: boolean }>>([]), [error, setError] = useState("");
  const [failures, setFailures] = useState<string[]>([]), [busy, setBusy] = useState(false), [format, setFormat] = useState("flac");
  const [pcmBits, setBits] = useState(24);
  const [bitrate, setBitrate] = useState(192), [compression, setCompression] = useState(5), [sampleRate, setRate] = useState(""), [channels, setChannels] = useState("");
  const [template, setTemplate] = useState("{artist}/{album}/{track} - {title}"), [sessionName, setSessionName] = useState("Converted music"), [existingSession, setExistingSession] = useState("");
  const [sessions, setSessions] = useState<Array<{ id: string; name: string }>>([]), [sessionLink, setSessionLink] = useState("");
  const [selected, setSelected] = useState<string[]>([]), [library, setLibrary] = useState<Array<{ id: string; title: string }>>([]), [libraryId, setLibraryId] = useState("");
  const folder = useRef<HTMLInputElement>(null);
  const reload = useCallback(async () => {
    try { const data = await request("/api/library/conversions"); setJobs(data.jobs); setCodecs(data.formats); setExecutor(data.executor); }
    catch (e) { setError(e instanceof Error ? e.message : "History unavailable; retry."); }
  }, []);
  useEffect(() => { if (!open) return; void reload(); const timer = setInterval(() => void reload(), 2000); return () => clearInterval(timer); }, [open, reload]);
  useEffect(() => { folder.current?.setAttribute("webkitdirectory", ""); }, [open]);
  const act = async (action: string, id: string) => { try { setError(""); await request("/api/library/conversions", { action, id }); await reload(); } catch (e) { setError(String(e)); } };
  const inspectTrack = useCallback(async (trackId: string, name: string) => {
    const { inspection } = await request("/api/library/conversions", { action: "inspect", id: trackId });
    setReview(rows => [...rows, { trackId, name, tags: inspection.tags, truncatedTags: inspection.truncatedTags }]);
  }, []);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("convertTrack");
    if (!id || !/^[a-f0-9-]{36}$/i.test(id)) return;
    const controller = new AbortController();
    void request("/api/library/conversions", { action: "inspect", id }, controller.signal).then(({ inspection }) => {
      if (controller.signal.aborted) return;
      setReview(rows => [...rows, { trackId: id, name: inspection.tags.title || "Selected library source", tags: inspection.tags, truncatedTags: inspection.truncatedTags }]);
      setOpen(true);
    }).catch(error => { if (!controller.signal.aborted) { setError(String(error)); setOpen(true); } });
    return () => controller.abort();
  }, []);
  const intake = async (files: File[]) => {
    if (busy) return; setBusy(true); setError("");
    try { if (files.length > 1000) throw new Error("Select at most1000 files per intake.");
      for (const file of files) {
        try { const form = new FormData(); form.append("file", file); form.append("prepareSeparation", "false");
          const response = await fetch("/api/library/tracks", { method: "POST", body: form }), data = await response.json();
          if (!response.ok) throw new Error(data.error);
          await inspectTrack(data.track.id, file.name);
        } catch (e) { setFailures(rows => [...rows, `${file.name}: ${e instanceof Error ? e.message : "Import failed"}`]); }
      }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const start = async () => {
    setBusy(true); setError(""); try {
      await request("/api/library/conversions", { action: "create", batchId: crypto.randomUUID(), items: review.map(({ trackId, tags }) => ({ trackId, tags })), settings: { format, bitrate, pcmBits, compression, template, ...(sampleRate ? { sampleRate: Number(sampleRate) } : {}), ...(channels ? { channels: Number(channels) } : {}) } });
      setReview([]); await reload();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const selectedOutputs = jobs.filter(job => selected.includes(job.id) && job.status === "complete" && job.outputTrackId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.index - b.index);
  const toSession = async () => {
    setBusy(true); setError(""); try {
      const ordered = jobs.filter(j => selected.includes(j.id) && j.status === "complete" && j.outputTrackId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.index - b.index);
      if (!ordered.length) throw new Error("Select completed local outputs first.");
      const id = existingSession || (await request("/api/library/sessions", { name: sessionName })).session.id;
      setExistingSession(id); setSessionLink(`/waveyard/session/${id}`);
      for (const job of ordered) {
        // Explicit action: use full, UNSEPARATED audio. This never claims inference.
        await request("/api/stems/passthrough", { sourceAssetId: job.outputSourceId });
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${id}:${job.id}`)))).map(n => n.toString(16).padStart(2, "0")).join("");
        const operationId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
        await request(`/api/library/sessions/${id}/tracks`, { trackId: job.outputTrackId, operationId });
      }
      setSessionLink(`/waveyard/session/${id}`); setSelected([]);
    } catch (e) { setError(`Session update may be partial; inspect it before retrying. ${String(e)}`); } finally { setBusy(false); }
  };
  return <section aria-label="Native music conversion" onDrop={event => { event.preventDefault(); event.stopPropagation(); setOpen(true); void droppedFiles(event.dataTransfer).then(intake).catch(e => setError(String(e))); }} onDragOver={e => e.preventDefault()}>
    <button className="button secondary" type="button" onClick={() => setOpen(!open)}>Import, review & convert music</button>
    {open && <div className="panel" style={{ padding: 20 }}>
      <h2>Local music conversion</h2><p>Import → review tags → configure → convert → decode/verify → library → session / Studio. Only local files you are authorized to process. No Apple Music streaming export or DRM removal. TunePat is not required.</p>
      <p>Browser playback depends on its codecs. AIFF/ALAC may need an explicitly reviewed WAV/FLAC/MP3 conversion; originals remain retained. Native format verification does not promise browser codec support.</p>
      <p>Destination: Arena private storage, organized by the naming template. Download verified files individually or select a batch for one ZIP with the same folders and filenames. A stable item suffix prevents collisions; no existing user file is overwritten. No arbitrary host-folder writes.</p>
      {error && <p role="alert">{error}</p>}
      <TunePatBridge onImport={intake} busy={busy} />
      <PlaylistImport />
      <label>Choose audio files <input aria-label="Conversion files" type="file" multiple disabled={busy} onChange={e => { void intake(Array.from(e.target.files ?? [])); e.target.value = ""; }} /></label>
      <label>Choose folder <input aria-label="Conversion folder" ref={folder} type="file" multiple disabled={busy} onChange={e => { void intake(Array.from(e.target.files ?? [])); e.target.value = ""; }} /></label>
      <p>Or drop files/folders in this panel. Intake uses one bounded upload at a time; source imports already remain playable in the existing library.</p>
      <button disabled={busy} onClick={() => void request("/api/library/tracks").then(d => setLibrary(d.tracks)).catch(e => setError(String(e)))}>Choose existing local track</button>
      <select aria-label="Existing conversion source" value={libraryId} onChange={e => setLibraryId(e.target.value)}><option value="">Select local track</option>{library.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
      <button disabled={busy || !libraryId} onClick={() => { setBusy(true); void inspectTrack(libraryId, library.find(t => t.id === libraryId)?.title ?? "Local track").catch(e => setError(String(e))).finally(() => setBusy(false)); }}>Inspect selected track</button>
      {failures.map((failure, i) => <p role="status" key={i}>Intake failed (not queued): {failure}</p>)}
      {review.length>0 && <p>Review edits are drafts until you queue the batch. Leaving this page discards review edits, not the already imported source files.</p>}
      {review.map((row, index) => <fieldset key={`${row.trackId}:${index}`}><legend>Review {index + 1}: {row.name}</legend>{row.truncatedTags?.map(field=><p role="note" key={field}>Source {field} exceeds 64,000 characters; review/conversion uses a truncated value. Original source remains retained.</p>)}{fields.map(field => <label key={field}>{field}{field === "lyrics" ? <textarea aria-label={`Item ${index + 1} lyrics`} value={row.tags.lyrics ?? ""} onChange={e=>setReview(rows=>rows.map((r,i)=>i===index?{...r,tags:{...r.tags,lyrics:e.target.value}}:r))} /> : <input aria-label={`Item ${index + 1} ${field}`} value={row.tags[field] ?? ""} onChange={e => setReview(rows => rows.map((r, i) => i === index ? { ...r, tags: { ...r.tags, [field]: e.target.value } } : r))} />}</label>)}<label>Import user-provided UTF-8 lyrics<input aria-label={`Item ${index+1} lyric file`} type="file" accept=".lrc,.txt" onChange={e=>{const file=e.target.files?.[0];if(!file)return;void file.arrayBuffer().then(bytes=>{if(bytes.byteLength>64000)throw new Error("Lyrics exceed64KB.");const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);setReview(rows=>rows.map((r,i)=>i===index?{...r,tags:{...r.tags,lyrics:text}}:r));}).catch(e=>setError(String(e)));}} /></label><button disabled={!row.tags.lyrics} onClick={()=>downloadLyrics(row.tags.lyrics,"lrc")}>Export reviewed LRC</button><button onClick={() => setReview(rows => rows.filter((_, i) => i !== index))}>Remove from batch</button></fieldset>)}
      {!executor.available && <p role="status">{executor.reason}</p>}
      <fieldset><legend>Encoding</legend>
        <label>Format<select aria-label="Conversion format" value={format} onChange={e => setFormat(e.target.value)}>{codecs.map(c => <option key={c.id} value={c.id} disabled={!c.available}>{c.id.toUpperCase()}{!c.available ? " (encoder unavailable)" : ""}</option>)}</select></label>
        {["mp3", "aac"].includes(format) ? <label>Bitrate kb/s<select aria-label="Conversion bitrate" value={bitrate} onChange={e => setBitrate(Number(e.target.value))}>{[128,192,256,320].map(n => <option key={n}>{n}</option>)}</select></label> : <p>Lossless container with explicit PCM precision. Does not restore quality previously lost to compression.</p>}
        {!["mp3", "aac"].includes(format) && <label>PCM precision<select aria-label="Conversion PCM bits" value={pcmBits} onChange={e => setBits(Number(e.target.value))}><option value={16}>16 bits</option><option value={24}>24 bits</option></select></label>}
        {format === "flac" && <label>FLAC compression effort<input aria-label="FLAC compression effort" type="number" min={0} max={12} value={compression} onChange={e => setCompression(Number(e.target.value))} /></label>}
        <label>Sample rate<select aria-label="Conversion sample rate" value={sampleRate} onChange={e => setRate(e.target.value)}><option value="">Preserve source</option>{[22050,44100,48000,96000].map(n => <option key={n}>{n}</option>)}</select></label>
        <label>Channels<select aria-label="Conversion channels" value={channels} onChange={e => setChannels(e.target.value)}><option value="">Preserve source layout</option><option value="1">Mono</option><option value="2">Stereo</option></select></label>
        <label>Naming template<input aria-label="Conversion naming template" value={template} onChange={e => setTemplate(e.target.value)} /></label>
        <button className="button" disabled={busy || !executor.available || !review.length || !codecs.find(c => c.id === format)?.available} onClick={() => void start()}>Convert reviewed batch</button>
      </fieldset>
      <h3>Durable conversion history</h3><button disabled={busy} onClick={() => void reload()}>Refresh conversion history</button>
      <p>One processing item at a time. Last durable stages are shown, not worker-liveness claims or invented percentages. After restart, resume unfinished items. Resume reconciles interrupted publication; Retry keeps the same output identity. Intake errors above are not conversion jobs.</p>
      {jobs.map(job => <article aria-label={`Conversion ${job.id}`} key={job.id}><b>{job.name}</b><p>{job.status === "complete" ? "Completed" : job.stage} · attempts {job.attempts}</p>{job.error && <p>{job.error}</p>}<details><summary>Operation history</summary>{job.history?.map((event,index)=><p key={index}>{event.at} · {event.event} · {event.reason}</p>)}</details>
        {job.tags.lyrics && <><button onClick={()=>downloadLyrics(job.tags.lyrics,"lrc")}>Export retained LRC</button><button onClick={()=>downloadLyrics(job.tags.lyrics,"txt")}>Export retained TXT</button></>}
        {job.verification?.warnings.map(warning => <p key={warning}>{warning}</p>)}
        {job.verification && <><p>{job.verification.actual.codec} · {job.verification.actual.sampleRate} Hz · {job.verification.actual.channels} channels · SHA256 {job.verification.checksumSha256}</p>{job.status === "complete" ? <a className="button" href={`/api/library/conversions/${job.id}/media`}>Download verified output</a> : <p>Temporary-file verification is not completion. Resume/retry to reconcile publication before a completed download is offered.</p>}</>}
        {job.status === "complete" && job.outputTrackId && <><Link href={`/waveyard/play/${job.outputTrackId}`}>Open in library</Link><label><input aria-label={`Select output ${job.name}`} type="checkbox" checked={selected.includes(job.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, job.id] : ids.filter(id => id !== job.id))} />Select for download / session</label></>}
        {!["complete", "failed", "cancelled"].includes(job.status) && <><button onClick={() => void act("cancel", job.id)}>Cancel conversion</button><button onClick={() => void act("resume", job.id)}>Resume unfinished item</button></>}
        {["failed", "cancelled"].includes(job.status) && <button onClick={() => void act("retry", job.id)}>Retry same item</button>}
      </article>)}
      <h3>Continue with selected completed files</h3>
      <button type="button" disabled={busy} onClick={() => setSelected(jobs.filter(job => job.status === "complete" && job.outputTrackId).map(job => job.id))}>Select all completed outputs</button>
      <button type="button" disabled={busy || !selected.length} onClick={() => setSelected([])}>Clear output selection</button>
      {!!selectedOutputs.length && selectedOutputs.length <= 100 && <a className="button" target="_blank" rel="noreferrer" href={`/api/library/conversions/archive?ids=${selectedOutputs.map(job => job.id).join(",")}`}>Download selected verified files (ZIP)</a>}
      <p>{selectedOutputs.length} selected. ZIP download supports up to 100 files / 2 GiB, preserves folder names and embedded metadata, and includes a checksum manifest. Every selected output is checked before the download starts; large batches may take time. Errors open separately, leaving your work here unchanged. Split larger selections or download files individually.</p>
      <p>Adding to a session explicitly arranges full unseparated audio; it does not run or claim vocal separation. Batch order is preserved.</p>
      <label>New session name<input aria-label="Conversion session name" value={sessionName} onChange={e => setSessionName(e.target.value)} /></label>
      <button onClick={() => void request("/api/library/sessions").then(d => setSessions(d.sessions)).catch(e => setError(String(e)))}>Choose existing session</button>
      <select aria-label="Conversion destination session" value={existingSession} onChange={e => setExistingSession(e.target.value)}><option value="">Create new session</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      <button disabled={busy || !selected.length} onClick={() => void toSession()}>Add selected full audio to session</button>
      {sessionLink && <Link href={sessionLink} onClick={event => { if (busy) event.preventDefault(); }}>{busy ? "Updating session — keep this page open" : "Open session → use existing Send to Studio"}</Link>}
    </div>}
  </section>;
}
