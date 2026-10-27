// Archive — the searchable index behind the Archive Assistant.
//
// The archive references files (name / path / size / hash) without ever moving
// or modifying them. Items land with status "inbox"; a scan (model-driven,
// with a deterministic local fallback) describes + categorizes them into
// "indexed". Exact duplicates (content hash, or name+size) are caught at add
// time; the scan additionally flags near-duplicates by name similarity for the
// human to confirm. Descriptions, tags and collections are always drafts the
// human can edit — the index is a catalog, not a source of truth about your
// disk.
//
// House pattern: Postgres when available, in-memory fallback otherwise.

import { db } from "@/db";
import { archiveItems } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { generate } from "@/lib/ai";

// ---------------- types ----------------

export type ArchiveKind = "video" | "image" | "audio" | "doc" | "data" | "other";
export type ArchiveStatus = "inbox" | "indexed" | "duplicate";

export interface ArchiveItem {
  id: string;
  name: string;
  path: string | null;
  kind: ArchiveKind;
  sizeBytes: number | null;
  contentHash: string;
  status: ArchiveStatus;
  description: string;
  tags: string[]; // stored comma-separated, surfaced as array
  collection: string;
  possibleDupOf: string | null;
  source: "manual" | "assistant";
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveItemInput {
  name: string;
  kind?: string;
  path?: string | null;
  sizeBytes?: number | null;
  contentHash?: string | null;
  collection?: string | null;
  tags?: string[];
  projectId?: string | null;
  source?: "manual" | "assistant";
}

export interface ArchiveStats {
  total: number;
  inbox: number;
  indexed: number;
  duplicates: number;
  byKind: Record<string, number>;
  collections: { name: string; n: number }[];
}

export interface ScanOpts {
  keys?: { openrouter?: string; groq?: string; gemini?: string; turboagent?: string };
  localOnly?: boolean;
  limit?: number;
}

export interface ScanResult {
  scanned: number;
  described: number; // got an AI description
  flaggedDuplicates: number;
  via: string;
  items: ArchiveItem[];
}

// ---------------- storage ----------------

interface ItemRowLike {
  id: string;
  name: string;
  path: string | null;
  kind: string;
  sizeBytes: number | null;
  contentHash: string;
  status: string;
  description: string;
  tags: string;
  collection: string;
  possibleDupOf: string | null;
  source: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

const memoryItems = new Map<string, ArchiveItem>();
let dbHealthy = true;
let tableReady = false;

const KINDS: ArchiveKind[] = ["video", "image", "audio", "doc", "data", "other"];

export function normalizeKind(k?: string | null): ArchiveKind {
  const v = String(k ?? "").toLowerCase().trim();
  return (KINDS as string[]).includes(v) ? (v as ArchiveKind) : "other";
}

export function inferKind(name: string): ArchiveKind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["mp4", "mov", "mkv", "avi", "webm", "m4v", "mpg", "mpeg"].includes(ext)) return "video";
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "heic", "svg", "raw"].includes(ext)) return "image";
  if (["mp3", "wav", "flac", "aac", "ogg", "m4a", "aiff"].includes(ext)) return "audio";
  if (["pdf", "doc", "docx", "txt", "md", "rtf", "odt", "pages"].includes(ext)) return "doc";
  if (["csv", "tsv", "xls", "xlsx", "json", "xml", "yaml", "parquet", "db", "sqlite"].includes(ext)) return "data";
  return "other";
}

async function ensureTables(): Promise<void> {
  if (tableReady) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "archive_items" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "name" text NOT NULL,
        "path" text,
        "kind" text DEFAULT 'other' NOT NULL,
        "size_bytes" integer,
        "content_hash" text DEFAULT '' NOT NULL,
        "status" text DEFAULT 'inbox' NOT NULL,
        "description" text DEFAULT '' NOT NULL,
        "tags" text DEFAULT '' NOT NULL,
        "collection" text DEFAULT '' NOT NULL,
        "possible_dup_of" uuid,
        "source" text DEFAULT 'manual' NOT NULL,
        "project_id" uuid,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    tableReady = true;
    dbHealthy = true;
  } catch {
    dbHealthy = false;
  }
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function fromRow(r: ItemRowLike): ArchiveItem {
  return {
    id: r.id,
    name: r.name,
    path: r.path ?? null,
    kind: normalizeKind(r.kind),
    sizeBytes: r.sizeBytes ?? null,
    contentHash: r.contentHash ?? "",
    status: (["inbox", "indexed", "duplicate"].includes(r.status) ? r.status : "inbox") as ArchiveStatus,
    description: r.description ?? "",
    tags: (r.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    collection: r.collection ?? "",
    possibleDupOf: r.possibleDupOf ?? null,
    source: r.source === "assistant" ? "assistant" : "manual",
    projectId: r.projectId ?? null,
    createdAt: new Date(r.createdAt ?? new Date()).toISOString(),
    updatedAt: new Date(r.updatedAt ?? new Date()).toISOString(),
  };
}

async function allItems(): Promise<ArchiveItem[]> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db.select().from(archiveItems).orderBy(desc(archiveItems.createdAt)).limit(2000);
      return rows.map((r) =>
        fromRow({
          id: r.id,
          name: r.name,
          path: r.path ?? null,
          kind: r.kind,
          sizeBytes: r.sizeBytes ?? null,
          contentHash: r.contentHash ?? "",
          status: r.status,
          description: r.description ?? "",
          tags: r.tags ?? "",
          collection: r.collection ?? "",
          possibleDupOf: r.possibleDupOf ?? null,
          source: r.source,
          projectId: r.projectId ?? null,
          createdAt: (r.createdAt ?? new Date()).toISOString(),
          updatedAt: (r.updatedAt ?? new Date()).toISOString(),
        })
      );
    }
  } catch {
    dbHealthy = false;
  }
  return [...memoryItems.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// ---------------- search ----------------

function score(item: ArchiveItem, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const hay = `${item.name} ${item.description} ${item.tags.join(" ")} ${item.collection}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

export async function listArchiveItems(
  opts: { q?: string; kind?: string; status?: string; collection?: string; limit?: number } = {}
): Promise<ArchiveItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const tokens = (opts.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const items = (await allItems()).filter((i) => {
    if (opts.kind && i.kind !== opts.kind) return false;
    if (opts.status && i.status !== opts.status) return false;
    if (opts.collection && i.collection !== opts.collection) return false;
    return score(i, tokens);
  });
  return items.slice(0, limit);
}

export async function getArchiveItem(id: string): Promise<ArchiveItem | null> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db.select().from(archiveItems).where(eq(archiveItems.id, id)).limit(1);
      if (rows.length) {
        const r = rows[0];
        return fromRow({
          id: r.id, name: r.name, path: r.path ?? null, kind: r.kind, sizeBytes: r.sizeBytes ?? null,
          contentHash: r.contentHash ?? "", status: r.status, description: r.description ?? "", tags: r.tags ?? "",
          collection: r.collection ?? "", possibleDupOf: r.possibleDupOf ?? null, source: r.source,
          projectId: r.projectId ?? null, createdAt: (r.createdAt ?? new Date()).toISOString(),
          updatedAt: (r.updatedAt ?? new Date()).toISOString(),
        });
      }
      return null;
    }
  } catch {
    dbHealthy = false;
  }
  return memoryItems.get(id) ?? null;
}

// ---------------- add (with exact dedupe) ----------------

export async function addArchiveItems(
  inputs: ArchiveItemInput[]
): Promise<{ added: ArchiveItem[]; duplicates: ArchiveItem[] }> {
  const existing = await allItems();
  const added: ArchiveItem[] = [];
  const duplicates: ArchiveItem[] = [];

  for (const raw of inputs.slice(0, 200)) {
    const name = String(raw.name ?? "").trim().slice(0, 300);
    if (!name) continue;
    const contentHash = String(raw.contentHash ?? "").trim().slice(0, 120);
    const sizeBytes = raw.sizeBytes != null ? Math.max(0, Math.floor(Number(raw.sizeBytes)) || 0) : null;
    // exact-dupe: same content hash (when given), else same name + size
    const dup = existing.find(
      (e) =>
        (contentHash && e.contentHash && e.contentHash === contentHash) ||
        (e.name.toLowerCase() === name.toLowerCase() && e.sizeBytes != null && sizeBytes != null && e.sizeBytes === sizeBytes)
    );
    if (dup) {
      duplicates.push(dup);
      continue;
    }
    const item: ArchiveItem = {
      id: newId(),
      name,
      path: raw.path ? String(raw.path).slice(0, 500) : null,
      kind: raw.kind ? normalizeKind(raw.kind) : inferKind(name),
      sizeBytes,
      contentHash,
      status: "inbox",
      description: "",
      tags: (raw.tags ?? []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 12),
      collection: raw.collection ? String(raw.collection).trim().slice(0, 80) : "",
      possibleDupOf: null,
      source: raw.source === "assistant" ? "assistant" : "manual",
      projectId: raw.projectId ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    existing.push(item);
    if (dbHealthy) {
      try {
        const [row] = await db
          .insert(archiveItems)
          .values({
            name: item.name, path: item.path, kind: item.kind, sizeBytes: item.sizeBytes,
            contentHash: item.contentHash, status: item.status, description: item.description,
            tags: item.tags.join(","), collection: item.collection, source: item.source, projectId: item.projectId,
          })
          .returning();
        if (row) item.id = row.id;
      } catch {
        dbHealthy = false;
        memoryItems.set(item.id, item);
      }
    } else {
      memoryItems.set(item.id, item);
    }
    added.push(item);
  }
  return { added, duplicates };
}

// ---------------- update ----------------

export interface ArchiveItemPatch {
  description?: string;
  tags?: string[];
  collection?: string;
  status?: string;
  kind?: string;
  possibleDupOf?: string | null;
}

export async function updateArchiveItem(id: string, patch: ArchiveItemPatch): Promise<ArchiveItem | null> {
  const item = await getArchiveItem(id);
  if (!item) return null;
  const next: ArchiveItem = {
    ...item,
    description: patch.description != null ? String(patch.description).slice(0, 4000) : item.description,
    tags: patch.tags != null ? patch.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 12) : item.tags,
    collection: patch.collection != null ? String(patch.collection).trim().slice(0, 80) : item.collection,
    status: patch.status != null ? ((["inbox", "indexed", "duplicate"].includes(patch.status) ? patch.status : item.status) as ArchiveStatus) : item.status,
    kind: patch.kind != null ? normalizeKind(patch.kind) : item.kind,
    possibleDupOf: patch.possibleDupOf !== undefined ? patch.possibleDupOf : item.possibleDupOf,
    updatedAt: new Date().toISOString(),
  };
  try {
    await ensureTables();
    if (dbHealthy) {
      await db
        .update(archiveItems)
        .set({
          description: next.description, tags: next.tags.join(","), collection: next.collection,
          status: next.status, kind: next.kind, possibleDupOf: next.possibleDupOf, updatedAt: new Date(),
        })
        .where(eq(archiveItems.id, id));
    }
  } catch {
    dbHealthy = false;
  }
  if (!dbHealthy) memoryItems.set(id, next);
  return next;
}

// ---------------- stats ----------------

export async function archiveStats(): Promise<ArchiveStats> {
  const items = await allItems();
  const byKind: Record<string, number> = {};
  const coll = new Map<string, number>();
  let inbox = 0, indexed = 0, duplicates = 0;
  for (const i of items) {
    byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
    if (i.collection) coll.set(i.collection, (coll.get(i.collection) ?? 0) + 1);
    if (i.status === "inbox") inbox++;
    else if (i.status === "indexed") indexed++;
    else if (i.status === "duplicate") duplicates++;
  }
  return {
    total: items.length,
    inbox, indexed, duplicates,
    byKind,
    collections: [...coll.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
  };
}

// ---------------- scan (the AI part) ----------------

function nameSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const wa = norm(a), wb = norm(b);
  if (!wa.length || !wb.length) return 0;
  const sa = new Set(wa), sb = new Set(wb);
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / Math.max(sa.size, sb.size);
}

function parseModelJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const slice = candidate.slice(start);
  for (const endTok of ["]", "}"]) {
    const end = slice.lastIndexOf(endTok);
    if (end > 0) {
      try {
        return JSON.parse(slice.slice(0, end + 1));
      } catch {
        /* keep trying */
      }
    }
  }
  return null;
}

export async function scanInbox(opts: ScanOpts = {}): Promise<ScanResult> {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
  const inbox = (await listArchiveItems({ status: "inbox", limit }));
  if (!inbox.length) return { scanned: 0, described: 0, flaggedDuplicates: 0, via: "none", items: [] };

  // near-dupe detection against already-indexed items (deterministic)
  const indexed = await listArchiveItems({ status: "indexed", limit: 500 });
  let flagged = 0;
  for (const item of inbox) {
    const twin = indexed.find((c) => c.id !== item.id && nameSimilarity(c.name, item.name) >= 0.75 && c.kind === item.kind);
    if (twin) {
      await updateArchiveItem(item.id, { possibleDupOf: twin.id });
      item.possibleDupOf = twin.id;
      flagged++;
    }
  }

  // AI describe + categorize (batch). Local fallback keeps the machinery alive
  // without keys/net — descriptions just say so.
  const listing = inbox
    .map((i, n) => `${n + 1}. id=${i.id} name="${i.name}" kind=${i.kind}${i.sizeBytes ? ` size=${i.sizeBytes}` : ""}${i.path ? ` path=${i.path}` : ""}`)
    .join("\n");
  const system =
    "You are the cataloguer inside a personal media archive. For each file entry, write a one-sentence description " +
    "of what the file probably is (infer honestly from the name — never invent specifics you can't know), 3–6 lowercase tags, " +
    "a collection name (short, human, e.g. \"beach trips 2023\"), and your best kind guess. " +
    "Reply ONLY with a JSON array: [{\"n\":1,\"description\":\"…\",\"tags\":[\"…\"],\"collection\":\"…\",\"kind\":\"video\"}].";
  const user = `Catalog these ${inbox.length} files:\n${listing}`;

  let described = 0;
  let via = "local";
  try {
    const res = await generate({
      modelId: "openai",
      messages: [{ role: "user", content: user }],
      system,
      temperature: 0.3,
      keys: opts.localOnly ? undefined : opts.keys,
      localOnly: opts.localOnly,
    });
    via = res.via;
    const parsed = parseModelJson(res.text);
    const isLocal = res.via === "local:text" || res.via === "offline" || res.via === "local";
    if (Array.isArray(parsed) && !isLocal) {
      for (const row of parsed as Record<string, unknown>[]) {
        const n = Math.floor(Number(row.n));
        const item = inbox[n - 1];
        if (!item) continue;
        const description = typeof row.description === "string" ? row.description.trim() : "";
        const tags = Array.isArray(row.tags) ? row.tags.map(String) : [];
        const collection = typeof row.collection === "string" ? row.collection.trim() : "";
        const kind = typeof row.kind === "string" ? row.kind : "";
        const updated = await updateArchiveItem(item.id, {
          description: description || item.description,
          tags: tags.length ? tags : item.tags,
          collection: collection || item.collection,
          kind: kind || item.kind,
          status: "indexed",
        });
        if (updated) {
          Object.assign(item, updated);
          described++;
        }
      }
    }
  } catch {
    via = "error";
  }

  // deterministic pass for anything the model didn't cover (incl. local mode)
  for (const item of inbox) {
    if (item.status !== "indexed") {
      const updated = await updateArchiveItem(item.id, {
        status: "indexed",
        description: item.description || "(no AI description — local mode; edit or add a model key and rescan)",
      });
      if (updated) Object.assign(item, updated);
    }
  }

  return { scanned: inbox.length, described, flaggedDuplicates: flagged, via, items: inbox };
}
