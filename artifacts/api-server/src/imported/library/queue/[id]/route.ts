
import { z } from "zod";
import { isUuid } from "@workspace/arena/lib/api/ids";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { moveQueueItem, QueueItemNotFoundError, removeQueueItem } from "@workspace/arena/lib/waveyard/library/service";

export const runtime = "nodejs";

const moveSchema = z.object({ position: z.number().int().min(0) });

/** PATCH /api/library/queue/[id] — move a queue item to a position. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = moveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "A target position is required." }, { status: 400 });
    const queue = await moveQueueItem(user.id, id, parsed.data.position);
    return Response.json({ queue });
  } catch (error) {
    if (error instanceof QueueItemNotFoundError) return Response.json({ error: "Queue item not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}

/** DELETE /api/library/queue/[id] — remove one queue item. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    return Response.json(await removeQueueItem(user.id, id));
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
