import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/api/ids";
import { requireUser } from "@/lib/waveyard/local-context";
import { SessionNotFoundError, saveSessionState } from "@/lib/waveyard/library/session-service";

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
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = stateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid session state." }, { status: 400 });
    const session = await saveSessionState(
      user.id,
      id,
      parsed.data.currentSessionTrackId,
      parsed.data.positionSeconds,
    );
    return NextResponse.json({ session });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}
