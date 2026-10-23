import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ArtifactContentError, assertArtifactBodySize, insertArtifact, listArtifacts } from "@/lib/arcadeStore";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireApiAccess } from "@/lib/security/api-access";

export const dynamic = "force-dynamic";

const KINDS = ["brief", "decision", "research", "concept", "plan", "critique", "prompt", "spec", "comparison", "answer"];

// Same-table read as /api/artifacts: without the access guard and the owner
// predicate, this route would be a bypass around the private artifact library.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  try {
    const user = await requireUser();
    const { id } = await params;
    const rows = await listArtifacts(db, user.id, 100, false, id);
    return Response.json({ artifacts: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Artifact storage unavailable. Your saved work has not been removed; retry when the service recovers." }, { status: 503 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  try {
    const user = await requireUser();
    const { id } = await params;
    const [p] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!p) return Response.json({ error: "project not found" }, { status: 404 });
    const body = await req.json();
    const kind = KINDS.includes(String(body.kind)) ? String(body.kind) : "brief";
    const title = (body.title ?? "Untitled artifact").toString().slice(0, 160);
    const artifactBody = (body.body ?? "").toString();
    assertArtifactBodySize(artifactBody);
    if (!artifactBody.trim()) return Response.json({ error: "body required" }, { status: 400 });
    const sourceType = (body.sourceType ?? "manual").toString().slice(0, 20);
    if (sourceType === "mission-output") return Response.json({ error: "Mission output provenance must come from executed mission operations." }, { status: 400 });
    const sourceId = body.sourceId ? String(body.sourceId).slice(0, 80) : null;
    // Record the caller as owner through the shared store (never a raw insert
    // that would fall back to the column default).
    const row = await db.transaction(async (tx) => {
      const row = await insertArtifact(tx, {
        projectId: id, kind, title, body: artifactBody,
        sourceType, sourceId, ownerId: user.id,
      });
      await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
      return row;
    });
    return Response.json({ artifact: row }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: e instanceof ArtifactContentError ? e.message : "Could not confirm project Artifact creation. Reload the library before retrying." }, { status: e instanceof ArtifactContentError ? 413 : 503 });
  }
}
