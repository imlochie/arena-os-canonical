/**
 * Research — Perplexity.ai (#4) for a local-first app. Answers with citations
 * you can check, grounded in sources the app can actually reach:
 *
 *   1. Your own data (chat history, archive items) — always available, offline
 *   2. The open web via a self-hosted SearXNG (RESEARCH_SEARXNG_URL) — the
 *      Perplexica architecture (Apache-2.0): metasearch + LLM + citations
 *
 * Honesty: sources are numbered and quoted; the answer must cite [n] markers;
 * if no sources are found, the answer says so plainly instead of inventing
 * citations. Web verification is owner-side (the sandbox blocks search
 * endpoints); local-source grounding is fully real here.
 */

import { desc, ilike, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { archiveItems, chatMessages } from "@/db/schema";
import { generate, type ChatMsg } from "@/lib/ai";

export type ResearchSource = {
  id: number;
  title: string;
  snippet: string;
  origin: string; // "chat-history" | "archive" | "web:<engine>"
  url?: string;
};

export async function gatherLocalSources(query: string, limit = 6): Promise<ResearchSource[]> {
  const term = `%${query.trim().slice(0, 80)}%`;
  const words = query.trim().split(/\s+/).filter((w) => w.length > 3).slice(0, 4);
  const match = (col: typeof chatMessages.content) =>
    words.length > 0 ? or(...words.map((w) => ilike(col, `%${w}%`))) : ilike(col, term);

  const chats = await db
    .select({ id: chatMessages.id, content: chatMessages.content, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(and(match(chatMessages.content)))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);
  void sql;

  const archive = await db
    .select({ id: archiveItems.id, name: archiveItems.name, description: archiveItems.description, tags: archiveItems.tags })
    .from(archiveItems)
    .where(or(...(words.length > 0 ? words : [query.trim()]).map((w) => ilike(archiveItems.name, `%${w}%`)), ...words.map((w) => ilike(archiveItems.description, `%${w}%`))))
    .limit(limit);

  const sources: ResearchSource[] = [];
  for (const [i, row] of chats.entries()) {
    sources.push({
      id: i + 1,
      title: `Chat message (${new Date(row.createdAt ?? Date.now()).toLocaleDateString()})`,
      snippet: row.content.slice(0, 320),
      origin: "chat-history",
    });
  }
  for (const row of archive) {
    sources.push({
      id: sources.length + 1,
      title: row.name,
      snippet: (row.description || row.tags || "").slice(0, 320) || "archived item",
      origin: "archive",
    });
  }
  return sources.slice(0, limit);
}

// drizzle and() import shim (kept local so the import list stays minimal)
import { and } from "drizzle-orm";

export type WebSource = { title: string; url: string; snippet: string };

/** SearXNG JSON API (self-hosted; Perplexica's engine). Owner-side network. */
export async function gatherWebSources(query: string, fetchImpl: typeof fetch = fetch): Promise<WebSource[]> {
  const base = process.env.RESEARCH_SEARXNG_URL?.replace(/\/$/, "");
  if (!base) return [];
  try {
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`searxng HTTP ${response.status}`);
    const data = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (data.results ?? [])
      .filter((r) => r.url && r.title)
      .slice(0, 6)
      .map((r) => ({ title: r.title!, url: r.url!, snippet: (r.content ?? "").slice(0, 320) }));
  } catch {
    return []; // honest: web tier unavailable → local sources still answer
  }
}

export type ResearchResult = {
  answer: string;
  sources: ResearchSource[];
  webSources: ResearchSource[];
  backend: string;
  via: string;
  fallback: boolean;
  note?: string;
};

/** Compact, honest footer listing the sources an answer actually used. */
export function researchSourcesFooter(sources: ResearchSource[]): string {
  if (sources.length === 0) return "\n\n— no sources matched; answer is unverified —";
  return (
    "\n\n— sources —\n" +
    sources.map((s) => `[${s.id}] ${s.origin}: ${s.title}${s.url ? ` (${s.url})` : ""}`).join("\n")
  );
}

export async function researchAnswer(
  query: string,
  opts: { keys?: Record<string, string>; modelId?: string; localOnly?: boolean } = {},
): Promise<ResearchResult> {
  // localOnly: Local Mode stays authoritative — local sources only, zero egress.
  const [local, web] = await Promise.all([
    gatherLocalSources(query).catch(() => [] as ResearchSource[]),
    opts.localOnly ? Promise.resolve([]) : gatherWebSources(query),
  ]);
  const webSources: ResearchSource[] = web.map((w, i) => ({
    id: local.length + i + 1,
    title: w.title,
    snippet: w.snippet,
    origin: "web:searxng",
    url: w.url,
  }));
  const sources = [...local, ...webSources];

  const sourceBlock =
    sources.length === 0
      ? "NO SOURCES WERE FOUND. Say so plainly and answer from general knowledge, explicitly flagging that nothing was verified."
      : sources.map((s) => `[${s.id}] (${s.origin}) ${s.title}\n${s.snippet}`).join("\n\n");

  const messages: ChatMsg[] = [
    {
      role: "user",
      content:
        `Research question: ${query}\n\nSOURCES:\n${sourceBlock}\n\n` +
        `Answer with numbered citations like [1] exactly where a claim uses that source. ` +
        `Be direct and specific. If the sources do not cover part of the question, mark that part ` +
        `"unverified". Never invent a citation number that is not in SOURCES.`,
    },
  ];
  const result = await generate({
    modelId: opts.modelId ?? "local-engine",
    messages,
    keys: opts.keys as never,
    temperature: 0.4,
  });
  return {
    answer: result.text,
    sources: local,
    webSources,
    backend: result.backend,
    via: result.via ?? result.backend,
    fallback: result.fallback,
    note: sources.length === 0 ? "No sources matched — answer is unverified general knowledge." : undefined,
  };
}
