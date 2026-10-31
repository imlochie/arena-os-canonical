import { GetLibraryAudioCaptureRecoveriesResponse } from "@workspace/api-zod";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { listRecoverableAudioCaptures } from "../../../../lib/waveyard/audio-capture-manager";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    const recoveries = await listRecoverableAudioCaptures(user.id);
    return Response.json(GetLibraryAudioCaptureRecoveriesResponse.parse({ recoveries }));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "Could not check interrupted recordings." }, { status: 500 });
  }
}
