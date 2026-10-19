"use client";
import { FormEvent, useState } from "react";
import Link from "next/link";
import type {
  inspectArchiveAudio,
  searchArchiveAudio,
} from "@/lib/waveyard/archive-audio";
type Item = Awaited<ReturnType<typeof inspectArchiveAudio>>;
type Hit = Awaited<ReturnType<typeof searchArchiveAudio>>[number];
export function ArchiveAudioDiscovery() {
  const [query, setQuery] = useState(""),
    [hits, setHits] = useState<Hit[]>([]),
    [item, setItem] = useState<Item | null>(null),
    [reviewed, setReviewed] = useState(false),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [track, setTrack] = useState<string | null>(null);
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
          {item.files.map((file) => (
            <div key={file.name}>
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
      {track && (
        <Link href={`/waveyard/play/${track}`}>
          Open imported audio in Waveyard
        </Link>
      )}
    </section>
  );
}
