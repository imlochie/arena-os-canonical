import { advanceCollaboration } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST → perform ONE step: dispatch the next pending relay (model/external),
// surface a human checkpoint, or let the conductor route an idle session.
// {keys?, localOnly?}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const result = await advanceCollaboration(id, {
      keys: body.localOnly ? undefined : body.keys,
      localOnly: Boolean(body.localOnly),
    });
    if (!result) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(result);
  } catch (e) {
    console.error(e);
    return Response.json({ error: e instanceof Error ? e.message : "advance failed" }, { status: 500 });
  }
}
