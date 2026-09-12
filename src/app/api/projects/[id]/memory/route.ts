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
    if (!p) return Response.json({ error: "project not found" }, { status: 404 });
    const body = await req.json();
    const kind = KINDS.includes(String(body.kind)) ? String(body.kind) : "fact";
    const content = (body.content ?? "").toString().trim().slice(0, 2000);
    if (!content) return Response.json({ error: "content required" }, { status: 400 });
    const [row] = await db.insert(projectMemory).values({ projectId: id, kind, content }).returning();
    await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
    return Response.json({ memory: row }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "create failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const memId = url.searchParams.get("id");
    if (!memId) return Response.json({ error: "id required" }, { status: 400 });
    await db.delete(projectMemory).where(eq(projectMemory.id, memId));
    await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "delete failed" }, { status: 500 });
  }
}
