// Cut Lab — project persistence (Postgres best-effort + in-memory fallback).
// Same pattern as studio_jobs: the app keeps working when the DB is down.

import { db } from "@/db";
import { sql, eq, desc } from "drizzle-orm";
import { cutProjects } from "@/db/schema";
import type { CutClip, CutProject } from "./types";

let tableReady = false;
let dbHealthy = true;

const memoryProjects = new Map<string, StoredProject>();

interface StoredProject {
  id: string;
  title: string;
  aspect: string;
  clips: string; // JSON
  createdAt: Date;
  updatedAt: Date;
}

export async function ensureCutTable(): Promise<void> {
  if (tableReady) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "cut_projects" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "title" text DEFAULT 'Untitled cut' NOT NULL,
        "aspect" text DEFAULT '16:9' NOT NULL,
        "clips" text DEFAULT '[]' NOT NULL,
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
  return globalThis.crypto?.randomUUID?.() ?? `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- sanitization ----------

function sanitizeClip(c: any): CutClip | null {
  if (!c || typeof c !== "object") return null;
  const kind = String(c.kind);
  if (kind !== "video" && kind !== "image" && kind !== "procedural") return null;
  const duration = Math.max(0.1, Math.min(600, Number(c.duration) || 4));
  const trimStart = Math.max(0, Math.min(duration, Number(c.trimStart) || 0));
  const trimEnd = Math.max(trimStart + 0.1, Math.min(duration, Number(c.trimEnd) || duration));
  let src: string | undefined;
  if (typeof c.src === "string") {
    // only persist URLs that survive a reload (same-origin paths / http(s));
    // blob: object URLs die with the session → mark the clip unlinked
    const isDurable = /^(\/|https?:)/.test(c.src);
    src = c.src.slice(0, 2000);
    return {
      id: String(c.id ?? "").slice(0, 40) || newId(),
      name: String(c.name ?? "clip").slice(0, 120),
      kind,
      src,
      seed: Number.isFinite(Number(c.seed)) ? Math.floor(Number(c.seed)) : undefined,
      duration,
      trimStart,
      trimEnd,
      volume: Math.max(0, Math.min(1, Number(c.volume) ?? 1)),
      unlinked: !isDurable || c.unlinked === true,
    };
  }
  return {
    id: String(c.id ?? "").slice(0, 40) || newId(),
    name: String(c.name ?? "clip").slice(0, 120),
    kind: "procedural",
    seed: Number.isFinite(Number(c.seed)) ? Math.floor(Number(c.seed)) : Math.floor(Math.random() * 2147483647),
    duration,
    trimStart,
    trimEnd,
    volume: Math.max(0, Math.min(1, Number(c.volume) ?? 1)),
  };
}

function toPublic(row: StoredProject): CutProject & { id: string } {
  let clips: CutClip[] = [];
  try {
    clips = JSON.parse(row.clips || "[]");
  } catch {
    clips = [];
  }
  return {
    id: row.id,
    title: row.title,
    aspect: (row.aspect === "9:16" || row.aspect === "1:1" ? row.aspect : "16:9") as CutProject["aspect"],
    clips,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

// ---------- CRUD ----------

export interface SaveInput {
  id?: string | null;
  title: string;
  aspect: string;
  clips: CutClip[];
}

export async function saveProject(input: SaveInput): Promise<CutProject & { id: string }> {
  const title = (input.title || "Untitled cut").slice(0, 160);
  const aspect = input.aspect === "9:16" || input.aspect === "1:1" ? input.aspect : "16:9";
  const clips = input.clips.slice(0, 200).map(sanitizeClip).filter(Boolean) as CutClip[];
  const now = new Date();

  const existing = input.id ? await getProject(input.id) : null;
  if (input.id && existing) {
    const row: StoredProject = {
      id: existing.id,
      title,
      aspect,
      clips: JSON.stringify(clips),
      createdAt: new Date(existing.createdAt ?? now),
      updatedAt: now,
    };
    memoryProjects.set(row.id, row);
    try {
      await ensureCutTable();
      if (dbHealthy) {
        await db.execute(
          sql`UPDATE "cut_projects" SET "title" = ${title}, "aspect" = ${aspect}, "clips" = ${JSON.stringify(
            clips
          )}, "updated_at" = now() WHERE "id" = ${row.id}`
        );
        memoryProjects.delete(row.id);
      }
    } catch {
      dbHealthy = false;
    }
    return toPublic(row);
  }

  const id = newId();
  const row: StoredProject = { id, title, aspect, clips: JSON.stringify(clips), createdAt: now, updatedAt: now };
  memoryProjects.set(id, row);
  try {
    await ensureCutTable();
    if (dbHealthy) {
      await db.insert(cutProjects).values({ id, title, aspect, clips: JSON.stringify(clips) });
      memoryProjects.delete(id);
    }
  } catch {
    dbHealthy = false;
  }
  return toPublic(row);
}

export async function getProject(id: string): Promise<(CutProject & { id: string }) | null> {
  try {
    await ensureCutTable();
    if (dbHealthy) {
      const rows = await db.select().from(cutProjects).where(eq(cutProjects.id, id)).limit(1);
      if (rows.length) {
        const r = rows[0];
        return toPublic({
          id: r.id,
          title: r.title,
          aspect: r.aspect,
          clips: r.clips,
          createdAt: r.createdAt ?? new Date(),
          updatedAt: r.updatedAt ?? new Date(),
        });
      }
      return null;
    }
  } catch {
    dbHealthy = false;
  }
  const mem = memoryProjects.get(id);
  return mem ? toPublic(mem) : null;
}

export async function listProjects(limit = 20): Promise<(CutProject & { id: string })[]> {
  try {
    await ensureCutTable();
    if (dbHealthy) {
      const rows = await db.select().from(cutProjects).orderBy(desc(cutProjects.updatedAt)).limit(limit);
      return rows.map((r) =>
        toPublic({
          id: r.id,
          title: r.title,
          aspect: r.aspect,
          clips: r.clips,
          createdAt: r.createdAt ?? new Date(),
          updatedAt: r.updatedAt ?? new Date(),
        })
      );
    }
  } catch {
    dbHealthy = false;
  }
  return [...memoryProjects.values()]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, limit)
    .map(toPublic);
}

export async function deleteProject(id: string): Promise<boolean> {
  const existed = memoryProjects.has(id) || (await getProject(id)) !== null;
  memoryProjects.delete(id);
  try {
    await ensureCutTable();
    if (dbHealthy) await db.execute(sql`DELETE FROM "cut_projects" WHERE "id" = ${id}`);
  } catch {
    dbHealthy = false;
  }
  return existed;
}
