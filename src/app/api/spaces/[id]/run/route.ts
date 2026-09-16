import { runSpace } from "@/lib/spaces";
import { isLocalOnlyBody } from "@/lib/privacy";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

// Force a run now (ignores the schedule; next run still scheduled interval away).
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
    const space = await runSpace(id, {
      keys: localOnly ? undefined : body?.keys,
      localOnly,
    });
    if (!space) return Response.json({ error: "space not found" }, { status: 404 });
    return Response.json({ space });
  } catch (e) {
    const message = e instanceof Error ? e.message : "run failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
