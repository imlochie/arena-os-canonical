import { GetLibraryAudioCaptureStatusResponse } from "@workspace/api-zod";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { getAudioCaptureStatus } from "../../../../lib/waveyard/audio-capture-manager";

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
