import { createCollaboration, listCollaborations } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

// GET → list collaborations (with participants + relays)
export async function GET() {
  try {
    const collaborations = await listCollaborations(30);
    return Response.json({ collaborations });
  } catch (e) {
    console.error(e);
    return Response.json({ collaborations: [] });
  }
}

// POST → create a collaboration session
// {title?, goal (required), context?, autoRoute?, projectId?,
//  participants: [{name, key?, kind? model|human|external, modelId?, adapterUrl?, adapterModel?, capabilities?, trust?}],
//  relay?: {target, purpose?, request, classification?, responseContract?}}
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const goal = String(body.goal ?? "").trim();
    if (!goal) return Response.json({ error: "a collaboration needs a goal" }, { status: 400 });
    if (!Array.isArray(body.participants) || !body.participants.length) {
      return Response.json({ error: "a collaboration needs at least one participant" }, { status: 400 });
    }
    const collaboration = await createCollaboration({
      title: body.title,
      goal,
      context: body.context,
      autoRoute: Boolean(body.autoRoute),
      projectId: typeof body.projectId === "string" && body.projectId ? body.projectId : null,
      participants: body.participants,
      relay: body.relay && typeof body.relay === "object" ? body.relay : null,
    });
    return Response.json({ collaboration }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: e instanceof Error ? e.message : "failed to create collaboration" }, { status: 400 });
  }
}
