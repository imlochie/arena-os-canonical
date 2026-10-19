import { downloadReclamation, reclamationPolicy, reportReclamation, markReclamation, listReclamations, sweepReclamation, restoreReclamation } from "@/lib/artifact-reclamation";
import { requireApiAccess } from "@/lib/security/api-access";
import { requireUser } from "@/lib/waveyard/local-context";
import { inventoryArtifactObjects, inspectOwnedObject, recoverArtifactObject } from "@/lib/artifact-object-recovery";
import { ArtifactObjectError, downloadArtifactObject } from "@/lib/artifact-objects";
export const dynamic = "force-dynamic";
function failure(error: unknown) { return Response.json({ error: error instanceof ArtifactObjectError ? error.message : "Storage operation not acknowledged. Inspect the cleanup audit before retrying; physical storage may already have changed." }, { status: error instanceof ArtifactObjectError ? error.status : 503 }); }
export async function GET(req: Request) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  try { const user = await requireUser(); const query = new URL(req.url).searchParams; if (query.has("reclamationDownload")) return await downloadReclamation(user.id, String(query.get("reclamationDownload"))); if (query.has("reclamation")) return Response.json({ policy: reclamationPolicy(), operations: await listReclamations(user.id) }); const sha = query.get("sha"); if (sha) return await downloadArtifactObject(user.id, await inspectOwnedObject(user.id, sha), `retained-${sha}.bin`); return Response.json(await inventoryArtifactObjects(user.id)); } catch (error) { return failure(error); }
}
export async function POST(req: Request) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  try { const user = await requireUser(); const body = await req.json();
    if (body.action === "report") return Response.json(await reportReclamation(user.id, String(body.sha256 ?? "")));
    if (body.action === "mark") return Response.json({ operation: await markReclamation(user.id, String(body.sha256 ?? ""), String(body.id ?? ""), body.abandonRecovery === true) }, { status: 201 });
    if (body.action === "sweep" || body.action === "purge") return Response.json({ operation: await sweepReclamation(user.id, String(body.id ?? ""), body.execute === true, body.action === "purge") });
    if (body.action === "restore") return Response.json({ operation: await restoreReclamation(user.id, String(body.id ?? "")) });
    if (body.action !== undefined) throw new ArtifactObjectError("Unknown storage operation.", 400);
    const artifact = await recoverArtifactObject(user.id, String(body.sha256 ?? "")); return Response.json({ artifact }, { status: 201 }); } catch (error) { return failure(error); }
}
