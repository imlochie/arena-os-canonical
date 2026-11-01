import { GetLibraryAudioCaptureStatusResponse } from "@workspace/api-zod";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { getAudioCaptureStatus, markAudioCaptureTrack } from "../../../../lib/waveyard/audio-capture-manager";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const session = getAudioCaptureStatus(user.id, id);
    if (!session) return Response.json({ error: "Capture session not found." }, { status: 404 });
    return Response.json(GetLibraryAudioCaptureStatusResponse.parse(session));
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    return Response.json(GetLibraryAudioCaptureStatusResponse.parse(await markAudioCaptureTrack(user.id, id, await request.json())));
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Could not mark the next track.";
    return Response.json({ error: message }, { status: /not found/i.test(message) ? 404 : 409 });
  }
}
