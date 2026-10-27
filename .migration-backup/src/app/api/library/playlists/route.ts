import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/waveyard/local-context";
import { createPlaylist, listPlaylists } from "@/lib/waveyard/library/service";

export const runtime = "nodejs";

/** GET /api/library/playlists — the owner's playlists with track counts. */
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ playlists: await listPlaylists(user.id) });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

const createSchema = z.object({ name: z.string().trim().min(1).max(160) });

/** POST /api/library/playlists — create a playlist. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "A playlist name is required." }, { status: 400 });
    const playlist = await createPlaylist(user.id, parsed.data.name);
    return NextResponse.json({ playlist }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
