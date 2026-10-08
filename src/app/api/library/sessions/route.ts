import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/waveyard/local-context";
import { createSession, listSessions } from "@/lib/waveyard/library/session-service";

export const runtime = "nodejs";

/** GET /api/library/sessions — the owner's listening sessions. */
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ sessions: await listSessions(user.id) });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

const createSchema = z.object({ name: z.string().trim().min(1).max(160) });

/** POST /api/library/sessions — create a session. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "A session name is required." }, { status: 400 });
    const session = await createSession(user.id, parsed.data.name);
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
