/**
 * GET /api/library/tracks/[id] — one track with everything the player
 * needs: real stems (or the honest reason they are missing), the source,
 * analysis, and the container project "Open in Studio" routes to.
 *
 * PATCH /api/library/tracks/[id] — update a track's curation (rating
 * and/or labels). The response carries the persisted values so the caller
 * can update their view without a refetch.
 */


import { isUuid } from "@workspace/arena/lib/api/ids";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { getTrack, getTrackDeletionProtection, updateTrackCuration } from "@workspace/arena/lib/waveyard/library/service";

export const runtime = "nodejs";

/**
 * There is deliberately no destructive library-audio workflow yet. Fail
 * explicitly, identifying saved dependencies rather than leaking a generic
 * foreign-key error or silently cascading away a Studio arrangement.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const protection = await getTrackDeletionProtection(user.id, id);
    if (!protection) return Response.json({ error: "Track not found." }, { status: 404 });
    if (protection.inUse) {
      return Response.json({
        error: "This song supplies audio to saved Studio mixes. Nothing was deleted. Open Studio to manage the mixes listed below; library audio deletion is not available.",
        errorCode: "LIBRARY_AUDIO_IN_USE",
        studioProjects: protection.studioProjects,
        audioPreserved: true,
      }, { status: 409 });
    }
    return Response.json({
      error: "Library audio deletion is not available. You can remove songs from a queue or playlist without deleting their audio.",
      errorCode: "LIBRARY_AUDIO_DELETION_UNAVAILABLE",
      audioPreserved: true,
    }, { status: 405, headers: { Allow: "GET, PATCH" } });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const track = await getTrack(user.id, id);
    if (track === null) return Response.json({ error: "Track not found." }, { status: 404 });
    return Response.json({ track });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Body must be JSON." }, { status: 400 });
    }
    if (!body || typeof body !== "object") {
      return Response.json({ error: "Body must be an object." }, { status: 400 });
    }
    const { rating, labels } = body as { rating?: unknown; labels?: unknown };
    if (rating === undefined && labels === undefined) {
      return Response.json({ error: "Provide rating and/or labels." }, { status: 400 });
    }
    if (rating !== undefined && typeof rating !== "number") {
      return Response.json({ error: "rating must be a number (0..5)." }, { status: 400 });
    }
    if (labels !== undefined && !Array.isArray(labels)) {
      return Response.json({ error: "labels must be an array of strings." }, { status: 400 });
    }
    if (Array.isArray(labels) && labels.some((label) => typeof label !== "string")) {
      return Response.json({ error: "labels must be an array of strings." }, { status: 400 });
    }
    const curation = await updateTrackCuration(user.id, id, { rating, labels });
    if (curation === null) return Response.json({ error: "Track not found or nothing to update." }, { status: 404 });
    return Response.json({ track: curation });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
