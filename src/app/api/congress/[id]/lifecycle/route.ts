import { adjournCongress, closeCongress, resumeCongress } from "@/lib/congress";
import { isLocalOnlyBody } from "@/lib/privacy";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

// POST {action: "adjourn" | "resume" | "close"} — chamber lifecycle controls.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = String(body?.action ?? "");
  const localOnly = isLocalOnlyBody(body);
  try {
    let session = null;
    if (action === "adjourn") session = await adjournCongress(id);
    else if (action === "resume") session = await resumeCongress(id);
    else if (action === "close") {
      session = await closeCongress(id, { keys: localOnly ? undefined : body?.keys, localOnly });
    } else {
      return Response.json({ error: 'action must be "adjourn", "resume" or "close"' }, { status: 400 });
    }
    if (!session) return Response.json({ error: "session not found" }, { status: 404 });
    return Response.json({ session });
  } catch (e) {
    const message = e instanceof Error ? e.message : "lifecycle action failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
