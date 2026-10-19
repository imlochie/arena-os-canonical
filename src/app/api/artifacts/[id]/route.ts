import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { isUuid } from "@/lib/api/ids";
import { deleteArtifact, getArtifact, updateArtifact } from "@/lib/arcadeStore";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireApiAccess } from "@/lib/security/api-access";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "not found" }, { status: 404 });
    // Owner-scoped read: a foreign artifact answers 404 (not 403), so the
    // endpoint never confirms that someone else's record exists.
    const row = await getArtifact(db, id, user.id);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ artifact: row });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "failed" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "not found" }, { status: 404 });
    const body = await req.json();
    const patch: Partial<typeof artifacts.$inferInsert> = {};
    if (body.title !== undefined) patch.title = String(body.title).slice(0, 160);
    if (body.body !== undefined) {
      const content = String(body.body);
      if (content.length > 20000) return Response.json({ error: "Artifact body exceeds the 20,000-character limit. The existing artifact was not changed; split the content before retrying." }, { status: 413 });
      patch.body = content;
    }
    if (body.kind !== undefined) patch.kind = String(body.kind).slice(0, 20);
    if (body.projectId !== undefined) patch.projectId = body.projectId ? String(body.projectId) : null;
    const result = await updateArtifact(db, id, user.id, patch);
    if (result.outcome === "not_found") return Response.json({ error: "not found" }, { status: 404 });
    if (result.outcome === "forbidden") return Response.json({ error: "this artifact belongs to another owner" }, { status: 403 });
    return Response.json({ artifact: result.row });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "update failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "not found" }, { status: 404 });
    const outcome = await deleteArtifact(db, id, user.id);
    if (outcome === "not_found") return Response.json({ error: "not found" }, { status: 404 });
    if (outcome === "forbidden") return Response.json({ error: "this artifact belongs to another owner" }, { status: 403 });
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "delete failed" }, { status: 500 });
  }
}
