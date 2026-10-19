import { requireApiAccess } from "@/lib/security/api-access";
import { isUuid } from "@/lib/api/ids";
import { retrieveMissionOutput } from "@/lib/spaces/mission-outputs";
export const dynamic = "force-dynamic";
export async function GET(req: Request, ctx: { params: Promise<{ id: string; outputId: string }> }) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  const { id, outputId } = await ctx.params; const missionId = new URL(req.url).searchParams.get("missionId") ?? "";
  if (![id, outputId, missionId].every(isUuid)) return Response.json({ error: "Stable space, mission and output IDs are required." }, { status: 400 });
  try {
    const { output, bytes } = await retrieveMissionOutput(id, missionId, outputId);
    const inline = new URL(req.url).searchParams.get("view") === "1" && output.mediaType?.startsWith("text/");
    return new Response(new Uint8Array(bytes), { headers: { "content-type": output.mediaType ?? "application/octet-stream", "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(output.path.split(/[\\/]/).at(-1) ?? "output")}`, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-checksum-sha256": output.checksumSha256! } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Output unavailable." }, { status: 410 }); }
}
