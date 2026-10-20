"use client";
import { FormEvent, useState, useEffect } from "react";
import Link from "next/link";
import type {
  inspectArchiveAudio,
  searchArchiveAudio,
} from "@/lib/waveyard/archive-audio";
type Item = Awaited<ReturnType<typeof inspectArchiveAudio>>;
type Job = { id: string; file: string; status: string; stage: string; index: number; receivedBytes: number; totalBytes: number; error: string | null; outputTrackId?: string; events: Array<{at: string; event: string; reason?: string}>; publications: Array<{trackId: string}> };
type Hit = Awaited<ReturnType<typeof searchArchiveAudio>>[number];
export function ArchiveAudioDiscovery() {
  const [query, setQuery] = useState(""),
    [hits, setHits] = useState<Hit[]>([]),
    [item, setItem] = useState<Item | null>(null),
    [reviewed, setReviewed] = useState(false),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [track, setTrack] = useState<string | null>(null);
  const [queueError, setQueueError] = useState("");
  const [batchId, setBatchId] = useState(""), [selected, setSelected] = useState<string[]>([]), [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    let disposed = false;
    const load = async () => { try { const response = await fetch("/api/library/catalogue/jobs"); if (!response.ok) throw new Error("History unavailable");
      const body = await response.json(); if (!disposed) { setJobs(body.jobs); setQueueError(""); } } catch { if (!disposed) setQueueError("Acquisition history unavailable. Existing jobs/results are retained; reconnect or retry."); } };
    void load(); const timer = setInterval(() => void load(), 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  async function queueAction(body: object) {
    setBusy(true);
    try { await request("/api/library/catalogue/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await request("/api/library/catalogue/jobs"); setJobs(result.jobs); setStatus("Durable acquisition request saved. Completion requires validated audio; Resume restarts download after a runtime restart.");
    } catch (error) { setStatus(String(error)); } finally { setBusy(false); }
  }
  async function request(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Source unavailable.");
    return body;
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus("Searching public audio references…");
    setTrack(null);
    try {
      const body = await request(
        `/api/library/catalogue?q=${encodeURIComponent(query)}`,
      );
      setHits(body.items);
      setItem(null);
      setStatus(
        "References only. Inspect source and rights before preview or import.",
      );
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function inspect(id: string) {
    setBusy(true);
    setReviewed(false);
    setSelected([]); setBatchId("");
    setTrack(null);
    try {
      const body = await request(
        `/api/library/catalogue/${encodeURIComponent(id)}`,
      );
      setItem(body.item);
      setStatus(
        "Review recording and composition rights; uploader metadata is not a warranty.",
      );
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function acquire(file: string) {
    if (!item) return;
    setBusy(true);
    setStatus("Acquiring, probing and checksum-verifying original audio…");
    try {
      const body = await request(
        `/api/library/catalogue/${encodeURIComponent(item.id)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file, rightsReviewed: reviewed }),
        },
      );
      setTrack(body.track.id);
      setStatus(body.notice);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Internet Archive public audio">
      <h2>Find public audio · Internet Archive</h2>
      <p>
        A limited open-audio source, not a commercial streaming catalogue. No
        account or new subscription is configured here. Service availability,
        uploader rights claims and{" "}
        <a
          href="https://archive.org/about/terms.php"
          target="_blank"
          rel="noreferrer"
        >
          Archive terms
        </a>{" "}
        still apply. Public availability alone is not permission to remix.
      </p>
      <form onSubmit={search}>
        <label>
          Find audio
          <input
            aria-label="Find public audio"
            value={query}
            maxLength={120}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button disabled={busy || !query.trim()}>Search public audio</button>
      </form>
      <p role="status">{status}</p>
      {hits.map((hit) => (
        <article key={hit.id}>
          <h3>{hit.title || hit.id}</h3>
          <p>
            {hit.artist} ·{" "}
            {hit.licence?.label ?? "No supported remix grant identified"} ·
            reference only
          </p>
          <button disabled={busy} onClick={() => void inspect(hit.id)}>
            Review source / available audio
          </button>
        </article>
      ))}
      {item && (
        <article>
          <h3>{item.title}</h3>
          <a href={item.sourceUrl} target="_blank" rel="noreferrer">
            Original item and uploader notices
          </a>
          <p>{item.rightsNotice}</p>
          {item.licence ? (
            <a href={item.licence.url} target="_blank" rel="noreferrer">
              {item.licence.label} · read terms
            </a>
          ) : (
            <p>No supported unambiguous CC0/CC-BY licence: import disabled.</p>
          )}
          <label>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            I reviewed the recording/composition rights, applicable source
            terms, notices and attribution. I am authorised to acquire and adapt
            this file.
          </label>
          <button disabled={busy || !reviewed || !selected.length} onClick={() => { const id = batchId || crypto.randomUUID(); setBatchId(id); void queueAction({ action: "create", batchId: id, id: item.id, files: selected, rightsReviewed: reviewed }); }}>Enqueue selected audio ({selected.length})</button>
          <p>Select in the desired playlist order. Original audio only; no separation is inferred.</p>
          {item.files.map((file) => (
            <div key={file.name}>
              <label><input type="checkbox" disabled={busy || !file.importEligible || !file.sha1} checked={selected.includes(file.name)}
                onChange={event => { setBatchId(""); setSelected(previous => event.target.checked ? [...previous, file.name] : previous.filter(name => name !== file.name)); }} />Select {file.name}{selected.includes(file.name) ? ` · position ${selected.indexOf(file.name) + 1}` : ""}</label>
              <p>
                {file.name} · {file.bytes.toLocaleString()} bytes
              </p>
              {reviewed && (
                <audio
                  aria-label={`Preview ${file.name}`}
                  controls
                  preload="none"
                  src={file.previewUrl}
                  onError={() =>
                    setStatus(
                      "Preview unavailable. A listed file is not proof of playable access.",
                    )
                  }
                />
              )}
              <button
                disabled={busy || !reviewed || !file.importEligible}
                onClick={() => void acquire(file.name)}
              >
                Import reviewed original audio
              </button>
            </div>
          ))}
          <p>
            Attribution: {item.title} — {item.artist}; {item.sourceUrl};{" "}
            {item.licence?.url ?? "licence unresolved"}. Retain notices and
            describe changes on export. Separation is not run by importing.
          </p>
        </article>
      )}
      {queueError && <p role="alert">{queueError}</p>}
      {jobs.length > 0 && <section aria-label="Durable audio acquisitions"><h3>Acquisition jobs</h3>
        <p>Resume restarts download from zero; Retry is explicit for failed/cancelled jobs. Cancellation near publication can leave a verified library asset, which is retained.</p>
        {jobs.map(job => <article key={job.id}><p>{job.index + 1}. {job.file} · {job.status} · {job.stage} · {job.receivedBytes}/{job.totalBytes} bytes</p>
          {job.error && <p role="alert">{job.error}</p>}
          <details><summary>Attempt history</summary>{job.events.map((event, index) => <p key={index}>{event.at} · {event.event}{event.reason ? ` · ${event.reason}` : ""}</p>)}</details>
          {!['complete','failed','cancelled'].includes(job.status) && <><button disabled={busy} onClick={() => void queueAction({ action: 'cancel', id: job.id })}>Cancel acquisition</button><button disabled={busy} onClick={() => void queueAction({ action: 'resume', id: job.id })}>Resume after restart</button></>}
          {['failed','cancelled'].includes(job.status) && <button disabled={busy} onClick={() => void queueAction({ action: 'retry', id: job.id })}>Retry acquisition</button>}
          {[...new Set([job.outputTrackId, ...job.publications.map(p => p.trackId)].filter((id): id is string => !!id))].map(id => <p key={id}><Link href={`/waveyard/play/${id}`}>Play verified library audio / open in Waveyard</Link></p>)}
        </article>)}
      </section>}
      {track && (
        <Link href={`/waveyard/play/${track}`}>
          Open imported audio in Waveyard
        </Link>
      )}
    </section>
  );
}
