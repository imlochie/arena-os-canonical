
import { z } from "zod";
import { RecordListeningSessionSwapAudiblePositionBody } from "@workspace/api-zod";
import { isUuid } from "@workspace/arena/lib/api/ids";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import {
  SessionNotFoundError,
  SessionTrackNotFoundError,
  StemSwapRefusedError,
  TrackNotInLibraryError,
  getSession,
  recordStemSwap,
  recordStemSwapAudiblePosition,
  removeStemSwap,
} from "@workspace/arena/lib/waveyard/library/session-service";

export const runtime = "nodejs";

/** GET /api/library/sessions/[id]/swaps — the swap ledger (provenance). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const session = await getSession(user.id, id);
    return Response.json({ swaps: session.swaps });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return Response.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}

const swapSchema = z.object({
  sessionTrackId: z.string().uuid(),
  stemType: z.string().min(1).max(64),
  toTrackId: z.string().uuid(),
  atSeconds: z.number().min(0).optional(),
  expectedSwapId: z.string().uuid().optional(),
  toStemAssetId: z.string().uuid().nullable().optional(),
});

/** POST /api/library/sessions/[id]/swaps — record a REAL stem swap (validated
 * against actual stem rows; passthrough full-source rows cannot donate). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = swapSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "A session track, stem type, and donor track are required." }, { status: 400 });
    const session = await recordStemSwap({ ownerId: user.id, sessionId: id, ...parsed.data, atSeconds: parsed.data.atSeconds ?? 0 });
    return Response.json({ session }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return Response.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof SessionTrackNotFoundError) return Response.json({ error: "Session track not found." }, { status: 404 });
    if (error instanceof TrackNotInLibraryError) return Response.json({ error: "Track not found." }, { status: 404 });
    if (error instanceof StemSwapRefusedError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof Response) return error;
    throw error;
  }
}

/** PATCH /api/library/sessions/[id]/swaps — record the actual playback-clock
 * position after the selected donor layer starts, guarded by its swap id. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = RecordListeningSessionSwapAudiblePositionBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "A swap, session track, stem type, and valid playback position are required." }, { status: 400 });
    }
    const session = await recordStemSwapAudiblePosition({ ownerId: user.id, sessionId: id, ...parsed.data });
    return Response.json({ session });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return Response.json({ error: "Session not found." }, { status: 404 });
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
    if (!isUuid(id) || !isUuid(swapId)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const session = await removeStemSwap(user.id, id, swapId);
    return Response.json({ session });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return Response.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}
