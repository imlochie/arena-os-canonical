
import { z } from "zod";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { addToQueue, clearQueue, listQueue, TrackNotFoundError } from "@workspace/arena/lib/waveyard/library/service";

export const runtime = "nodejs";

/** GET /api/library/queue — the play queue, in order. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ queue: await listQueue(user.id) });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

const addSchema = z.object({
  trackId: z.string().uuid(),
  at: z.enum(["end", "next"]).optional(),
  currentTrackId: z.string().uuid().nullable().optional(),
});

/** POST /api/library/queue — add a track at the end or "next". */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const parsed = addSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "A track id is required." }, { status: 400 });
    const result = await addToQueue({ ownerId: user.id, ...parsed.data });
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof TrackNotFoundError) return Response.json({ error: "Track not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}

/** DELETE /api/library/queue — clear the whole queue. */
export async function DELETE() {
  try {
    const user = await requireUser();
    return Response.json(await clearQueue(user.id));
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
