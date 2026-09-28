"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";

type Card = { id: string; title: string; description: string; genre: string | null; tags: string[]; licenseCode: string; creatorDisplayName: string; updatedAt: string };

export function DiscoverCatalog() {
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [items, setItems] = useState<Card[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (next?: string | null, append = false) => {
    setLoading(true); setError(null);
    const params = new URLSearchParams(); if (query) params.set("q", query); if (genre) params.set("genre", genre); if (next) params.set("cursor", next);
    const response = await fetch(`/api/public/projects?${params}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({})); setLoading(false);
    if (!response.ok) return setError(body.error ?? "Discovery could not be loaded.");
    setItems((current) => append ? [...current, ...(body.projects ?? [])] : body.projects ?? []); setCursor(body.nextCursor ?? null);
  }, [genre, query]);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  const submit = (event: FormEvent) => { event.preventDefault(); void load(null, false); };
  return <section className="discover-catalog">
    <form className="discover-controls" onSubmit={submit}><label>Search<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, creator, or tag" maxLength={120} /></label><label>Genre<input value={genre} onChange={(event) => setGenre(event.target.value)} placeholder="Any genre" maxLength={80} /></label><button className="button">Search</button></form>
    {error && <p className="error" role="alert">{error}</p>}
    {loading && !items.length && <p className="notice">Loading public projects…</p>}
    {!loading && !error && !items.length && <p className="notice">No public projects match this catalogue search.</p>}
    <div className="public-grid">{items.map((project) => <article className="public-card" key={project.id}><span className="eyebrow">{project.genre || "Open genre"}</span><h2><Link href={`/p/${project.id}`}>{project.title}</Link></h2><p>{project.description || "No public description yet."}</p><p className="muted">By {project.creatorDisplayName} · {project.licenseCode}</p>{project.tags.length > 0 && <p className="tags">{project.tags.map((tag) => <span key={tag}>#{tag}</span>)}</p>}<Link className="button secondary" href={`/p/${project.id}`}>Open release</Link></article>)}</div>
    {cursor && <button className="button secondary" disabled={loading} onClick={() => void load(cursor, true)}>{loading ? "Loading…" : "Load more"}</button>}
  </section>;
}
