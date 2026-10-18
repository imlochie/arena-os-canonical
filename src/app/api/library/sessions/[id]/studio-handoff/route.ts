import { z } from "zod";
import { normalizeTransitionConfig, type TransitionConfig } from "@/lib/waveyard/library/session-logic";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/api/ids";
import { requireUser } from "@/lib/waveyard/local-context";
import {
  SessionNotFoundError,
  StemSwapRefusedError,
  sendSessionToStudio,
  getSession,
} from "@/lib/waveyard/library/session-service";

export const runtime = "nodejs";

const handoffSchema = z.object({
  mode: z.enum(["sequential", "transitions"]),
  trackEdits: z.array(z.object({
    id: z.string().uuid(), stemMix: z.record(z.string(), z.number().finite()),
    transition: z.custom<TransitionConfig>((value) => normalizeTransitionConfig(value) !== null).transform((value) => normalizeTransitionConfig(value)!),
  })).max(256).optional(),
});

/**
 * POST /api/library/sessions/[id]/studio-handoff — derive an explicit Studio
 * object (project + remix session with tracks REFERENCING the existing stems)
 * from the listening session. No audio is copied; originals are never
 * modified.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await getSession(user.id, id);
    const body = await request.json().catch(() => null);
    if (!body?.mode) return NextResponse.json({
      errorCode: "handoff_confirmation_required",
      error: "Choose completed transitions to preserve saved cue timing, or explicitly choose a sequential edit without transitions. The listening session remains available.",
    }, { status: 409 });
    const parsed = handoffSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Choose transitions or sequential mode and provide valid session edits." }, { status: 400 });
    const result = await sendSessionToStudio(user.id, id, parsed.data.trackEdits, parsed.data.mode);
    return NextResponse.json({ handoff: result }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof StemSwapRefusedError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof Response) return error;
    throw error;
  }
}
