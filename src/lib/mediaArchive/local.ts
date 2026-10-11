/**
 * The local media library — the Plex-independence groundwork.
 *
 * Arena can now index a folder of video files directly (no Plex, no
 * Jellyfin), serve it to a browser player with HTTP Range streaming, keep
 * its OWN watch progress, and — when a file's codecs aren't
 * browser-playable — build a playable copy on demand through the Toolbox
 * ffmpeg engine. Catalog, watch state and playback all live in this
 * machine's database; if Plex disappeared tomorrow, nothing here notices.
 */

import { createReadStream } from "node:fs";
import { readdir, stat, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { mkdir } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mediaLibraryItems, mediaProviders } from "@/db/schema";
import { probeSource, runFfmpegWithProgress } from "@/lib/toolbox/convert";
import { buildPresetArgs } from "@/lib/toolbox/presets";
import { parseLocalIdentity } from "./reconcile";
import type { NormalizedMediaItem } from "./types";

export const LOCAL_PROVIDER_KIND = "local" as const;
export const LIBRARY_CACHE_ROOT = join(process.cwd(), ".arena-data", "library-cache");

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".wmv", ".flv",
  ".mpg", ".mpeg", ".ts", ".m2ts", ".ogv",
]);

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  ts: "video/mp2t",
  m2ts: "video/mp2t",
};

/** Bound the walk: this is a groundwork scanner, not a filesystem crawler. */
const MAX_FILES = 2000;
const MAX_DEPTH = 8;

export function mimeForFile(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function isVideoFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return VIDEO_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** True only when the path really resolves inside the local provider root. */
export async function isPathInsideRoot(root: string, path: string): Promise<boolean> {
  const [realRoot, realPath] = await Promise.all([realpath(root).catch(() => null), realpath(path).catch(() => null)]);
  if (!realRoot || !realPath) return false;
  const rel = relative(realRoot, realPath);
  return rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`) && !isAbsolute(rel);
}

/** The local provider's configured root folder, or null when none is saved. */
export async function getLocalLibraryRoot(): Promise<string | null> {
  const rows = await db.select().from(mediaProviders).where(eq(mediaProviders.kind, LOCAL_PROVIDER_KIND)).limit(1);
  return rows.length ? rows[0].baseUrl : null;
}

type ScanResult = {
  items: NormalizedMediaItem[];
  skipped: { file: string; reason: string }[];
  scanned: number;
};

function episodeIdentity(fileName: string): { episode: boolean; title: string; year: number | null } {
  const base = fileName.replace(/\.[^.]+$/, "");
  const show = base.match(/^(.+?)[.\s_-]+[sS](\d{1,2})[eE](\d{1,3})/);
  if (show) return { episode: true, title: show[1].replace(/[._]/g, " ").trim(), year: null };
  const alt = base.match(/^(.+?)[.\s_-]+(\d{1,2})x(\d{1,3})/);
  if (alt) return { episode: true, title: alt[1].replace(/[._]/g, " ").trim(), year: null };
  const identity = parseLocalIdentity(fileName);
  return { episode: false, title: identity.title, year: identity.year };
}

/**
 * Walk the root folder, probe every video file with the real ffprobe, and
 * produce NormalizedMediaItems that flow through the exact same sync /
 * reconcile / review machinery Plex and Jellyfin use. Watch state is carried
 * forward from existing rows — a rescan never forgets what you watched.
 */
export async function scanLocalLibrary(root: string): Promise<ScanResult> {
  const realRoot = await realpath(root).catch(() => {
    throw new Error(`Local library root does not exist: ${root}`);
  });

  // Carry forward existing watch state so rescans don't clobber progress.
  const existing = await db.select().from(mediaLibraryItems).where(eq(mediaLibraryItems.providerKind, LOCAL_PROVIDER_KIND));
  const watchByKey = new Map(existing.map((row) => [row.ratingKey, row]));

  const files: { absolute: string; relative: string }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else if (entry.isFile() && isVideoFile(entry.name)) {
        files.push({ absolute, relative: relative(realRoot, absolute).split(sep).join("/") });
      }
    }
  };
  await walk(realRoot, 0);

  const skipped: { file: string; reason: string }[] = [];
  const items: NormalizedMediaItem[] = [];
  for (const file of files) {
    let info;
    try {
      info = await stat(file.absolute);
    } catch {
      continue; // vanished mid-scan — next sync will see it again
    }
    let probe;
    try {
      probe = await probeSource(file.absolute);
    } catch (error) {
      skipped.push({ file: file.relative, reason: String((error as Error)?.message ?? error).slice(0, 160) });
      continue;
    }
    const fileName = file.relative.split("/").pop() ?? file.relative;
    const identity = episodeIdentity(fileName);
    const prior = watchByKey.get(file.relative);
    items.push({
      ratingKey: file.relative,
      libraryName: file.relative.includes("/") ? (file.relative.split("/")[0] ?? "Library") : "Library",
      title: identity.title || fileName,
      year: identity.year,
      itemType: identity.episode ? "episode" : identity.year !== null ? "movie" : "unknown",
      viewCount: prior?.viewCount ?? 0,
      viewOffsetMs: prior?.viewOffsetMs ?? 0,
      durationMs: probe.durationSec !== null ? Math.round(probe.durationSec * 1000) : null,
      lastViewedAt: prior?.lastViewedAt ?? null,
      raw: {
        filePath: file.absolute,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        width: probe.width,
        height: probe.height,
        container: probe.formatName,
        sizeBytes: info.size,
        mtimeMs: Math.round(info.mtimeMs),
        source: "local-scan",
      },
    });
  }
  return { items, skipped, scanned: files.length };
}

/**
 * Connection test for the local library: the folder must exist and be
 * readable; "libraries" are its top-level folders. Honest counts, no probe.
 */
export async function testLocalLibraryRoot(
  root: string,
): Promise<{ ok: true; libraries: string[] } | { ok: false; code: string; detail: string }> {
  try {
    const real = await realpath(root);
    const info = await stat(real);
    if (!info.isDirectory()) return { ok: false, code: "connect_failed", detail: "Not a folder." };
    const entries = await readdir(real, { withFileTypes: true });
    const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    let videoCount = 0;
    for (const entry of entries) {
      if (entry.isFile() && isVideoFile(entry.name)) videoCount += 1;
    }
    if (!folders.length && !videoCount) {
      return { ok: false, code: "connect_failed", detail: "Folder exists but contains no subfolders or video files." };
    }
    const label = folders.length ? folders : ["(root)"];
    return { ok: true, libraries: [...label, `${videoCount} video file(s) at the top level`] };
  } catch (error) {
    return { ok: false, code: "connect_failed", detail: String((error as Error)?.message ?? error) };
  }
}

/* --------------------------- playability ---------------------------------- */

export type Playability =
  | { mode: "direct"; reason: string }
  | { mode: "cached"; reason: string; cachePath: string }
  | { mode: "transcode"; reason: string };

const BROWSER_VIDEO = new Set(["h264", "vp9", "av1", "vp8"]);
const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "vorbis"]);
const BROWSER_CONTAINER = new Set(["mov,mp4,m4a,3gp,3g2,mj2", "mp4", "webm", "matroska,webm"]);

export function classifyPlayability(raw: Record<string, unknown> | null): Playability {
  if (!raw || typeof raw.filePath !== "string") {
    return { mode: "transcode", reason: "no file path on record" };
  }
  const video = typeof raw.videoCodec === "string" ? raw.videoCodec : null;
  const audio = typeof raw.audioCodec === "string" ? raw.audioCodec : null;
  const container = typeof raw.container === "string" ? raw.container : null;
  // MKV is not a browser container even when its codecs are fine — the
  // transcode pass remuxes/re-encodes into MP4.
  const containerOk = container !== null && BROWSER_CONTAINER.has(container) && !container.includes("matroska");
  if (video && BROWSER_VIDEO.has(video) && (!audio || BROWSER_AUDIO.has(audio)) && containerOk) {
    return { mode: "direct", reason: `${video}${audio ? ` + ${audio}` : " (silent)"} plays natively in browsers` };
  }
  const why: string[] = [];
  if (!video || !BROWSER_VIDEO.has(video)) why.push(`${video ?? "unknown"} video isn't browser-safe`);
  if (audio && !BROWSER_AUDIO.has(audio)) why.push(`${audio} audio isn't browser-safe`);
  if (!containerOk) why.push(`${container ?? "unknown"} container isn't a browser container`);
  return { mode: "transcode", reason: why.join("; ") };
}

export function cachePathFor(itemId: number): string {
  return join(LIBRARY_CACHE_ROOT, `${itemId}.mp4`);
}

async function cacheIsFresh(itemId: number, raw: Record<string, unknown>): Promise<string | null> {
  const cachePath = cachePathFor(itemId);
  const info = await stat(cachePath).catch(() => null);
  if (!info || info.size <= 0) return null;
  const sourceMtime = typeof raw.mtimeMs === "number" ? raw.mtimeMs : 0;
  // Stale when the source changed after the cached copy was built.
  if (sourceMtime && info.mtimeMs <= sourceMtime) return null;
  return cachePath;
}

/** Full playability incl. a fresh transcode cache check. */
export async function resolvePlayability(item: typeof mediaLibraryItems.$inferSelect): Promise<Playability> {
  const raw = (item.raw ?? {}) as Record<string, unknown>;
  const base = classifyPlayability(raw);
  if (base.mode === "direct") return base;
  const fresh = await cacheIsFresh(item.id, raw);
  if (fresh) return { mode: "cached", reason: `playing the cached H.264 copy (source: ${base.reason})`, cachePath: fresh };
  return base;
}

/* ------------------------ transcode on demand ----------------------------- */

export type TranscodeState = {
  itemId: number;
  status: "running" | "done" | "failed";
  progress: number | null;
  error: string | null;
  startedAt: string;
};

const transcodes = new Map<number, TranscodeState>();
let transcodeRunning = false;
const transcodeQueue: (() => Promise<void>)[] = [];

export function getTranscodeState(itemId: number): TranscodeState | null {
  return transcodes.get(itemId) ?? null;
}

/**
 * Build a browser-playable H.264 MP4 copy of a local item through the
 * Toolbox engine (same arg maps, same hardware-encoder detection, same
 * honest progress). Serial by design — one encode at a time.
 */
export async function ensurePlayableCopy(item: typeof mediaLibraryItems.$inferSelect): Promise<TranscodeState> {
  const raw = (item.raw ?? {}) as Record<string, unknown>;
  if (typeof raw.filePath !== "string") throw new Error("Item has no file path on record.");
  const existing = transcodes.get(item.id);
  if (existing && existing.status === "running") return existing;
  if (await cacheIsFresh(item.id, raw)) {
    const state: TranscodeState = { itemId: item.id, status: "done", progress: 1, error: null, startedAt: new Date().toISOString() };
    transcodes.set(item.id, state);
    return state;
  }

  const state: TranscodeState = { itemId: item.id, status: "running", progress: null, error: null, startedAt: new Date().toISOString() };
  transcodes.set(item.id, state);
  const task = async () => {
    try {
      const probe = await probeSource(raw.filePath as string);
      const { detectHardwareEncoder } = await import("@/lib/toolbox/convert");
      const hw = await detectHardwareEncoder();
      const output = cachePathFor(item.id);
      await mkdir(LIBRARY_CACHE_ROOT, { recursive: true });
      const built = buildPresetArgs("fast-1080p", {
        input: raw.filePath as string,
        output,
        source: probe,
        hw,
      });
      const totalUs = probe.durationSec ? probe.durationSec * 1_000_000 : null;
      await runFfmpegWithProgress(built.args, totalUs, ({ fraction }) => {
        if (fraction !== null) state.progress = fraction;
      });
      state.status = "done";
      state.progress = 1;
    } catch (error) {
      state.status = "failed";
      state.error = String((error as Error)?.message ?? error).slice(0, 500);
      await rm(cachePathFor(item.id), { force: true }).catch(() => {});
    }
  };
  transcodeQueue.push(task);
  const drain = async () => {
    if (transcodeRunning) return;
    transcodeRunning = true;
    try {
      while (transcodeQueue.length) await transcodeQueue.shift()!();
    } finally {
      transcodeRunning = false;
    }
  };
  void drain();
  return state;
}

/* ---------------------------- watch progress ------------------------------ */

/**
 * Arena's OWN watch state — written by the local player, never by a
 * third-party server. This is the independence: progress survives with
 * the database, not with Plex.
 */
export async function recordWatchProgress(input: {
  itemId: number;
  positionMs: number;
  durationMs?: number;
  finished?: boolean;
}): Promise<{ ok: true; viewCount: number; viewOffsetMs: number }> {
  const rows = await db.select().from(mediaLibraryItems).where(eq(mediaLibraryItems.id, input.itemId)).limit(1);
  if (!rows.length) throw new Error("No such library item.");
  const item = rows[0];
  if (item.providerKind !== LOCAL_PROVIDER_KIND) throw new Error("Watch progress is recorded for local items.");
  const position = Math.max(0, Math.floor(input.positionMs));
  const duration = input.durationMs ?? item.durationMs ?? null;
  const finished = input.finished === true || (duration !== null && duration > 0 && position >= duration * 0.95);
  const viewCount = finished ? item.viewCount + 1 : item.viewCount;
  const [updated] = await db
    .update(mediaLibraryItems)
    .set({
      viewOffsetMs: finished ? 0 : position,
      viewCount,
      lastViewedAt: new Date(),
      durationMs: duration ?? item.durationMs,
      updatedAt: new Date(),
    })
    .where(eq(mediaLibraryItems.id, input.itemId))
    .returning();
  return { ok: true, viewCount: updated.viewCount, viewOffsetMs: updated.viewOffsetMs };
}

/** The local item row (id → row), guard-checked to the local provider. */
export async function getLocalItem(itemId: number): Promise<typeof mediaLibraryItems.$inferSelect | null> {
  const rows = await db
    .select()
    .from(mediaLibraryItems)
    .where(and(eq(mediaLibraryItems.id, itemId), eq(mediaLibraryItems.providerKind, LOCAL_PROVIDER_KIND)))
    .limit(1);
  return rows[0] ?? null;
}

/** Resolve the file a player should stream: the fresh cache if present, else the source. */
export async function resolveStreamFile(item: typeof mediaLibraryItems.$inferSelect): Promise<{ path: string; fromCache: boolean } | null> {
  const raw = (item.raw ?? {}) as Record<string, unknown>;
  if (typeof raw.filePath !== "string") return null;
  const root = await getLocalLibraryRoot();
  if (!root) return null;
  if (!(await isPathInsideRoot(root, raw.filePath))) return null;
  const playability = await resolvePlayability(item);
  if (playability.mode === "cached") return { path: playability.cachePath, fromCache: true };
  return { path: raw.filePath, fromCache: false };
}
