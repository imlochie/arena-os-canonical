import type { LibraryAudioCaptureRecoveryImportResponse } from "@workspace/api-zod";
import { importCaptureTracks } from "../../../../../../lib/waveyard/audio-capture-import";
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
    const result = await importCaptureTracks({
      ownerId: user.id,
      ...capture,
      metadata: capture.metadata ?? { title: capture.title, artist: capture.artist, album: capture.album },
    });
    const response: LibraryAudioCaptureRecoveryImportResponse = {
      tracks: result.tracks.map((track) => ({
        ...track,
        lastPlayedAt: track.lastPlayedAt ? new Date(track.lastPlayedAt) : null,
        addedAt: new Date(track.addedAt),
      })),
      track: {
        ...result.track,
        lastPlayedAt: result.track.lastPlayedAt ? new Date(result.track.lastPlayedAt) : null,
        addedAt: new Date(result.track.addedAt),
      },
      created: result.created,
      separationQueued: result.separationQueued,
      signal: capture.signal,
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
