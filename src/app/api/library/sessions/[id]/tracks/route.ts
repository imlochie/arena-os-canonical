import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/api/ids";
import { requireUser } from "@/lib/waveyard/local-context";
import {
  SessionNotFoundError,
  SessionTrackNotFoundError,
  TrackNotInLibraryError,
  addTrackToSession,
  moveSessionTrack,
  removeSessionTrack,
} from "@/lib/waveyard/library/session-service";

export const runtime = "nodejs";

const addSchema = z.object({ trackId: z.string().uuid(), position: z.number().int().min(0).optional() });

/** POST /api/library/sessions/[id]/tracks — add a library track (ordered,
 * duplicates allowed — a live set can play a song twice). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = addSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "A track id is required." }, { status: 400 });
    const session = await addTrackToSession({ ownerId: user.id, sessionId: id, ...parsed.data });
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof TrackNotInLibraryError) return NextResponse.json({ error: "Track not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}

const moveSchema = z.object({ sessionTrackId: z.string().uuid(), position: z.number().int().min(0) });

/** PATCH /api/library/sessions/[id]/tracks — reorder. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = moveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "A session track id and position are required." }, { status: 400 });
    const session = await moveSessionTrack(user.id, id, parsed.data.sessionTrackId, parsed.data.position);
    return NextResponse.json({ session });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof SessionTrackNotFoundError) return NextResponse.json({ error: "Session track not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}

/** DELETE /api/library/sessions/[id]/tracks?sessionTrackId=… — remove. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const sessionTrackId = new URL(request.url).searchParams.get("sessionTrackId") ?? "";
    if (!isUuid(id) || !isUuid(sessionTrackId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const session = await removeSessionTrack(user.id, id, sessionTrackId);
    return NextResponse.json({ session });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof SessionTrackNotFoundError) return NextResponse.json({ error: "Session track not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}
