import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { acceptedAudioFilename, MAX_UPLOAD_BYTES, sanitizedFilename } from "@/lib/waveyard/audio";
import { requireUser } from "@/lib/waveyard/local-context";
import { addTrackFromAudioFile, listTracks } from "@/lib/waveyard/library/service";

export const runtime = "nodejs";

/**
 * GET /api/library/tracks?q=&limit= — the listening library (real persisted
 * metadata only; search hits title/artist/album).
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const tracks = await listTracks({
      ownerId: user.id,
      search: url.searchParams.get("q") ?? undefined,
      limit: url.searchParams.get("limit") !== null ? Number(url.searchParams.get("limit")) : undefined,
    });
    return NextResponse.json({ tracks });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

/**
 * POST /api/library/tracks — add MUSIC: one audio file, no project jargon.
 * Runs the same intake pipeline as the studio (probe, checksum, private
 * storage, separation/waveform jobs) inside a library container project and
 * returns the playable Track. Re-adding identical audio is idempotent.
 */
export async function POST(request: Request) {
  let temporaryDirectory: string | undefined;
  try {
    const user = await requireUser();
    const form = await request.formData();
    const upload = form.get("file");
    if (!(upload instanceof File)) return NextResponse.json({ error: "An audio file is required." }, { status: 400 });
    if (!acceptedAudioFilename(upload.name)) {
      return NextResponse.json({ error: "Supported formats are WAV, MP3, FLAC, M4A, AAC, and OGG." }, { status: 415 });
    }
    if (upload.size <= 0 || upload.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: `Audio must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes.` }, { status: 413 });
    }

    const cleanName = sanitizedFilename(upload.name);
    temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-library-"));
    const localFile = join(temporaryDirectory, `${randomUUID()}${extname(cleanName).toLowerCase()}`);
    await writeFile(localFile, Buffer.from(await upload.arrayBuffer()));

    const result = await addTrackFromAudioFile({
      ownerId: user.id,
      filePath: localFile,
      filename: cleanName,
      mimeType: upload.type || "application/octet-stream",
      title: typeof form.get("title") === "string" ? String(form.get("title")) : undefined,
      artist: typeof form.get("artist") === "string" ? String(form.get("artist")) : undefined,
    });
    return NextResponse.json(
      {
        track: result.track,
        created: result.created,
        separationQueued: result.separationQueued,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Adding music failed.";
    return NextResponse.json({ error: message }, { status: 422 });
  } finally {
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
