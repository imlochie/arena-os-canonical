import { advanceCongress } from "@/lib/congress";
import { isLocalOnlyBody } from "@/lib/privacy";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

// The workhorse: one bounded step of the sitting — a single seat speaks, or
// (time/turns exhausted) the Clerk drafts the Act and the session closes.
// The client polls this while the chamber is sitting.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* body optional */
  }
  const localOnly = isLocalOnlyBody(body);
  try {
    const result = await advanceCongress(id, {
      keys: localOnly ? undefined : body?.keys,
      localOnly,
    });
    if (!result) return Response.json({ error: "session not found" }, { status: 404 });
    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "advance failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
