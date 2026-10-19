import { requireApiAccess } from "@/lib/security/api-access";
import { requireUser } from "@/lib/waveyard/local-context";
import { inventoryArtifactObjects, inspectOwnedObject, recoverArtifactObject } from "@/lib/artifact-object-recovery";
import { ArtifactObjectError, downloadArtifactObject } from "@/lib/artifact-objects";
export const dynamic = "force-dynamic";
function failure(error: unknown) { return Response.json({ error: error instanceof ArtifactObjectError ? error.message : "Storage reconciliation unavailable. No retained content was deleted; retry after services recover." }, { status: error instanceof ArtifactObjectError ? error.status : 503 }); }
export async function GET(req: Request) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  try { const user = await requireUser(); const sha = new URL(req.url).searchParams.get("sha"); if (sha) return await downloadArtifactObject(user.id, await inspectOwnedObject(user.id, sha), `retained-${sha}.bin`); return Response.json(await inventoryArtifactObjects(user.id)); } catch (error) { return failure(error); }
}
export async function POST(req: Request) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  try { const user = await requireUser(); const body = await req.json(); const artifact = await recoverArtifactObject(user.id, String(body.sha256 ?? "")); return Response.json({ artifact }, { status: 201 }); } catch (error) { return failure(error); }
}
