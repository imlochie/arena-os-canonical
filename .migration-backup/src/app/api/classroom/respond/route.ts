import { respondStudent } from "@/lib/classroom";

export const dynamic = "force-dynamic";

// POST → the student answers a checkpoint relay.
// {relayId (required), response?, rejected?}
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const relayId = String(body.relayId ?? "");
    if (!relayId) return Response.json({ error: "relayId is required" }, { status: 400 });
    const relay = await respondStudent(relayId, {
      response: typeof body.response === "string" ? body.response : undefined,
      rejected: Boolean(body.rejected),
    });
    if (!relay) return Response.json({ error: "relay not found" }, { status: 404 });
    return Response.json({ relay });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed to respond" }, { status: 400 });
  }
}
