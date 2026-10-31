import type { LibraryAudioCaptureRecoveryImportResponse } from "@workspace/api-zod";
import { addTrackFromAudioFile } from "@workspace/arena/lib/waveyard/library/service";
import { sanitizedFilename } from "@workspace/arena/lib/waveyard/audio";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import {
  clearRecoveredAudioCapture,
  getRecoverableAudioCapture,
  removeAudioCaptureFiles,
} from "../../../../../../lib/waveyard/audio-capture-manager";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const capture = await getRecoverableAudioCapture(user.id, id);
    if (!capture) return Response.json({ error: "No interrupted recording was found for this user." }, { status: 404 });
    const result = await addTrackFromAudioFile({
      ownerId: user.id,
      filePath: capture.path,
      filename: `${sanitizedFilename(capture.title)}.wav`,
      mimeType: "audio/wav",
      title: capture.title,
      artist: capture.artist,
      album: capture.album,
    });
    const response: LibraryAudioCaptureRecoveryImportResponse = {
      track: {
        ...result.track,
        lastPlayedAt: result.track.lastPlayedAt ? new Date(result.track.lastPlayedAt) : null,
        addedAt: new Date(result.track.addedAt),
      },
      created: result.created,
      separationQueued: result.separationQueued,
    };
    await removeAudioCaptureFiles(capture.sessionDirectory);
    clearRecoveredAudioCapture(user.id, id);
    return Response.json(response);
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Could not import the interrupted recording.";
    return Response.json({ error: message }, { status: /not found/i.test(message) ? 404 : 422 });
  }
}
