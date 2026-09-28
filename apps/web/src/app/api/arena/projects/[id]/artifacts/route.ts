import { db } from "@/db";
import { artifacts, projects } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const KINDS = ["brief", "decision", "research", "concept", "plan", "critique", "prompt", "spec", "comparison", "answer"];

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const rows = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.projectId, id))
      .orderBy(desc(artifacts.createdAt))
      .limit(100);
    return Response.json({ artifacts: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ artifacts: [] });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [p] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!p) return Response.json({ error: "project not found" }, { status: 404 });
    const body = await req.json();
    const kind = KINDS.includes(String(body.kind)) ? String(body.kind) : "brief";
    const title = (body.title ?? "Untitled artifact").toString().slice(0, 160);
    const artifactBody = (body.body ?? "").toString().slice(0, 20000);
    if (!artifactBody.trim()) return Response.json({ error: "body required" }, { status: 400 });
    const sourceType = (body.sourceType ?? "manual").toString().slice(0, 20);
    const sourceId = body.sourceId ? String(body.sourceId).slice(0, 80) : null;
    const [row] = await db
      .insert(artifacts)
      .values({ projectId: id, kind, title, body: artifactBody, sourceType, sourceId })
      .returning();
    await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
    return Response.json({ artifact: row }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "create failed" }, { status: 500 });
  }
}
