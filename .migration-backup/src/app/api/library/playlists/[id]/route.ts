import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/api/ids";
import { requireUser } from "@/lib/waveyard/local-context";
import { deletePlaylist, getPlaylist, PlaylistNotFoundError, renamePlaylist } from "@/lib/waveyard/library/service";

export const runtime = "nodejs";

/** GET /api/library/playlists/[id] — a playlist with its ordered tracks. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    return NextResponse.json({ playlist: await getPlaylist(user.id, id) });
  } catch (error) {
    if (error instanceof PlaylistNotFoundError) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}

const renameSchema = z.object({ name: z.string().trim().min(1).max(160) });

/** PATCH /api/library/playlists/[id] — rename a playlist. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = renameSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "A playlist name is required." }, { status: 400 });
    const playlist = await renamePlaylist(user.id, id, parsed.data.name);
    return NextResponse.json({ playlist });
  } catch (error) {
    if (error instanceof PlaylistNotFoundError) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}

/** DELETE /api/library/playlists/[id] — delete a playlist (tracks stay in
 * the library — membership is the only thing removed). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await deletePlaylist(user.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof PlaylistNotFoundError) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}
