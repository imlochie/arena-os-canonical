import { createAgent, getSpace, listAgents } from "@/lib/spaces";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agents = await listAgents(id);
  return Response.json({ agents });
}

// POST → add an agent {name, role?, modelId?, systemPrompt?}
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const space = await getSpace(id);
    if (!space) return Response.json({ error: "space not found" }, { status: 404 });
    const agent = await createAgent(id, {
      name: body?.name ? String(body.name) : undefined,
      role: body?.role ? String(body.role) : undefined,
      modelId: body?.modelId ? String(body.modelId) : undefined,
      systemPrompt: body?.systemPrompt ? String(body.systemPrompt) : undefined,
    });
    return Response.json({ agent }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "create failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
