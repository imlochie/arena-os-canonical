import { closeCollaboration, deleteCollaboration, getCollaboration } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

// GET → one collaboration with participants + relays
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const collaboration = await getCollaboration(id);
  if (!collaboration) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ collaboration });
}

// PATCH → {status: "closed", summary?} closes the collaboration and files its record
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json();
    if (String(body.status ?? "") !== "closed") {
      return Response.json({ error: 'only {"status":"closed"} is supported' }, { status: 400 });
    }
    const collaboration = await closeCollaboration(id, typeof body.summary === "string" ? body.summary : undefined);
    return Response.json({ collaboration });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed to close" }, { status: 400 });
  }
}

// DELETE → remove a collaboration (relays + participants go with it)
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = await deleteCollaboration(id);
  if (!ok) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}
