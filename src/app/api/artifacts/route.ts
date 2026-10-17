import { db } from "@/db";
import { isUuid } from "@/lib/api/ids";
import { deleteArtifact, insertArtifact, listArtifacts } from "@/lib/arcadeStore";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireApiAccess } from "@/lib/security/api-access";

export const dynamic = "force-dynamic";

// GET → the caller's artifact library (optionally ?projectId=, ?kind=, ?q=).
// Artifacts are private working data: the read is access-gated AND scoped to
// the caller's owner id, matching the ownership boundary on every mutation.
export async function GET(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  const user = await requireUser();
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
  const projectId = url.searchParams.get("projectId");
  const kind = url.searchParams.get("kind");
  const q = (url.searchParams.get("q") ?? "").toLowerCase().trim();
  try {
    let rows = await listArtifacts(db, user.id, 200);
    if (projectId) rows = rows.filter((r) => r.projectId === projectId);
    if (kind) rows = rows.filter((r) => r.kind === kind);
    if (q) rows = rows.filter((r) => (r.title + " " + r.body).toLowerCase().includes(q));
    return Response.json({ artifacts: rows.slice(0, limit) });
  } catch (e) {
    console.error(e);
    return Response.json({ artifacts: [] });
  }
}

// POST → create unscoped (or scoped) artifact from any tool
export async function POST(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  try {
    const user = await requireUser();
    const body = await req.json();
    const title = (body.title ?? "Untitled artifact").toString().slice(0, 160);
    const artifactBody = (body.body ?? "").toString().slice(0, 20000);
    if (!artifactBody.trim()) return Response.json({ error: "body required" }, { status: 400 });
    const kind = (body.kind ?? "brief").toString().slice(0, 20);
    const projectId = body.projectId ? String(body.projectId) : null;
    const sourceType = (body.sourceType ?? "manual").toString().slice(0, 20);
    const sourceId = body.sourceId ? String(body.sourceId).slice(0, 80) : null;
    const row = await insertArtifact(db, {
      projectId,
      kind,
      title,
      body: artifactBody,
      sourceType,
      sourceId,
      ownerId: user.id,
    });
    return Response.json({ artifact: row }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "create failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
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
