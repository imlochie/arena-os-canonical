
import { ReorderSavedQueueBody } from "@workspace/api-zod";
import { isUuid } from "@workspace/arena/lib/api/ids";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import {
  moveQueueItem,
  listQueue,
  OrderingConflictError,
  QueueItemNotFoundError,
  QueueSessionNotFoundError,
  removeQueueItem,
} from "@workspace/arena/lib/waveyard/library/service";

export const runtime = "nodejs";

const moveSchema = ReorderSavedQueueBody;

/** PATCH /api/library/queue/[id] — move a queue item to a position. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = moveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "A target position is required." }, { status: 400 });
    const result = await moveQueueItem(user.id, id, parsed.data.position, parsed.data.sessionId, parsed.data.expectedOrder);
    return Response.json(result);
  } catch (error) {
    if (error instanceof OrderingConflictError) {
      const user = await requireUser();
      return Response.json({ error: error.message, queue: await listQueue(user.id) }, { status: 409 });
    }
    if (error instanceof QueueItemNotFoundError) return Response.json({ error: "Queue item not found." }, { status: 404 });
    if (error instanceof QueueSessionNotFoundError) return Response.json({ error: "Listening session not found." }, { status: 404 });
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
