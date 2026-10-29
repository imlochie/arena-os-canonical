
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
    let trackEdits: Array<{ sessionTrackId: string; stemMix: Record<string, number> }> | undefined;
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
      const requestBody = body as { sessionTrackIds?: unknown; trackEdits?: unknown };
      const requestedIds = requestBody.sessionTrackIds;
      if (requestedIds !== undefined) {
        if (!Array.isArray(requestedIds) || !requestedIds.every((trackId) => typeof trackId === "string" && isUuid(trackId))) {
          return Response.json({ error: "sessionTrackIds must be an array of session track IDs." }, { status: 400 });
        }
        selectedSessionTrackIds = requestedIds;
      }
      if (requestBody.trackEdits !== undefined) {
        if (!Array.isArray(requestBody.trackEdits) || requestBody.trackEdits.length > 500) {
          return Response.json({ error: "trackEdits must be an array with at most 500 entries." }, { status: 400 });
        }
        const parsedEdits: Array<{ sessionTrackId: string; stemMix: Record<string, number> }> = [];
        for (const entry of requestBody.trackEdits) {
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            return Response.json({ error: "Each track edit must include a session track ID and mixer values." }, { status: 400 });
          }
          const edit = entry as { sessionTrackId?: unknown; stemMix?: unknown };
          if (typeof edit.sessionTrackId !== "string" || !isUuid(edit.sessionTrackId)) {
            return Response.json({ error: "Each track edit must include a valid session track ID." }, { status: 400 });
          }
          if (edit.stemMix === null || typeof edit.stemMix !== "object" || Array.isArray(edit.stemMix)) {
            return Response.json({ error: "Each track edit must include mixer values." }, { status: 400 });
          }
          const stemMix: Record<string, number> = {};
          for (const [stemType, value] of Object.entries(edit.stemMix)) {
            if (stemType.length === 0 || stemType.length > 64 || typeof value !== "number" || !Number.isFinite(value)) {
              return Response.json({ error: "Mixer values must be finite numbers keyed by stem type." }, { status: 400 });
            }
            stemMix[stemType] = value;
          }
          parsedEdits.push({ sessionTrackId: edit.sessionTrackId, stemMix });
        }
        trackEdits = parsedEdits;
      }
    }
    const result = await sendSessionToStudio(user.id, id, selectedSessionTrackIds, trackEdits);
    return Response.json({ handoff: result }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return Response.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof StudioHandoffSelectionError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof StemSwapRefusedError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof Response) return error;
    throw error;
  }
}
