import { deleteAgent } from "@/lib/spaces";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; agentId: string }> }) {
  const { id, agentId } = await ctx.params;
  try {
    const removed = await deleteAgent(id, agentId);
    if (!removed) return Response.json({ error: "agent not found" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "delete failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
