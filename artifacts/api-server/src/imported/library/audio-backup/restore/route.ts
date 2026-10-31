import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { addTrackFromAudioFile } from "@workspace/arena/lib/waveyard/library/service";
import { sanitizedFilename } from "@workspace/arena/lib/waveyard/audio";
import { AudioBackupError, MAX_AUDIO_BACKUP_BYTES } from "@workspace/arena/lib/waveyard/library/audio-backup";
import { restoreVerifiedAudioBackupZip, writeIncomingAudioBackup } from "@workspace/arena/lib/waveyard/library/audio-restore";

export const runtime = "nodejs";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
};

export async function POST(request: Request) {
  let temporaryDirectory: string | undefined;
  try {
    const user = await requireUser();
    const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (contentType !== "application/zip" && contentType !== "application/octet-stream") {
      return Response.json({ error: "Choose a Waveyard audio backup ZIP." }, { status: 415 });
    }
    if (request.body === null) return Response.json({ error: "The backup ZIP is empty." }, { status: 400 });

    const declaredBytes = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_AUDIO_BACKUP_BYTES) {
      throw new AudioBackupError("The backup ZIP exceeds the 2 GiB upload limit.", 413);
    }
    temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-audio-restore-upload-"));
    const archivePath = join(temporaryDirectory, `${randomUUID()}.zip`);
    await writeIncomingAudioBackup(request.body, archivePath, MAX_AUDIO_BACKUP_BYTES, request.signal);

    const restored = await restoreVerifiedAudioBackupZip(archivePath, async (row, filePath) => {
      try {
        const extension = extname(row.backupPath).toLowerCase();
        const result = await addTrackFromAudioFile({
          ownerId: user.id,
          filePath,
          filename: sanitizedFilename(row.originalFilename),
          mimeType: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
          title: row.title,
          artist: row.artist,
          album: row.album,
          // Restoring a large archive should restore originals first, not
          // unexpectedly enqueue up to 100 expensive stem jobs.
          prepareSeparation: false,
        });
        return {
          status: result.created ? "restored" : "duplicate",
          title: result.track.title,
          trackId: result.track.id,
        } as const;
      } catch {
        // Keep a failed row visible and make the whole archive safe to retry.
        // Successful earlier imports are checksum-idempotent.
        return { status: "failed", title: row.title, error: "Could not decode or store this audio file." } as const;
      }
    }, request.signal);

    const importedCount = restored.results.filter((result) => result.status === "restored").length;
    const duplicateCount = restored.results.filter((result) => result.status === "duplicate").length;
    const failedCount = restored.results.filter((result) => result.status === "failed").length;
    return Response.json({
      totalTracks: restored.results.length,
      restored: importedCount,
      duplicates: duplicateCount,
      failed: failedCount,
      totalAudioBytes: restored.totalBytes,
      results: restored.results,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    const status = error instanceof AudioBackupError ? error.status : 422;
    const message = error instanceof Error ? error.message : "Could not restore this Waveyard audio backup.";
    if (status >= 500) console.error("audio backup restore failed", error);
    return Response.json({ error: message }, { status });
  } finally {
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
