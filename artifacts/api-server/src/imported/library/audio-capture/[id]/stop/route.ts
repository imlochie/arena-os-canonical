import { StopLibraryAudioCaptureResponse } from "@workspace/api-zod";
import { importCaptureTracks } from "../../../../../lib/waveyard/audio-capture-import";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import {
  getAudioCaptureImportResult,
  getAudioCaptureSessionDirectory,
  removeAudioCaptureFiles,
  runAudioCaptureImport,
  setAudioCaptureImportResult,
  stopAudioCapture,
} from "../../../../../lib/waveyard/audio-capture-manager";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const cached = getAudioCaptureImportResult(user.id, id);
    if (cached) {
      const sessionDirectory = getAudioCaptureSessionDirectory(user.id, id);
      if (sessionDirectory) await removeAudioCaptureFiles(sessionDirectory);
      return Response.json(StopLibraryAudioCaptureResponse.parse(cached));
    }
    const capture = await stopAudioCapture(user.id, id);
    if (!capture) return Response.json({ error: "Capture session not found." }, { status: 404 });

    const response = await runAudioCaptureImport(user.id, id, async () => {
      const result = await importCaptureTracks({
        ownerId: user.id,
        ...capture,
      });
      const response = StopLibraryAudioCaptureResponse.parse({
        track: result.track,
        tracks: result.tracks,
        created: result.created,
        separationQueued: result.separationQueued,
        sampleFrames: capture.result.sampleFrames,
        durationSeconds: capture.result.sampleFrames / capture.format.sampleRate,
        format: capture.format,
        discontinuityCount: capture.discontinuityCount,
        signal: capture.signal,
      });
      setAudioCaptureImportResult(user.id, id, response);
      await removeAudioCaptureFiles(capture.sessionDirectory);
      return response;
    });
    return Response.json(response);
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Could not finalize the audio recording.";
    const status = /not found/i.test(message) ? 404 : /preserved|finaliz|capture/i.test(message) ? 409 : 422;
    return Response.json({ error: message }, { status });
  }
}
