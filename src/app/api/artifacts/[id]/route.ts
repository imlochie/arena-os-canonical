import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { isUuid } from "@/lib/api/ids";
import { deleteArtifact, getArtifact, getArtifactRevision, updateArtifact } from "@/lib/arcadeStore";
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
    const revisionId = new URL(req.url).searchParams.get("revision");
    if (revisionId) {
      if (!isUuid(revisionId)) return Response.json({ error: "A valid immutable revision ID is required." }, { status: 400 });
      const revision = await getArtifactRevision(db, id, revisionId, user.id);
      if (!revision) return Response.json({ error: "not found" }, { status: 404 });
      if (new URL(req.url).searchParams.get("download") === "1") return new Response(revision.snapshot.body, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="artifact-${id}-revision-${revision.revision}.txt"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
      return Response.json({ revision });
    }
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
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) return Response.json({ error: "expectedRevision is required. Reload the artifact before editing." }, { status: 428 });
    const result = await updateArtifact(db, id, user.id, patch, body.expectedRevision);
    if (result.outcome === "conflict") return Response.json({ error: "Artifact changed since it was opened. Reload and reconcile your edit.", currentRevision: result.row?.revision }, { status: 409 });
    if (result.outcome === "not_found") return Response.json({ error: "not found" }, { status: 404 });
    if (result.outcome === "forbidden") return Response.json({ error: "this artifact belongs to another owner" }, { status: 403 });
    return Response.json({ artifact: result.row });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Could not confirm the update. Reload current content before retrying; your last acknowledged revision remains in history." }, { status: 503 });
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
