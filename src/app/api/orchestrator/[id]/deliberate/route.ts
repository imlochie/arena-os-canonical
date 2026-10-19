import { requireApiAccess } from "@/lib/security/api-access";
import { startDeliberationRound } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

// POST → queue one deliberation round: a perspective relay to every non-human
// participant, then a synthesis relay that weighs them all.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  const { id } = await params;
  try {
    const collaboration = await startDeliberationRound(id);
    return Response.json({ collaboration });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed to queue deliberation" }, { status: 400 });
  }
}
