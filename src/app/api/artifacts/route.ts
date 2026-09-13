import { standardApiError } from "@/lib/apiErrors";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

// GET → global artifact library (optionally ?projectId=, ?kind=, ?q=)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
  const projectId = url.searchParams.get("projectId");
  const kind = url.searchParams.get("kind");
  const q = (url.searchParams.get("q") ?? "").toLowerCase().trim();
  try {
    let rows = await db.select().from(artifacts).orderBy(desc(artifacts.createdAt)).limit(200);
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
  try {
    const body = await req.json();
    const title = (body.title ?? "Untitled artifact").toString().slice(0, 160);
    const artifactBody = (body.body ?? "").toString().slice(0, 20000);
    if (!artifactBody.trim()) return standardApiError("INVALID_REQUEST", "Body required.", 400);
    const kind = (body.kind ?? "brief").toString().slice(0, 20);
    const projectId = body.projectId ? String(body.projectId) : null;
    const sourceType = (body.sourceType ?? "manual").toString().slice(0, 20);
    const sourceId = body.sourceId ? String(body.sourceId).slice(0, 80) : null;
    const [row] = await db
      .insert(artifacts)
      .values({ projectId, kind, title, body: artifactBody, sourceType, sourceId })
      .returning();
    return Response.json({ artifact: row }, { status: 201 });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Create failed.", 500);
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return standardApiError("INVALID_REQUEST", "Id required.", 400);
    await db.delete(artifacts).where(eq(artifacts.id, id));
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Delete failed.", 500);
  }
}
