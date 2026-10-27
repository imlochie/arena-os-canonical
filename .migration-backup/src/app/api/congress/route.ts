import { createCongress, listCongresses, type CongressSeat } from "@/lib/congress";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(60, Math.max(1, Number(url.searchParams.get("limit")) || 30));
  try {
    const sessions = await listCongresses(limit);
    return Response.json({ sessions });
  } catch {
    return Response.json({ sessions: [] });
  }
}

// POST → convene a congress {topic, seats[], durationMinutes, synthesisModel, projectId?, reconveneOf?}
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const seats: CongressSeat[] = Array.isArray(body?.seats)
      ? body.seats.map((s: any) => ({
          label: s?.label ? String(s.label) : undefined,
          role: String(s?.role ?? "proposer"),
          modelId: String(s?.modelId ?? "openai"),
        }))
      : [];
    const session = await createCongress({
      title: body?.title ? String(body.title) : undefined,
      topic: String(body?.topic ?? ""),
      seats,
      synthesisModel: body?.synthesisModel ? String(body.synthesisModel) : undefined,
      durationMinutes: Number(body?.durationMinutes) || undefined,
      maxTurns: body?.maxTurns ? Number(body.maxTurns) : undefined,
      projectId: body?.projectId ? String(body.projectId) : null,
      reconveneOf: body?.reconveneOf ? String(body.reconveneOf) : undefined,
    });
    return Response.json({ session }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "convene failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
