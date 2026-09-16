import { deleteProject, getProject } from "@/lib/cut/projects";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const project = await getProject(id);
    if (!project) return Response.json({ error: "project not found" }, { status: 404 });
    return Response.json({ project });
  } catch (e) {
    const message = e instanceof Error ? e.message : "load failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const existed = await deleteProject(id);
    if (!existed) return Response.json({ error: "project not found" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "delete failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
