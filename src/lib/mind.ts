/**
 * Mind — the mymind dupe, local-first and free. One private visual wall:
 * throw anything at it (a thought, a link, a quote, an image), the app's
 * models auto-tag and summarize it, and every capture is instantly
 * searchable — by the Mind wall, the Archive, and chat Research mode
 * (captures live in archive_items, so they become research sources too).
 *
 * Honesty: auto-tagging runs through the normal generate() contract with the
 * engine recorded per item. The Local Engine floor produces deterministic
 * keyword tags labeled `local-keywords` — never presented as model insight.
 */

import { and, desc, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { archiveItems } from "@/db/schema";
import { generate } from "@/lib/ai";

export type MindKind = "note" | "link" | "image" | "quote" | "doc" | "audio" | "video";

export type MindItem = {
  id: string;
  name: string;
  kind: MindKind | string;
  content: string | null;
  description: string;
  tags: string[];
  color: string | null;
  favorite: boolean;
  engine: string;
  path: string | null;
  createdAt: string;
};

const URL_RE = /^https?:\/\/\S+$/i;
const CADENCES = ["weekly", "monthly", "quarterly", "yearly"] as const;

/** Classify raw pasted text: a bare URL → link; quoted → quote; else note. */
export function classifyCapture(raw: string): { kind: MindKind; text: string; url?: string } {
  const text = raw.trim();
  if (URL_RE.test(text)) return { kind: "link", text, url: text };
  const firstQuote = text.charCodeAt(0);
  const lastQuote = text.charCodeAt(text.length - 1);
  if ((firstQuote === 0x22 || firstQuote === 0x201c) && (lastQuote === 0x22 || lastQuote === 0x201d) && text.length > 2) {
    return { kind: "quote", text: text.slice(1, -1).trim() };
  }
  return { kind: "note", text };
}

/** Deterministic keyword tags — the honest offline floor. */
export function localKeywordTags(text: string, kind: MindKind): string[] {
  const stop = new Set(
    "the a an and or but if then else for to of in on at by with from as is are was were be been this that these those it its you your i we they he she them his her our their about into over under more most some any all can will just not no yes do does did doing have has had".split(" "),
  );
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stop.has(w) && !/^\d+$/.test(w));
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const tags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([w]) => w);
  return [kind, ...tags].slice(0, 6);
}

function parseTagReply(reply: string): { tags: string[]; summary: string } | null {
  const fence = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : reply;
  const jsonStart = candidate.indexOf("{");
  const jsonEnd = candidate.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd <= jsonStart) return null;
  try {
    const parsed = JSON.parse(candidate.slice(jsonStart, jsonEnd + 1)) as { tags?: unknown; summary?: unknown };
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.map((t) => String(t).trim().toLowerCase().replace(/[^a-z0-9 -]/g, "").slice(0, 24)).filter(Boolean).slice(0, 6)
      : [];
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 240) : "";
    if (tags.length === 0 && !summary) return null;
    return { tags, summary };
  } catch {
    return null;
  }
}

export async function autoProcess(
  text: string,
  kind: MindKind,
  opts: { keys?: Record<string, string>; modelId?: string } = {},
): Promise<{ tags: string[]; summary: string; engine: string }> {
  const prompt =
    `A ${kind} was saved to a personal mind app. Content:\n"""\n${text.slice(0, 4000)}\n"""\n\n` +
    `Reply with ONLY a JSON object: {"tags": [3-6 short lowercase topic tags], "summary": "one sentence, max 20 words"}. No prose.`;
  const result = await generate({ modelId: opts.modelId ?? "local-engine", messages: [{ role: "user", content: prompt }], keys: opts.keys as never, temperature: 0.3 });
  const parsed = parseTagReply(result.text);
  if (parsed && (parsed.tags.length > 0 || parsed.summary)) {
    const tags = parsed.tags.length > 0 ? parsed.tags : localKeywordTags(text, kind);
    return { tags: [kind, ...tags].slice(0, 7), summary: parsed.summary, engine: result.backend };
  }
  // Honest fallback: keyword tags, clearly labeled.
  return {
    tags: localKeywordTags(text, kind),
    summary: kind === "link" ? `Link saved from ${new URL(text).hostname}` : text.trim().split(/\s+/).slice(0, 18).join(" "),
    engine: "local-keywords",
  };
}

export async function createMindItem(
  input: { text: string; kind?: MindKind; color?: string; favorite?: boolean; path?: string; name?: string },
  opts: { keys?: Record<string, string>; modelId?: string } = {},
): Promise<MindItem> {
  const classified = input.kind ? { kind: input.kind, text: input.text, url: input.kind === "link" ? input.text : undefined } : classifyCapture(input.text);
  const auto = await autoProcess(classified.text, classified.kind, opts);
  const name =
    input.name?.trim().slice(0, 120) ||
    (classified.kind === "link" && classified.url ? new URL(classified.url).hostname.replace(/^www\./, "") : classified.text.slice(0, 80));
  const [row] = await db
    .insert(archiveItems)
    .values({
      name,
      kind: classified.kind,
      content: classified.text.slice(0, 20_000),
      description: auto.summary,
      tags: auto.tags.join(","),
      color: input.color?.slice(0, 9) || null,
      favorite: input.favorite ?? false,
      engine: auto.engine,
      status: "indexed",
      source: "manual",
      path: input.path ?? null,
    })
    .returning();
  return toMindItem(row);
}

export async function listMindItems(filter: { q?: string; kind?: string; tag?: string; favoritesOnly?: boolean; limit?: number } = {}): Promise<MindItem[]> {
  const conditions = [];
  if (filter.q?.trim()) {
    const term = `%${filter.q.trim().slice(0, 80)}%`;
    conditions.push(or(ilike(archiveItems.name, term), ilike(archiveItems.description, term), ilike(archiveItems.tags, term), ilike(archiveItems.content, term)));
  }
  if (filter.kind) conditions.push(eq(archiveItems.kind, filter.kind));
  if (filter.tag) conditions.push(ilike(archiveItems.tags, `%${filter.tag.toLowerCase()}%`));
  if (filter.favoritesOnly) conditions.push(eq(archiveItems.favorite, true));
  const rows = await db
    .select()
    .from(archiveItems)
    .where(conditions.length > 0 ? and(...conditions) : sql`true`)
    .orderBy(desc(archiveItems.createdAt))
    .limit(Math.min(filter.limit ?? 200, 500));
  return rows.map(toMindItem);
}

export async function toggleFavorite(id: string): Promise<boolean | null> {
  const [row] = await db
    .update(archiveItems)
    .set({ favorite: sql`not ${archiveItems.favorite}`, updatedAt: new Date() })
    .where(eq(archiveItems.id, id))
    .returning({ favorite: archiveItems.favorite });
  return row?.favorite ?? null;
}

export async function updateItemTags(id: string, tags: string[]): Promise<MindItem | null> {
  const clean = tags.map((t) => t.trim().toLowerCase().slice(0, 24)).filter(Boolean).slice(0, 12);
  const [row] = await db.update(archiveItems).set({ tags: clean.join(","), updatedAt: new Date() }).where(eq(archiveItems.id, id)).returning();
  return row ? toMindItem(row) : null;
}

export async function deleteMindItem(id: string): Promise<boolean> {
  const removed = await db.delete(archiveItems).where(eq(archiveItems.id, id)).returning({ id: archiveItems.id });
  return removed.length > 0;
}

/** Smart spaces (mymind): saved filters that fill themselves from auto-tags. */
export type SmartSpace = { name: string; tags: string[]; kinds: string[]; q?: string };

export function smartSpaceMatches(item: MindItem, space: SmartSpace): boolean {
  if (space.kinds.length > 0 && !space.kinds.includes(String(item.kind))) return false;
  if (space.tags.length > 0) {
    const hasAll = space.tags.every((tag) => item.tags.includes(tag.toLowerCase()));
    if (!hasAll) return false;
  }
  if (space.q?.trim()) {
    const term = space.q.trim().toLowerCase();
    const haystack = `${item.name} ${item.description} ${item.tags.join(" ")} ${item.content ?? ""}`.toLowerCase();
    if (!haystack.includes(term)) return false;
  }
  return true;
}

/** Serendipity (mymind): resurface one older item you have not touched lately. */
export function serendipityPick(items: MindItem[], now = Date.now()): MindItem | null {
  if (items.length === 0) return null;
  const maxAge = Math.max(...items.map((item) => now - new Date(item.createdAt).getTime()), 1);
  // Weight toward older, non-favorite items (favorites are already seen often).
  const weights = items.map((item) => {
    const age = Math.max(0, now - new Date(item.createdAt).getTime());
    return (0.2 + age / maxAge) * (item.favorite ? 0.5 : 1);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (const [index, weight] of weights.entries()) {
    roll -= weight;
    if (roll <= 0) return items[index];
  }
  return items[items.length - 1];
}

function toMindItem(row: typeof archiveItems.$inferSelect): MindItem {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    content: row.content,
    description: row.description,
    tags: row.tags ? row.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    color: row.color,
    favorite: row.favorite,
    engine: row.engine,
    path: row.path,
    createdAt: row.createdAt.toISOString(),
  };
}

void CADENCES;
