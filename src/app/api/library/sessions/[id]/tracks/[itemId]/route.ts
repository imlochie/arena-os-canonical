import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/api/ids";
import { requireUser } from "@/lib/waveyard/local-context";
import {
  SessionNotFoundError,
  SessionTrackNotFoundError,
  updateSessionTrack,
} from "@/lib/waveyard/library/session-service";

export const runtime = "nodejs";

const patchSchema = z.object({
  stemMix: z.record(z.string(), z.number()).optional(),
  transition: z
    .object({
      mode: z.enum(["manual", "beat", "bar", "meeting-point"]),
      crossfadeSeconds: z.number().min(0).max(30),
      keepStems: z.array(z.string().min(1).max(64)).optional(),
    })
    .optional(),
});

/** PATCH /api/library/sessions/[id]/tracks/[itemId] — persist this track's
 * stem mix and/or transition configuration. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  try {
    const user = await requireUser();
    const { id, itemId } = await params;
    if (!isUuid(id) || !isUuid(itemId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid stem mix or transition." }, { status: 400 });
    const session = await updateSessionTrack(user.id, id, itemId, parsed.data);
    return NextResponse.json({ session });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof SessionTrackNotFoundError) return NextResponse.json({ error: "Session track not found." }, { status: 404 });
    if (error instanceof Error && error.message.startsWith("The ")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof Response) return error;
    throw error;
  }
}
