import { getClassroomState, startClass, localDateStr } from "@/lib/classroom";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST → create/resume today's (or ?date=) class occurrence + collaboration
// and queue the orientation relay.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const dateParam = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : localDateStr();
    const state = await startClass(dateParam, {
      keys: body.localOnly ? undefined : body.keys,
      localOnly: Boolean(body.localOnly),
    });
    return Response.json({ state });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed to start class" }, { status: 400 });
  }
}
