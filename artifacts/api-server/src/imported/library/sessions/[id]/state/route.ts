
import { z } from "zod";
import { isUuid } from "@workspace/arena/lib/api/ids";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { SessionNotFoundError, saveSessionState } from "@workspace/arena/lib/waveyard/library/session-service";

export const runtime = "nodejs";

const stateSchema = z.object({
  currentSessionTrackId: z.string().uuid().nullable(),
  positionSeconds: z.number().min(0),
});

/** PUT /api/library/sessions/[id]/state — persist the restore point (which
 * session track was playing, and where). Live transport never waits on this. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = stateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid session state." }, { status: 400 });
    const session = await saveSessionState(
      user.id,
      id,
      parsed.data.currentSessionTrackId,
      parsed.data.positionSeconds,
    );
    return Response.json({ session });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return Response.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}
