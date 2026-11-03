import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { acceptedAudioFilename, MAX_UPLOAD_BYTES, sanitizedFilename } from "@workspace/arena/lib/waveyard/audio";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import {
  restoreSessionTrackOriginalAudio,
  SessionNotFoundError,
  SessionTrackNotFoundError,
  SessionTrackOriginalAudioRestoreError,
} from "@workspace/arena/lib/waveyard/library/session-service";
import { isUuid } from "@workspace/arena/lib/api/ids";
import { guardedFormData } from "@workspace/arena/lib/security/request-limits";

export const runtime = "nodejs";

/** POST /api/library/sessions/[id]/tracks/[itemId]/source — restore a missing
 * original using a local file the listener is authorized to use. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  let temporaryDirectory: string | undefined;
  try {
    const user = await requireUser();
    const { id, itemId } = await params;
    if (!isUuid(id) || !isUuid(itemId)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const guard = await guardedFormData(request, MAX_UPLOAD_BYTES);
    if (!guard.ok && guard.error) return guard.error;
    const upload = guard.form!.get("file");
    if (!(upload instanceof File)) return Response.json({ error: "Choose an audio file to attach." }, { status: 400 });
    if (!acceptedAudioFilename(upload.name)) {
      return Response.json({ error: "Supported formats are WAV, MP3, FLAC, M4A, AAC, and OGG." }, { status: 415 });
    }
    if (upload.size <= 0 || upload.size > MAX_UPLOAD_BYTES) {
      return Response.json({ error: `Audio must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes.` }, { status: 413 });
    }

    const filename = sanitizedFilename(upload.name);
    temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-session-original-"));
    const filePath = join(temporaryDirectory, `${randomUUID()}${extname(filename).toLowerCase()}`);
    await writeFile(filePath, Buffer.from(await upload.arrayBuffer()));
    const session = await restoreSessionTrackOriginalAudio(user.id, id, itemId, {
      filePath,
      filename,
      mimeType: upload.type || "application/octet-stream",
    });
    return Response.json({ session });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return Response.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof SessionTrackNotFoundError) return Response.json({ error: "Session track not found." }, { status: 404 });
    if (error instanceof SessionTrackOriginalAudioRestoreError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Response) return error;
    return Response.json({
      error: error instanceof Error ? error.message : "The original audio could not be attached.",
    }, { status: 422 });
  } finally {
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
