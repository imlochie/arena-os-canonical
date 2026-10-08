import { NextResponse } from "next/server";
import { isUuid } from "@/lib/api/ids";
import { requireUser } from "@/lib/waveyard/local-context";
import { getTrack } from "@/lib/waveyard/library/service";

export const runtime = "nodejs";

/**
 * GET /api/library/tracks/[id] — one track with everything the player needs:
 * real stems (or the honest reason they are missing), the source, analysis,
 * and the container project "Open in Studio" routes to.
 */
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
