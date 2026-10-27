import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/api/ids";
import { requireUser } from "@/lib/waveyard/local-context";
import {
  SessionNotFoundError,
  SessionTrackNotFoundError,
  StemSwapRefusedError,
  TrackNotInLibraryError,
  getSession,
  recordStemSwap,
  removeStemSwap,
} from "@/lib/waveyard/library/session-service";

export const runtime = "nodejs";

/** GET /api/library/sessions/[id]/swaps — the swap ledger (provenance). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const session = await getSession(user.id, id);
    return NextResponse.json({ swaps: session.swaps });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}

const swapSchema = z.object({
  sessionTrackId: z.string().uuid(),
  stemType: z.string().min(1).max(64),
  toTrackId: z.string().uuid(),
  atSeconds: z.number().min(0).optional(),
});

/** POST /api/library/sessions/[id]/swaps — record a REAL stem swap (validated
 * against actual stem rows; passthrough full-source rows cannot donate). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = swapSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "A session track, stem type, and donor track are required." }, { status: 400 });
    const session = await recordStemSwap({ ownerId: user.id, sessionId: id, ...parsed.data, atSeconds: parsed.data.atSeconds ?? 0 });
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof SessionTrackNotFoundError) return NextResponse.json({ error: "Session track not found." }, { status: 404 });
    if (error instanceof TrackNotInLibraryError) return NextResponse.json({ error: "Track not found." }, { status: 404 });
    if (error instanceof StemSwapRefusedError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof Response) return error;
    throw error;
  }
}

/** DELETE /api/library/sessions/[id]/swaps?swapId=… — remove a swap record. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const swapId = new URL(request.url).searchParams.get("swapId") ?? "";
    if (!isUuid(id) || !isUuid(swapId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const session = await removeStemSwap(user.id, id, swapId);
    return NextResponse.json({ session });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}
