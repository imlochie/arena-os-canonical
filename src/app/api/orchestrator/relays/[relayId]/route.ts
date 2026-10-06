import { respondToRelay } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

// POST → answer a human checkpoint relay
// {response?, rejected?} — rejected marks the relay cancelled instead.
export async function POST(req: Request, { params }: { params: Promise<{ relayId: string }> }) {
  const { relayId } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const relay = await respondToRelay(relayId, {
      response: typeof body.response === "string" ? body.response : undefined,
      rejected: Boolean(body.rejected),
    });
    if (!relay) return Response.json({ error: "relay not found" }, { status: 404 });
    return Response.json({ relay });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed to respond" }, { status: 400 });
  }
}
