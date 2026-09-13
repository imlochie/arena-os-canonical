import { standardApiError } from "@/lib/apiErrors";
import { db } from "@/db";
import {
  arcadeGames,
  artifacts,
  battles,
  chats,
  collabs,
  councilArtifacts,
  councilRuns,
  projectMemory,
  projects,
} from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { logPrivacyEvent } from "@/lib/privacy";

export const dynamic = "force-dynamic";

// GET → full project workspace overview
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!project) return standardApiError("RESOURCE_NOT_FOUND", "Not found.", 404);

    const [b, c, r, ch, a, mem, arts, carts] = await Promise.all([
      db.select().from(battles).where(eq(battles.projectId, id)).orderBy(desc(battles.createdAt)).limit(10),
      db.select().from(collabs).where(eq(collabs.projectId, id)).orderBy(desc(collabs.createdAt)).limit(10),
      db.select().from(councilRuns).where(eq(councilRuns.projectId, id)).orderBy(desc(councilRuns.createdAt)).limit(10),
      db.select().from(chats).where(eq(chats.projectId, id)).orderBy(desc(chats.createdAt)).limit(10),
      db.select().from(arcadeGames).where(eq(arcadeGames.projectId, id)).orderBy(desc(arcadeGames.createdAt)).limit(6),
      db.select().from(projectMemory).where(eq(projectMemory.projectId, id)).orderBy(desc(projectMemory.createdAt)).limit(100),
      db.select().from(artifacts).where(eq(artifacts.projectId, id)).orderBy(desc(artifacts.createdAt)).limit(30),
      db.select().from(councilArtifacts).orderBy(desc(councilArtifacts.createdAt)).limit(50),
    ]);

    // Council artifacts belong to runs; filter to this project's runs
    const runIds = new Set(r.map((x) => x.id));
    const projectCouncilArtifacts = carts.filter((x) => runIds.has(x.runId));

    return Response.json({
      project,
      battles: b,
      collabs: c,
      councils: r,
      chats: ch,
      arcade: a,
      memory: mem,
      artifacts: arts,
      councilArtifacts: projectCouncilArtifacts,
    });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Failed.", 500);
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 80);
    if (body.description !== undefined) patch.description = String(body.description).slice(0, 500);
    if (body.emoji !== undefined) patch.emoji = String(body.emoji).slice(0, 8);
    if (body.status !== undefined) patch.status = String(body.status).slice(0, 20);
    const [row] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
    if (!row) return standardApiError("RESOURCE_NOT_FOUND", "Not found.", 404);
    return Response.json({ project: row });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Update failed.", 500);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(projectMemory).where(eq(projectMemory.projectId, id));
    await db.delete(artifacts).where(eq(artifacts.projectId, id));
    // Unlink (don't destroy) work items
    await db.update(battles).set({ projectId: null }).where(eq(battles.projectId, id));
    await db.update(collabs).set({ projectId: null }).where(eq(collabs.projectId, id));
    await db.update(councilRuns).set({ projectId: null }).where(eq(councilRuns.projectId, id));
    await db.update(chats).set({ projectId: null }).where(eq(chats.projectId, id));
    await db.update(arcadeGames).set({ projectId: null }).where(eq(arcadeGames.projectId, id));
    await db.delete(projects).where(eq(projects.id, id));
    await logPrivacyEvent("delete_project", id);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Delete failed.", 500);
  }
}
