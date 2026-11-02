import { useEffect, useRef, useState } from "react";
import {
  resolveArcadeCatalogGame, searchArcadeCatalog, type ArcadeCatalogEntry,
} from "@workspace/api-client-react";

type Catalog = "all" | "bobeff" | "trilarion";
type Result = Awaited<ReturnType<typeof searchArcadeCatalog>>;

const SOURCES: Record<string, { name: string; url: string }> = {
  bobeff: { name: "bobeff/open-source-games", url: "https://github.com/bobeff/open-source-games" },
  trilarion: { name: "Trilarion OSGL", url: "https://trilarion.github.io/opensourcegames/" },
};
const CATALOG_SOURCE = /^https:\/\/(?:(?:github\.com|codeberg\.org)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|sourceforge\.net\/projects\/[A-Za-z0-9_-]+)(?:\/.*)?$/i;
const safeHref = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : undefined);
const errText = (c: unknown, f: string) => {
  const e = c as { data?: { error?: string }; message?: string };
  return e?.data?.error || e?.message || f;
};

export default function GameCatalogBrowser({ disabled, onChooseRepository }: {
  disabled: boolean;
  onChooseRepository: (url: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<Catalog>("all");
  const [result, setResult] = useState<Result | null>(null);
  const [last, setLast] = useState<{ query: string; catalog: Catalog } | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [resolving, setResolving] = useState<string | null>(null);
  const [chosen, setChosen] = useState<{ entry: ArcadeCatalogEntry; supported: boolean } | null>(null);
  const [resolveError, setResolveError] = useState("");
  const seq = useRef(0);
  const ctl = useRef<AbortController | null>(null);
  const rseq = useRef(0);
  const rctl = useRef<AbortController | null>(null);
  useEffect(() => () => { ctl.current?.abort(); rctl.current?.abort(); }, []);

  const search = async (q: string, cat: Catalog, offset: number) => {
    ctl.current?.abort();
    const c = new AbortController(); ctl.current = c;
    const id = ++seq.current;
    setSearching(true); setError("");
    try {
      const r = await searchArcadeCatalog({ query: q, catalog: cat, offset }, { signal: c.signal });
      if (id !== seq.current) return;
      setResult(r); setLast({ query: q, catalog: cat });
    } catch (cause) {
      if (id !== seq.current || c.signal.aborted) return;
      setError(errText(cause, "Catalog search failed. Try again."));
    } finally {
      if (id === seq.current) setSearching(false);
    }
  };

  const choose = async (entry: ArcadeCatalogEntry) => {
    rctl.current?.abort();
    const c = new AbortController(); rctl.current = c;
    const id = ++rseq.current;
    setResolving(entry.id); setResolveError(""); setChosen(null);
    try {
      const full = await resolveArcadeCatalogGame({ id: entry.id }, { signal: c.signal });
      if (id !== rseq.current) return;
      const supported = !!full.sourceUrl && CATALOG_SOURCE.test(full.sourceUrl);
      setChosen({ entry: full, supported });
      if (supported && full.sourceUrl) onChooseRepository(full.sourceUrl);
    } catch (cause) {
      if (id !== rseq.current || c.signal.aborted) return;
      setResolveError(errText(cause, "Could not resolve that catalog entry."));
    } finally {
      if (id === rseq.current) setResolving(null);
    }
  };

  const submit = () => { if (!disabled) void search(query.trim(), catalog, 0); };
  const outages = result?.sources.filter(s => !s.available) ?? [];
  const pageSize = result?.entries.length ?? 0;
  const off = result?.offset ?? 0;

  return <div data-testid="catalog-browser" className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-slate-300">
    <h4 className="text-[11px] font-extrabold uppercase tracking-wide text-emerald-100">Find in open-source catalogs</h4>
    <p className="mt-1 text-slate-400">
      Searches <a className="underline" href={SOURCES.bobeff.url} target="_blank" rel="noreferrer noopener">{SOURCES.bobeff.name}</a> and{" "}
      <a className="underline" href={SOURCES.trilarion.url} target="_blank" rel="noreferrer noopener">{SOURCES.trilarion.name}</a>. Choosing a game starts the normal review below; nothing installs without it.
    </p>
    <form className="mt-2 flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); submit(); }}>
      <input data-testid="input-catalog-query" value={query} onChange={e => setQuery(e.target.value)} placeholder="Title, genre..."
        aria-label="Catalog search" disabled={disabled}
        className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-slate-100 disabled:opacity-50" />
      <select data-testid="select-catalog" value={catalog} onChange={e => setCatalog(e.target.value as Catalog)} disabled={disabled}
        aria-label="Catalog source" className="rounded-lg border border-white/15 bg-black/30 px-2 py-2 text-slate-100">
        <option value="all">All catalogs</option>
        <option value="bobeff">{SOURCES.bobeff.name}</option>
        <option value="trilarion">{SOURCES.trilarion.name}</option>
      </select>
      <button type="submit" data-testid="search-catalog" disabled={disabled || searching}
        className="rounded-lg border border-emerald-300/30 px-3 py-2 font-bold text-emerald-100 disabled:opacity-50">
        {searching ? "Searching..." : "Search"}
      </button>
    </form>

    {error && <p role="alert" data-testid="catalog-error" className="mt-2 text-red-200">{error}
      {" "}<button type="button" className="underline" onClick={submit}>Retry</button></p>}
    {outages.length > 0 && <ul role="status" data-testid="catalog-outages" className="mt-2 space-y-0.5 rounded-md border border-amber-300/30 bg-amber-300/10 p-2 text-amber-100">
      {outages.map(s => <li key={s.catalog}>{SOURCES[s.catalog]?.name ?? s.catalog} unavailable{s.error ? `: ${s.error}` : ""}. Results may be incomplete.</li>)}
    </ul>}

    {searching && !result && <ul className="mt-2 space-y-1.5" aria-hidden>{[0, 1, 2].map(i =>
      <li key={i} className="h-10 animate-pulse rounded-md bg-white/5" />)}</ul>}

    {result && <div className={`mt-2 ${searching ? "opacity-60" : ""}`} aria-busy={searching}>
      <p className="text-[11px] text-slate-500">
        {result.total === 0 ? `No games match "${last?.query ?? ""}".` : `${off + 1}-${off + pageSize} of ${result.total}`}
      </p>
      <ul className="mt-1 max-h-72 space-y-1.5 overflow-auto">{result.entries.map(e => {
        const sel = chosen?.entry.id === e.id;
        return <li key={e.id} className={`rounded-md border p-2 ${sel ? "border-emerald-300/40 bg-emerald-300/5" : "border-white/10"}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-bold text-slate-100">{e.title} <span className="font-normal text-slate-500">{e.category}</span></p>
              {e.summary && <p className="mt-0.5 line-clamp-2 text-slate-400">{e.summary}</p>}
              <p className="mt-1 font-mono text-[10px] text-slate-500">
                {e.catalogs.map(c => SOURCES[c]?.name ?? c).join(" + ")}
                {e.platforms.length > 0 && ` | ${e.platforms.join(", ")}`}
                {(e.codeLicense || e.assetLicense) && ` | listed: code ${e.codeLicense ?? "?"}, assets ${e.assetLicense ?? "?"}`}
              </p>
            </div>
            <button type="button" data-testid={`choose-catalog-${e.id}`} disabled={disabled || resolving !== null}
              onClick={() => void choose(e)} className="rounded-md bg-emerald-300 px-2 py-1 font-extrabold text-slate-950 disabled:opacity-50">
              {resolving === e.id ? "Resolving..." : "Choose"}
            </button>
          </div>
        </li>; })}</ul>
      {result.total > 0 && <div className="mt-2 flex gap-2">
        <button type="button" disabled={searching || off === 0 || !last} onClick={() => last && void search(last.query, last.catalog, Math.max(0, off - Math.max(pageSize, 1)))}
          className="rounded-md border border-white/15 px-2 py-1 disabled:opacity-40">Previous</button>
        <button type="button" disabled={searching || !result.hasMore || !last} onClick={() => last && void search(last.query, last.catalog, off + pageSize)}
          className="rounded-md border border-white/15 px-2 py-1 disabled:opacity-40">Next</button>
      </div>}
    </div>}

    {resolveError && <p role="alert" className="mt-2 text-red-200">{resolveError}</p>}
    {chosen && <div data-testid="catalog-chosen" className="mt-2 rounded-md border border-white/10 bg-white/5 p-2">
      <p><strong className="text-slate-100">{chosen.entry.title}</strong>{" "}
        {safeHref(chosen.entry.detailsUrl) && <a className="underline" href={safeHref(chosen.entry.detailsUrl)} target="_blank" rel="noreferrer noopener">catalog details</a>}</p>
      {chosen.supported
        ? <p className="mt-1 text-slate-400">Provider source found. Its pinned review decides whether anything can be imported; SourceForge downloads stay blocked without verified source and license evidence.</p>
        : <p data-testid="catalog-unsupported" className="mt-1 text-amber-100">
            {chosen.entry.sourceUrl ? <>Source is hosted at <a className="underline break-all" href={safeHref(chosen.entry.sourceUrl)} target="_blank" rel="noreferrer noopener">{chosen.entry.sourceUrl}</a>, which</> : "No source link is listed, so"} Arcade can't review or install it. Supported sources are GitHub, Codeberg, and SourceForge project pages.
          </p>}
      <p className="mt-1 text-[11px] text-slate-500">Catalog licenses are unverified hints, not permission to install. Engine code may need game assets you must own separately.</p>
    </div>}
  </div>;
}
