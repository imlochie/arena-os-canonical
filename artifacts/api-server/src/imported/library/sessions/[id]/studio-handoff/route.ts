
import { isUuid } from "@workspace/arena/lib/api/ids";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import {
  SessionNotFoundError,
  StudioHandoffSelectionError,
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
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    let selectedSessionTrackIds: string[] | undefined;
    const rawBody = await request.text();
    if (rawBody.trim().length > 0) {
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return Response.json({ error: "Invalid handoff request body." }, { status: 400 });
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return Response.json({ error: "Invalid handoff request body." }, { status: 400 });
      }
      const requestedIds = (body as { sessionTrackIds?: unknown }).sessionTrackIds;
      if (requestedIds !== undefined) {
        if (!Array.isArray(requestedIds) || !requestedIds.every((trackId) => typeof trackId === "string" && isUuid(trackId))) {
          return Response.json({ error: "sessionTrackIds must be an array of session track IDs." }, { status: 400 });
        }
        selectedSessionTrackIds = requestedIds;
      }
    }
    const result = await sendSessionToStudio(user.id, id, selectedSessionTrackIds);
    return Response.json({ handoff: result }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return Response.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof StudioHandoffSelectionError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof StemSwapRefusedError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof Response) return error;
    throw error;
  }
}
