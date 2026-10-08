import { NextResponse } from "next/server";
import { isUuid } from "@/lib/api/ids";
import { requireUser } from "@/lib/waveyard/local-context";
import { recordPlay } from "@/lib/waveyard/library/service";

export const runtime = "nodejs";

/**
 * POST /api/library/tracks/[id]/played — record one real listen. The client
 * calls this only after the play-count threshold of actual listening
 * (src/lib/waveyard/library/model.ts shouldCountPlay), never on the click.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const track = await recordPlay(user.id, id);
    if (track === null) return NextResponse.json({ error: "Track not found." }, { status: 404 });
    return NextResponse.json({ track });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
