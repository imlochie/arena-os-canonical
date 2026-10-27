
import { isUuid } from "@workspace/arena/lib/api/ids";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import {
  SessionNotFoundError,
  StemSwapRefusedError,
  sendSessionToStudio,
} from "@workspace/arena/lib/waveyard/library/session-service";

export const runtime = "nodejs";

/**
 * POST /api/library/sessions/[id]/studio-handoff — derive an explicit Studio
 * object (project + remix session with tracks REFERENCING the existing stems)
 * from the listening session. No audio is copied; originals are never
 * modified.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const result = await sendSessionToStudio(user.id, id);
    return Response.json({ handoff: result }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return Response.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof StemSwapRefusedError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof Response) return error;
    throw error;
  }
}
