import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/waveyard/local-context";
import { getPlaybackState, savePlaybackState } from "@/lib/waveyard/library/service";

export const runtime = "nodejs";

/** GET /api/library/playback-state — durable playback state for this owner. */
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ playbackState: await getPlaybackState(user.id) });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

const patchSchema = z.object({
  currentTrackId: z.string().uuid().nullable().optional(),
  positionSeconds: z.number().min(0).optional(),
  stemMix: z.record(z.string(), z.number()).optional(),
  masterVolume: z.number().min(0).max(1.5).optional(),
  repeatMode: z.enum(["off", "all", "one"]).optional(),
  shuffle: z.boolean().optional(),
});

/** PUT /api/library/playback-state — persist durable transport state. The
 * client throttles; live transport never waits on this. */
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid playback state patch." }, { status: 400 });
    }
    const state = await savePlaybackState(user.id, parsed.data);
    return NextResponse.json({ playbackState: state });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
