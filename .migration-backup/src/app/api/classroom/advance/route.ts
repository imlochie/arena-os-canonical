import { advanceClass, localDateStr } from "@/lib/classroom";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST → one bounded step: dispatch a pending relay, surface the student
// checkpoint, or transition the class to its next phase.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const dateParam = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : localDateStr();
    const result = await advanceClass(dateParam, {
      keys: body.localOnly ? undefined : body.keys,
      localOnly: Boolean(body.localOnly),
    });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed to advance class" }, { status: 400 });
  }
}
