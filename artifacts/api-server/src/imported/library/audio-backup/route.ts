import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@workspace/db";
import { projects, sourceAssets, tracks } from "@workspace/db/waveyardSchema";
import { isUuid } from "@workspace/arena/lib/api/ids";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { getStorage } from "@workspace/arena/lib/waveyard/storage";
import {
  AudioBackupError,
  createAudioBackupCsv,
  createVerifiedAudioBackupZip,
  MAX_AUDIO_BACKUP_BYTES,
  MAX_AUDIO_BACKUP_FILES,
  safeAudioBackupSegment,
  type AudioBackupEntry,
} from "@workspace/arena/lib/waveyard/library/audio-backup";

export const runtime = "nodejs";

type AudioRow = {
  trackId: string;
  trackProjectId: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  sourceAssetId: string;
  sourceProjectId: string;
  storageKey: string;
  checksumSha256: string;
  originalFilename: string;
  fileSizeBytes: number;
  codec: string;
};

function parseIds(value: string | null) {
  if (value === null || value.trim() === "") {
    throw new AudioBackupError("Select audio tracks before starting a backup.", 400);
  }
  const ids = value.split(",").map((id) => id.trim());
  if (
    ids.length < 1 ||
    ids.length > MAX_AUDIO_BACKUP_FILES ||
    ids.some((id) => !isUuid(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new AudioBackupError(`Select between 1 and ${MAX_AUDIO_BACKUP_FILES} unique tracks.`, 400);
  }
  return ids;
}

async function findAudioRows(ownerId: string, ids: string[]): Promise<AudioRow[]> {
  const rows = await db
    .select({
      trackId: tracks.id,
      trackProjectId: tracks.projectId,
      title: tracks.title,
      artist: tracks.artist,
      album: tracks.album,
      durationSeconds: tracks.durationSeconds,
      sourceAssetId: sourceAssets.id,
      sourceProjectId: sourceAssets.projectId,
      storageKey: sourceAssets.storageKey,
      checksumSha256: sourceAssets.checksumSha256,
      originalFilename: sourceAssets.originalFilename,
      fileSizeBytes: sourceAssets.fileSizeBytes,
      codec: sourceAssets.codec,
    })
    .from(tracks)
    .innerJoin(sourceAssets, eq(tracks.sourceAssetId, sourceAssets.id))
    .innerJoin(projects, eq(sourceAssets.projectId, projects.id))
    .where(and(
      eq(tracks.ownerId, ownerId),
      eq(projects.ownerId, ownerId),
      inArray(tracks.id, ids),
    ));
  if (rows.length !== ids.length) {
    // Do not reveal whether an omitted ID belongs to someone else or has no
    // retained source file.
    throw new AudioBackupError("One or more selected tracks have no available original audio.", 404);
  }
  for (const row of rows) {
    if (row.trackProjectId !== row.sourceProjectId) {
      throw new AudioBackupError("A selected track no longer points to its own original audio.", 409);
    }
    if (
      !Number.isSafeInteger(row.fileSizeBytes) ||
      row.fileSizeBytes <= 0 ||
      !/^[a-f0-9]{64}$/i.test(row.checksumSha256)
    ) {
      throw new AudioBackupError("A selected original is missing its size or checksum record.", 409);
    }
  }
  return rows;
}

function archivePathFor(row: AudioRow) {
  const extension = row.originalFilename.match(/\.(wav|mp3|flac|m4a|aac|ogg)$/i)?.[0]?.toLowerCase();
  if (extension === undefined) {
    throw new AudioBackupError(`The original for “${row.title}” has an unsupported filename extension.`, 415);
  }
  const artist = safeAudioBackupSegment(row.artist, "Unknown artist");
  const album = safeAudioBackupSegment(row.album, "Unknown album");
  const title = safeAudioBackupSegment(row.title, "Untitled");
  return `audio/${artist}/${album}/${row.trackId} - ${title}${extension}`;
}

function toCsvText(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

async function preflight(rows: AudioRow[]) {
  const storage = getStorage();
  let totalBytes = 0;
  for (const row of rows) {
    if (row.fileSizeBytes > MAX_AUDIO_BACKUP_BYTES - totalBytes) {
      throw new AudioBackupError("Selected audio exceeds the 2 GiB ZIP limit. Make a smaller selection.", 413);
    }
    totalBytes += row.fileSizeBytes;
    if (!(await storage.exists(row.storageKey))) {
      throw new AudioBackupError(`The original audio for “${row.title}” is missing from local storage.`, 410);
    }
    const stored = await storage.openReadStream(row.storageKey);
    const matchesRecordedSize = stored.size === row.fileSizeBytes;
    stored.stream.destroy();
    if (!matchesRecordedSize) {
      throw new AudioBackupError(`The original audio for “${row.title}” no longer matches its saved size.`, 409);
    }
  }
  return totalBytes;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const ids = parseIds(url.searchParams.get("ids"));
    const rows = await findAudioRows(user.id, ids);
    const totalBytes = await preflight(rows);

    if (url.searchParams.get("preflight") === "1") {
      return Response.json({
        audioFiles: rows.length,
        totalBytes,
        maximumFiles: MAX_AUDIO_BACKUP_FILES,
        maximumBytes: MAX_AUDIO_BACKUP_BYTES,
      });
    }

    const storage = getStorage();
    const audioEntries: AudioBackupEntry[] = rows.map((row) => ({
      name: archivePathFor(row),
      bytes: row.fileSizeBytes,
      sha256: row.checksumSha256.toLowerCase(),
      open: async () => (await storage.openReadStream(row.storageKey)).stream,
    }));
    const csv = createAudioBackupCsv(rows.map((row, index) => ({
      trackId: row.trackId,
      title: row.title,
      artist: row.artist,
      album: row.album,
      durationSeconds: row.durationSeconds,
      codec: row.codec,
      originalFilename: row.originalFilename,
      archivePath: audioEntries[index].name,
      fileSizeBytes: row.fileSizeBytes,
      checksumSha256: row.checksumSha256.toLowerCase(),
    })));
    const csvBytes = Buffer.from(csv, "utf8");
    const csvHash = createHash("sha256").update(csvBytes).digest("hex");
    const manifest: AudioBackupEntry = {
      name: "manifest.csv",
      bytes: csvBytes.byteLength,
      sha256: csvHash,
      open: async () => Readable.from([csvBytes]),
    };
    const archive = await createVerifiedAudioBackupZip(
      [...audioEntries, manifest],
      request.signal,
    );
    const stream = createReadStream(archive.path);
    stream.once("close", () => { void archive.dispose(); });
    stream.once("error", () => { void archive.dispose(); });
    const date = new Date().toISOString().slice(0, 10);
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(archive.bytes),
        "Content-Disposition": `attachment; filename="waveyard-audio-backup-${date}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    const status = error instanceof AudioBackupError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Could not build the audio backup.";
    if (status >= 500) console.error("audio backup failed", error);
    return Response.json({ error: message }, { status });
  }
}
