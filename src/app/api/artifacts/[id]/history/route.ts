import { db } from "@/db";
import { isUuid } from "@/lib/api/ids";
import { listArtifactRevisions, restoreArtifact } from "@/lib/arcadeStore";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireApiAccess } from "@/lib/security/api-access";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(req: Request, ctx: Context) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  const { id } = await ctx.params; if (!isUuid(id)) return Response.json({ error: "not found" }, { status: 404 });
  try {
    const rawBefore = new URL(req.url).searchParams.get("before"); const before = rawBefore ? Number(rawBefore) : undefined;
    if (before !== undefined && (!Number.isInteger(before) || before < 1)) return Response.json({ error: "before must be a positive revision number." }, { status: 400 });
    const revisions = await listArtifactRevisions(db, id, (await requireUser()).id, before);
    return revisions ? Response.json({ revisions, nextBefore: revisions.length === 50 ? revisions.at(-1)!.revision : null }) : Response.json({ error: "not found" }, { status: 404 });
  } catch { return Response.json({ error: "Artifact history storage unavailable. Current content was not changed; retry." }, { status: 503 }); }
}
export async function POST(req: Request, ctx: Context) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  const { id } = await ctx.params; if (!isUuid(id)) return Response.json({ error: "not found" }, { status: 404 });
  try {
    const body = await req.json();
    if (!isUuid(body.revisionId ?? "") || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) return Response.json({ error: "revisionId and expectedRevision are required." }, { status: 400 });
    const result = await restoreArtifact(db, id, (await requireUser()).id, body.revisionId, body.expectedRevision);
    if (result.outcome === "conflict") return Response.json({ error: "Artifact changed. Reload history before restoring.", currentRevision: result.row?.revision }, { status: 409 });
    return result.outcome === "ok" ? Response.json({ artifact: result.row }) : Response.json({ error: "not found" }, { status: 404 });
  } catch { return Response.json({ error: "Could not confirm restoration. Reload current content and history before retrying." }, { status: 503 }); }
}
