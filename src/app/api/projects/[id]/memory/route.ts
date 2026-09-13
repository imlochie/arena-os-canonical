import { standardApiError } from "@/lib/apiErrors";
import { db } from "@/db";
import { projectMemory, projects } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const KINDS = ["fact", "decision", "preference", "open_question", "rejected_idea", "source"];

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const rows = await db
      .select()
      .from(projectMemory)
      .where(eq(projectMemory.projectId, id))
      .orderBy(desc(projectMemory.createdAt))
      .limit(200);
    return Response.json({ memory: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ memory: [] });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [p] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!p) return standardApiError("RESOURCE_NOT_FOUND", "Project not found.", 404);
    const body = await req.json();
    const kind = KINDS.includes(String(body.kind)) ? String(body.kind) : "fact";
    const content = (body.content ?? "").toString().trim().slice(0, 2000);
    if (!content) return standardApiError("INVALID_REQUEST", "Content required.", 400);
    const [row] = await db.insert(projectMemory).values({ projectId: id, kind, content }).returning();
    await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
    return Response.json({ memory: row }, { status: 201 });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Create failed.", 500);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const memId = url.searchParams.get("id");
    if (!memId) return standardApiError("INVALID_REQUEST", "Id required.", 400);
    await db.delete(projectMemory).where(eq(projectMemory.id, memId));
    await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Delete failed.", 500);
  }
}
