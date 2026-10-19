import { requireApiAccess } from "@/lib/security/api-access";
import { db } from "@/db";
import {
  arcadeGames,
  battles,
  chats,
  collabs,
  councilArtifacts,
  councilRuns,
  projectMemory,
  projects,
} from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { ArtifactProjectConflictError, detachProjectArtifacts, listArtifacts } from "@/lib/arcadeStore";
import { LOCAL_OWNER_ID } from "@/db/schema";
import { logPrivacyEvent } from "@/lib/privacy";

export const dynamic = "force-dynamic";

// GET → full project workspace overview
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  try {
    const { id } = await params;
    const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!project) return Response.json({ error: "not found" }, { status: 404 });

    const [b, c, r, ch, a, mem, arts, carts] = await Promise.all([
      db.select().from(battles).where(eq(battles.projectId, id)).orderBy(desc(battles.createdAt)).limit(10),
      db.select().from(collabs).where(eq(collabs.projectId, id)).orderBy(desc(collabs.createdAt)).limit(10),
      db.select().from(councilRuns).where(eq(councilRuns.projectId, id)).orderBy(desc(councilRuns.createdAt)).limit(10),
      db.select().from(chats).where(eq(chats.projectId, id)).orderBy(desc(chats.createdAt)).limit(10),
      db.select().from(arcadeGames).where(eq(arcadeGames.projectId, id)).orderBy(desc(arcadeGames.createdAt)).limit(6),
      db.select().from(projectMemory).where(eq(projectMemory.projectId, id)).orderBy(desc(projectMemory.createdAt)).limit(100),
      listArtifacts(db, LOCAL_OWNER_ID, 30, false, id),
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
    return Response.json({ error: "failed" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  try {
    const { id } = await params;
    const body = await req.json();
    const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 80);
    if (body.description !== undefined) patch.description = String(body.description).slice(0, 500);
    if (body.emoji !== undefined) patch.emoji = String(body.emoji).slice(0, 8);
    if (body.status !== undefined) patch.status = String(body.status).slice(0, 20);
    const [row] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ project: row });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "update failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  try {
    const { id } = await params;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select id from projects where id = ${id} for update`);
      await tx.delete(projectMemory).where(eq(projectMemory.projectId, id));
      await detachProjectArtifacts(tx, id, LOCAL_OWNER_ID);
      // Unlink (don't destroy) work items
      await tx.update(battles).set({ projectId: null }).where(eq(battles.projectId, id));
      await tx.update(collabs).set({ projectId: null }).where(eq(collabs.projectId, id));
      await tx.update(councilRuns).set({ projectId: null }).where(eq(councilRuns.projectId, id));
      await tx.update(chats).set({ projectId: null }).where(eq(chats.projectId, id));
      await tx.update(arcadeGames).set({ projectId: null }).where(eq(arcadeGames.projectId, id));
      await tx.delete(projects).where(eq(projects.id, id));
    });
    await logPrivacyEvent("delete_project", id);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: e instanceof ArtifactProjectConflictError ? e.message : "Project deletion was not confirmed. Reload before retrying; the database operation is atomic." }, { status: e instanceof ArtifactProjectConflictError ? 409 : 503 });
  }
}
