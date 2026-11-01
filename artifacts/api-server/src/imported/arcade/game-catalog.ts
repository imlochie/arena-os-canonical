import { createHash } from "node:crypto";
import { safeGithubBytes, RepositoryImportError, type ReadBytes } from "./repository-source";

export type CatalogId = "bobeff" | "trilarion";
export interface CatalogEntry {
  id: string; title: string; summary: string; category: string; sourceUrl: string | null; detailsUrl: string;
  catalogs: string[]; platforms: string[]; codeLicense: string | null; assetLicense: string | null;
}
const origins = {
  bobeff: "https://raw.githubusercontent.com/bobeff/open-source-games/main/README.md",
  trilarion: "https://raw.githubusercontent.com/Trilarion/opensourcegames/master/docs/data/entries.json",
};
// Only catalog data is read. No repository commands, HTML, or code are executed.
const plain = (value: string) => value.replace(/<[^>]*>/g, "").replace(/&(?:amp|quot|apos|lt|gt|#39|#x27);/g,
  entity => ({ "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&#x27;": "'" }[entity] ?? entity))
  .replace(/&#(\d{1,7});/g, (_, number) => { const point = Number(number); return point <= 0x10ffff ? String.fromCodePoint(point) : ""; })
  .replace(/\s+/g, " ").trim().slice(0, 1200);
function publicLink(value: string): string | null {
  try {
    const url = new URL(plain(value));
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname.length > 200 ||
        value.length > 1000 || /[\u0000-\u0020]/.test(url.hostname)) return null;
    if (url.hostname === "github.com" && /^\/[^/]+\/[^/]+\.git\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\.git\/?$/, "");
    return url.href;
  } catch { return null; }
}
const idFor = (catalog: CatalogId, identity: string) => `${catalog}-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
export function parseBobeffCatalog(markdown: string): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  let category = "Other";
  for (const line of markdown.split("\n")) {
    if (/^## Other lists/i.test(line)) break;
    if (/^#{2,4} /.test(line)) category = plain(line.replace(/^#+\s*/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"));
    const title = /^\s*-\s+\*\*(.+?)\*\*/.exec(line)?.[1];
    const source = /\[\[source\]\]\(([^)]+)\)/.exec(line)?.[1];
    if (!title || !source) continue;
    const sourceUrl = publicLink(source);
    if (!sourceUrl) continue;
    entries.push({ id: idFor("bobeff", sourceUrl), title: plain(title.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")).slice(0, 200),
      summary: plain(line.slice(line.indexOf("**", line.indexOf("**") + 2) + 2).replace(/\[\[source\]\].*$/, "").replace(/^\s*-\s*/, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")), category, sourceUrl,
      detailsUrl: "https://github.com/bobeff/open-source-games", catalogs: ["bobeff"], platforms: [], codeLicense: null, assetLicense: null });
  }
  const seen = new Set<string>();
  return entries.filter(entry => { if (seen.has(entry.id)) return false; seen.add(entry.id); return true; });
}
export function parseTrilarionCatalog(json: string): CatalogEntry[] {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed.data) || parsed.data.length > 4000) throw new RepositoryImportError("OSGL changed its catalog layout.", 502);
  const entries: CatalogEntry[] = [];
  for (const row of parsed.data) {
    if (!Array.isArray(row) || row.length < 6 || row.some(value => typeof value !== "string" || value.length > 5000)) continue;
    const link = /<a href="(games\/[A-Za-z0-9_-]+\.html#[A-Za-z0-9_+.():-]+)"[^>]*>([\s\S]*?)<\/a>/.exec(row[0]);
    if (!link) continue; // Engines/frameworks/tools are not game listings.
    entries.push({ id: idFor("trilarion", link[1]), title: plain(link[2]).slice(0, 200), summary: plain(row[2]), category: plain(row[2]).split(",")[0],
      sourceUrl: null, detailsUrl: `https://trilarion.github.io/opensourcegames/${link[1]}`, catalogs: ["trilarion"],
      platforms: plain(row[3]).split(",").map(value => value.trim()).filter(value => value && value !== "-"),
      codeLicense: plain(row[5]) === "-" ? null : plain(row[5]), assetLicense: null });
  }
  return [...new Map(entries.map(entry => [entry.id, entry])).values()];
}
export function resolveTrilarionDetails(entry: CatalogEntry, html: string): CatalogEntry {
  const url = new URL(entry.detailsUrl);
  if (url.origin !== "https://trilarion.github.io" || !/^\/opensourcegames\/games\/[A-Za-z0-9_-]+\.html$/.test(url.pathname)) {
    throw new RepositoryImportError("Invalid catalog details reference.", 502);
  }
  const anchor = url.hash.slice(1);
  const start = html.indexOf(`id="${anchor}"`);
  if (start < 0) throw new RepositoryImportError("The catalog entry moved. Refresh the catalog.", 409);
  const next = html.indexOf('<div id="', start + 5);
  const section = html.slice(start, next < 0 ? undefined : next);
  // Use the labelled source link, never an arbitrary homepage or engine link.
  const field = /(?:Code repositor(?:y|ies)|Source code):?\s*([\s\S]{0,6000}?)(?:<br\s*\/?>|<\/div>)/i.exec(section)?.[1] ?? "";
  const urls = [...field.matchAll(/href="([^"]+)"/g)].map(match => publicLink(match[1])).filter((url): url is string => !!url);
  const sourceUrl = urls.find(url => /^https:\/\/github\.com\/[^/]+\/[^/#?]+\/?$/.test(url)) ?? urls[0] ?? null;
  const assets = /(?:Assets? licen[cs]es?|Content licen[cs]es?):\s*([\s\S]{0,1500}?)(?:<br\s*\/?>|<\/div>)/i.exec(section)?.[1];
  return { ...entry, sourceUrl, assetLicense: assets ? plain(assets) : null };
}

export function createGameCatalog(read: ReadBytes = safeGithubBytes, now = Date.now) {
  type Cache = { entries: CatalogEntry[]; available: boolean; error: string | null; fetchedAt: number | null; retryAt: number };
  const caches = new Map<CatalogId, Cache>();
  const loading = new Map<CatalogId, Promise<void>>();
  const details = new Map<string, { entry: CatalogEntry; expires: number }>();
  async function load(catalog: CatalogId) {
    if ((caches.get(catalog)?.retryAt ?? 0) > now()) return;
    if (loading.has(catalog)) return loading.get(catalog);
    const pending = (async () => {
      try {
        const bytes = await read(origins[catalog], 2 * 1024 * 1024, AbortSignal.timeout(15_000));
        const entries = catalog === "bobeff" ? parseBobeffCatalog(bytes.toString("utf8")) : parseTrilarionCatalog(bytes.toString("utf8"));
        if (!entries.length || entries.length > 4000) throw new Error("Catalog contains no usable game entries or exceeds its bound.");
        caches.set(catalog, { entries, available: true, error: null, fetchedAt: now(), retryAt: now() + 30 * 60_000 });
      } catch {
        const prior = caches.get(catalog);
        caches.set(catalog, { entries: prior?.entries ?? [], available: false, error: "Catalog refresh failed. Any retained results may be out of date.",
          fetchedAt: prior?.fetchedAt ?? null, retryAt: now() + 60_000 });
      } finally { loading.delete(catalog); }
    })();
    loading.set(catalog, pending); return pending;
  }
  return {
    async search(query: string, catalog: string, offset: number) {
      if (typeof query !== "string" || query.length > 80 || !["all", "bobeff", "trilarion"].includes(catalog) ||
          !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new RepositoryImportError("Use a search up to 80 characters and a valid catalog/page.", 400);
      const selected: CatalogId[] = catalog === "all" ? ["bobeff", "trilarion"] : [catalog as CatalogId];
      await Promise.all(selected.map(load));
      const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const entries = selected.flatMap(source => caches.get(source)!.entries).filter(entry => {
        const text = `${entry.title} ${entry.summary} ${entry.category} ${entry.platforms.join(" ")} ${entry.sourceUrl ?? ""}`.toLowerCase();
        return words.every(word => text.includes(word));
      }).sort((a, b) => a.title.localeCompare(b.title));
      const sources = selected.map(catalog => { const source = caches.get(catalog)!;
        return { catalog, available: source.available, error: source.error, fetchedAt: source.fetchedAt }; });
      return { entries: entries.slice(offset, offset + 30), total: entries.length, offset, hasMore: offset + 30 < entries.length, sources };
    },
    async resolve(id: string) {
      if (typeof id !== "string" || !/^(bobeff|trilarion)-[a-f0-9]{24}$/.test(id)) throw new RepositoryImportError("Choose a catalog result.", 400);
      const catalog = id.split("-")[0] as CatalogId;
      await load(catalog);
      const entry = caches.get(catalog)!.entries.find(entry => entry.id === id);
      if (!entry) throw new RepositoryImportError("Catalog entry is unavailable. Search again.", 404);
      if (catalog === "bobeff") return entry;
      const prior = details.get(id);
      if (prior && prior.expires > now()) return prior.entry;
      const url = new URL(entry.detailsUrl);
      const file = url.pathname.replace("/opensourcegames/", "");
      const bytes = await read(`https://raw.githubusercontent.com/Trilarion/opensourcegames/master/docs/${file}`, 1024 * 1024, AbortSignal.timeout(15_000));
      const resolved = resolveTrilarionDetails(entry, bytes.toString("utf8"));
      if (details.size >= 100) details.delete(details.keys().next().value!);
      details.set(id, { entry: resolved, expires: now() + 30 * 60_000 });
      return resolved;
    },
  };
}
export const gameCatalog = createGameCatalog();
