import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/api/ids";
import { requireUser } from "@/lib/waveyard/local-context";
import {
  SessionNotFoundError,
  deleteSession,
  getSession,
  renameSession,
} from "@/lib/waveyard/library/session-service";

export const runtime = "nodejs";

/** GET /api/library/sessions/[id] — full session detail (ordered tracks,
 * stem mixes, transitions, swaps, restore point). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    return NextResponse.json({ session: await getSession(user.id, id) });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}

const renameSchema = z.object({ name: z.string().trim().min(1).max(160) });

/** PATCH /api/library/sessions/[id] — rename. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const parsed = renameSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "A session name is required." }, { status: 400 });
    const session = await renameSession(user.id, id, parsed.data.name);
    return NextResponse.json({ session });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}

/** DELETE /api/library/sessions/[id] — delete the session (tracks stay in
 * the library). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await deleteSession(user.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (error instanceof Response) return error;
    throw error;
  }
}
