import { addRelay } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

// POST → add a relay (manual routing)
// {target (participant key), source?, purpose?, request (required),
//  contextRefs?, classification?, responseContract?}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json();
    const request = String(body.request ?? "").trim();
    if (!request) return Response.json({ error: "a relay needs a request" }, { status: 400 });
    if (!String(body.target ?? "").trim()) {
      return Response.json({ error: "a relay needs a target participant key" }, { status: 400 });
    }
    const relay = await addRelay(id, {
      source: body.source,
      target: String(body.target),
      purpose: body.purpose,
      request,
      contextRefs: Array.isArray(body.contextRefs) ? body.contextRefs.map(String) : [],
      classification: body.classification,
      responseContract: body.responseContract,
      toolUse: Boolean(body.toolUse),
    });
    return Response.json({ relay }, { status: 201 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed to add relay" }, { status: 400 });
  }
}
