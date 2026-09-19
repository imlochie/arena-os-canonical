import { listConflicts, resolveConflict } from "@/lib/college/reconciliation";

export const dynamic = "force-dynamic";

// GET → institutional reconciliation state. A conflict persists as state until
// an explicit institutional act closes it.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? undefined;
    const conflicts = await listConflicts(status);
    return Response.json({ conflicts });
  } catch (e) {
    console.error(e);
    return Response.json({ conflicts: [] });
  }
}

// PATCH → resolve / acknowledge a conflict. Requires a stated resolution and
// its provenance; the College does not close disagreements by assertion.
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const id = String(body.id ?? "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const r = await resolveConflict({
      id,
      resolution: String(body.resolution ?? ""),
      resolutionProvenance: String(body.resolutionProvenance ?? ""),
      resolvedBy: String(body.resolvedBy ?? "founder"),
      status: body.status,
    });
    if (!r.ok) return Response.json({ error: r.error }, { status: 400 });
    return Response.json({ conflict: r.conflict });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "resolve failed" }, { status: 500 });
  }
}
