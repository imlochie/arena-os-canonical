import { deleteSpace, getSpace, getSpaceRuns, updateSpace } from "@/lib/spaces";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const space = await getSpace(id);
    if (!space) return Response.json({ error: "space not found" }, { status: 404 });
    const runs = await getSpaceRuns(id, 25);
    return Response.json({ space, runs });
  } catch (e) {
    const message = e instanceof Error ? e.message : "load failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

// PATCH → update {title?, emoji?, prompt?, modelId?, intervalMinutes?, status?, briefcase?}
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const space = await updateSpace(id, {
      title: body?.title !== undefined ? String(body.title) : undefined,
      emoji: body?.emoji !== undefined ? String(body.emoji) : undefined,
      prompt: body?.prompt !== undefined ? String(body.prompt) : undefined,
      modelId: body?.modelId !== undefined ? String(body.modelId) : undefined,
      intervalMinutes: body?.intervalMinutes !== undefined ? Number(body.intervalMinutes) : undefined,
      status: body?.status === "paused" || body?.status === "running" ? body.status : undefined,
      briefcase: body?.briefcase !== undefined ? String(body.briefcase) : undefined,
    });
    if (!space) return Response.json({ error: "space not found" }, { status: 404 });
    return Response.json({ space });
  } catch (e) {
    const message = e instanceof Error ? e.message : "update failed";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const existed = await deleteSpace(id);
    if (!existed) return Response.json({ error: "space not found" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "delete failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
