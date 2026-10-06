/**
 * Waveyard — music workspace core (canonical mount).
 *
 * Ported from the arena/01a0bebf integrated monorepo, adapted to the canonical
 * app: same project flow / audio asset flow / waveform / arrangement-version
 * semantics, with the storage simplified to the local filesystem
 * (.data/waveyard/) and waveform peaks computed in the browser (Web Audio)
 * instead of by the separate worker. Stem separation and source analysis
 * (tempo/key/drums/harmony/vocals) genuinely require the Waveyard worker +
 * models — the UI reports them as unavailable rather than faking them.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { wyProjects, wySources, wyVersions } from "@/db/schema";

export const WAVEYARD_DATA_DIR = path.join(process.cwd(), ".data", "waveyard");
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

export const ACCEPTED_AUDIO = new Set([
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/wave", "audio/flac",
  "audio/mp4", "audio/m4a", "audio/aac", "audio/ogg", "audio/vorbis",
  "audio/webm",
]);

export interface WaveyardSource {
  id: string;
  projectId: string;
  name: string;
  mediaType: string;
  bytes: number;
  durationMs: number;
  peaks: { min: number; max: number }[] | null;
  audioUrl: string;
  createdAt: string;
}

export interface WaveyardVersion {
  id: string;
  projectId: string;
  name: string;
  arrangement: unknown;
  createdAt: string;
}

export interface WaveyardProject {
  id: string;
  title: string;
  notes: string;
  bpm: number | null;
  musicalKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WaveyardArrangement {
  bpm: number | null;
  tracks: { index: number; label: string }[];
  clips: {
    id: string;
    sourceId: string;
    trackIndex: number;
    startMs: number;
    durationMs: number; // slice of the source (≤ source length)
    offsetMs: number; // into the source
    gain: number;
  }[];
}

function toProject(r: typeof wyProjects.$inferSelect): WaveyardProject {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    bpm: r.bpm ?? null,
    musicalKey: r.musicalKey ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toSource(r: typeof wySources.$inferSelect): WaveyardSource {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    mediaType: r.mediaType,
    bytes: r.bytes,
    durationMs: r.durationMs,
    peaks: (r.peaks as { min: number; max: number }[] | null) ?? null,
    audioUrl: `/api/waveyard/sources/${r.id}/audio`,
    createdAt: r.createdAt.toISOString(),
  };
}

function toVersion(r: typeof wyVersions.$inferSelect): WaveyardVersion {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    arrangement: r.arrangement,
    createdAt: r.createdAt.toISOString(),
  };
}

// ---------------- projects ----------------

export async function listWaveyardProjects(): Promise<WaveyardProject[]> {
  const rows = await db.select().from(wyProjects).orderBy(desc(wyProjects.updatedAt)).limit(200);
  return rows.map(toProject);
}

export async function createWaveyardProject(input: {
  title?: string;
  notes?: string;
  bpm?: number | null;
  musicalKey?: string | null;
}): Promise<WaveyardProject> {
  const [row] = await db
    .insert(wyProjects)
    .values({
      title: (input.title ?? "Untitled project").toString().slice(0, 120),
      notes: (input.notes ?? "").toString().slice(0, 4000),
      bpm: input.bpm ?? null,
      musicalKey: input.musicalKey ?? null,
    })
    .returning();
  return toProject(row);
}

export async function getWaveyardProject(id: string): Promise<{
  project: WaveyardProject;
  sources: WaveyardSource[];
  versions: WaveyardVersion[];
} | null> {
  const [row] = await db.select().from(wyProjects).where(eq(wyProjects.id, id)).limit(1);
  if (!row) return null;
  const srcs = await db.select().from(wySources).where(eq(wySources.projectId, id)).orderBy(wySources.createdAt);
  const vers = await db.select().from(wyVersions).where(eq(wyVersions.projectId, id)).orderBy(desc(wyVersions.createdAt)).limit(50);
  return { project: toProject(row), sources: srcs.map(toSource), versions: vers.map(toVersion) };
}

export async function updateWaveyardProject(
  id: string,
  patch: { title?: string; notes?: string; bpm?: number | null; musicalKey?: string | null },
): Promise<WaveyardProject | null> {
  const [row] = await db
    .update(wyProjects)
    .set({
      ...(patch.title !== undefined ? { title: patch.title.slice(0, 120) } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes.slice(0, 4000) } : {}),
      ...(patch.bpm !== undefined ? { bpm: patch.bpm } : {}),
      ...(patch.musicalKey !== undefined ? { musicalKey: patch.musicalKey } : {}),
      updatedAt: new Date(),
    })
    .where(eq(wyProjects.id, id))
    .returning();
  return row ? toProject(row) : null;
}

export async function deleteWaveyardProject(id: string): Promise<boolean> {
  const srcs = await db.select().from(wySources).where(eq(wySources.projectId, id));
  for (const s of srcs) {
    try {
      const p = path.join(WAVEYARD_DATA_DIR, s.storageKey);
      if (existsSync(p)) await (await import("node:fs/promises")).rm(p);
    } catch {}
  }
  await db.delete(wyVersions).where(eq(wyVersions.projectId, id));
  await db.delete(wySources).where(eq(wySources.projectId, id));
  const rows = await db.delete(wyProjects).where(eq(wyProjects.id, id)).returning();
  return rows.length > 0;
}

// ---------------- sources ----------------

export async function storeWaveyardSource(input: {
  projectId: string;
  name: string;
  mediaType: string;
  bytes: Buffer;
  durationMs: number;
  peaks: { min: number; max: number }[];
}): Promise<WaveyardSource> {
  await mkdir(WAVEYARD_DATA_DIR, { recursive: true });
  const checksum = createHash("sha256").update(input.bytes).digest("hex").slice(0, 16);
  const ext = mediaTypeExt(input.mediaType);
  const [row] = await db
    .insert(wySources)
    .values({
      projectId: input.projectId,
      name: input.name.slice(0, 160),
      mediaType: input.mediaType,
      storageKey: "", // filled after id exists
      bytes: input.bytes.length,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      checksum,
      peaks: input.peaks,
    })
    .returning();
  const storageKey = `${row.id}${ext}`;
  await writeFile(path.join(WAVEYARD_DATA_DIR, storageKey), input.bytes);
  const [updated] = await db
    .update(wySources)
    .set({ storageKey })
    .where(eq(wySources.id, row.id))
    .returning();
  await db.update(wyProjects).set({ updatedAt: new Date() }).where(eq(wyProjects.id, input.projectId));
  return toSource(updated);
}

export async function readWaveyardSourceAudio(
  id: string,
): Promise<{ bytes: Buffer; mediaType: string; name: string } | null> {
  const [row] = await db.select().from(wySources).where(eq(wySources.id, id)).limit(1);
  if (!row || !row.storageKey) return null;
  const file = path.join(WAVEYARD_DATA_DIR, row.storageKey);
  try {
    await stat(file);
  } catch {
    return null;
  }
  const bytes = await readFile(file);
  return { bytes, mediaType: row.mediaType, name: row.name };
}

export async function deleteWaveyardSource(id: string): Promise<boolean> {
  const [row] = await db.select().from(wySources).where(eq(wySources.id, id)).limit(1);
  if (!row) return false;
  try {
    const p = path.join(WAVEYARD_DATA_DIR, row.storageKey);
    if (existsSync(p)) await (await import("node:fs/promises")).rm(p);
  } catch {}
  const rows = await db.delete(wySources).where(eq(wySources.id, id)).returning();
  return rows.length > 0;
}

// ---------------- versions ----------------

export async function saveWaveyardVersion(input: {
  projectId: string;
  name?: string;
  arrangement: WaveyardArrangement;
}): Promise<WaveyardVersion> {
  const [row] = await db
    .insert(wyVersions)
    .values({
      projectId: input.projectId,
      name: (input.name ?? `Version ${new Date().toLocaleString()}`).slice(0, 120),
      arrangement: input.arrangement,
    })
    .returning();
  await db.update(wyProjects).set({ updatedAt: new Date() }).where(eq(wyProjects.id, input.projectId));
  return toVersion(row);
}

function mediaTypeExt(mediaType: string): string {
  switch (mediaType) {
    case "audio/mpeg": return ".mp3";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave": return ".wav";
    case "audio/flac": return ".flac";
    case "audio/mp4":
    case "audio/m4a": return ".m4a";
    case "audio/aac": return ".aac";
    case "audio/ogg":
    case "audio/vorbis": return ".ogg";
    case "audio/webm": return ".webm";
    default: return ".bin";
  }
}
