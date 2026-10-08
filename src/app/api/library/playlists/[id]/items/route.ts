import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/api/ids";
import { requireUser } from "@/lib/waveyard/local-context";
import {
  addTrackToPlaylist,
  movePlaylistItem,
  PlaylistNotFoundError,
  QueueItemNotFoundError,
  removePlaylistItem,
  TrackNotFoundError,
} from "@/lib/waveyard/library/service";

export const runtime = "nodejs";

const addSchema = z.object({
  trackId: z.string().uuid(),
  position: z.number().int().min(0).optional(),
});

/** POST /api/library/playlists/[id]/items — add a track (duplicates are a
 * legitimate playlist decision; order is explicit). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = addSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "A track id is required." }, { status: 400 });
    const playlist = await addTrackToPlaylist({ ownerId: user.id, playlistId: id, ...parsed.data });
    return NextResponse.json({ playlist }, { status: 201 });
  } catch (error) {
    if (error instanceof PlaylistNotFoundError) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
    if (error instanceof TrackNotFoundError) return NextResponse.json({ error: "Track not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}

const moveSchema = z.object({ itemId: z.string().uuid(), position: z.number().int().min(0) });

/** PATCH /api/library/playlists/[id]/items — reorder within the playlist. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = moveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "An item id and position are required." }, { status: 400 });
    const playlist = await movePlaylistItem(user.id, id, parsed.data.itemId, parsed.data.position);
    return NextResponse.json({ playlist });
  } catch (error) {
    if (error instanceof PlaylistNotFoundError) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
    if (error instanceof QueueItemNotFoundError) return NextResponse.json({ error: "Playlist item not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}

/** DELETE /api/library/playlists/[id]/items?itemId=… — remove one item. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const itemId = new URL(request.url).searchParams.get("itemId") ?? "";
    if (!isUuid(id) || !isUuid(itemId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const playlist = await removePlaylistItem(user.id, id, itemId);
    return NextResponse.json({ playlist });
  } catch (error) {
    if (error instanceof PlaylistNotFoundError) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}
