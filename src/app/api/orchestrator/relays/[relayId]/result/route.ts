import { requireApiAccess } from "@/lib/security/api-access";
import { isUuid } from "@/lib/api/ids";
import { getRelayResult, orchestratorErrorResponse } from "@/lib/orchestrator";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ relayId: string }> }) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  const { relayId } = await params;
  if (!isUuid(relayId)) return Response.json({ error: "not found" }, { status: 404 });
  try {
    const retained = await getRelayResult(relayId);
    if (!retained) return Response.json({ error: "No retained result exists for this relay. Its executor will not be replayed automatically." }, { status: 404 });
    return new Response(retained.receipt.text, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="relay-${relayId}-result.txt"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (error) { return orchestratorErrorResponse(error); }
}
