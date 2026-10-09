/**
 * GET /api/library/tracks/[id] — one track with everything the player
 * needs: real stems (or the honest reason they are missing), the source,
 * analysis, and the container project "Open in Studio" routes to.
 *
 * PATCH /api/library/tracks/[id] — update a track's curation (rating
 * and/or labels). The response carries the persisted values so the caller
 * can update their view without a refetch.
 */

import { NextResponse } from "next/server";
import { isUuid } from "@/lib/api/ids";
import { requireUser } from "@/lib/waveyard/local-context";
import { getTrack, updateTrackCuration } from "@/lib/waveyard/library/service";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const track = await getTrack(user.id, id);
    if (track === null) return NextResponse.json({ error: "Track not found." }, { status: 404 });
    return NextResponse.json({ track });
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
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
    }
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Body must be an object." }, { status: 400 });
    }
    const { rating, labels } = body as { rating?: unknown; labels?: unknown };
    if (rating === undefined && labels === undefined) {
      return NextResponse.json({ error: "Provide rating and/or labels." }, { status: 400 });
    }
    if (rating !== undefined && typeof rating !== "number") {
      return NextResponse.json({ error: "rating must be a number (0..5)." }, { status: 400 });
    }
    if (labels !== undefined && !Array.isArray(labels)) {
      return NextResponse.json({ error: "labels must be an array of strings." }, { status: 400 });
    }
    if (Array.isArray(labels) && labels.some((label) => typeof label !== "string")) {
      return NextResponse.json({ error: "labels must be an array of strings." }, { status: 400 });
    }
    const curation = await updateTrackCuration(user.id, id, { rating, labels });
    if (curation === null) return NextResponse.json({ error: "Track not found or nothing to update." }, { status: 404 });
    return NextResponse.json({ track: curation });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
