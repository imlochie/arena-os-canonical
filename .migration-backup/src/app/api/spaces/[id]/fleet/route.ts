import { runFleet } from "@/lib/spaces";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST → run every agent in the space concurrently + synthesize.
// Body: { keys?: BYOK provider keys, localOnly?: boolean } — same convention
// as the tick endpoint.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* body optional */
  }
  const localOnly = body?.localOnly === true;
  try {
    const result = await runFleet(id, { keys: localOnly ? undefined : body?.keys, localOnly });
    if (!result) return Response.json({ error: "space not found" }, { status: 404 });
    if (!result.results.length)
      return Response.json({ error: "this space has no agents yet — add agents first" }, { status: 409 });
    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "fleet run failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
