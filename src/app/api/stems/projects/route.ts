import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { arenaProjectMembers, projects } from "@/db/schema";
import { requireStemUser } from "@/lib/stems/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireStemUser();
    const rows = await db.select({
      id: projects.id, name: projects.name, description: projects.description, emoji: projects.emoji,
      status: projects.status, createdAt: projects.createdAt, updatedAt: projects.updatedAt, role: arenaProjectMembers.role,
    }).from(arenaProjectMembers).innerJoin(projects, eq(arenaProjectMembers.projectId, projects.id))
      .where(eq(arenaProjectMembers.userId, user.id)).orderBy(desc(projects.updatedAt));
    return Response.json({ projects: rows });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Stem project list failed", error);
    return Response.json({ error: "Could not load private Stem Lab projects." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireStemUser();
    const body = await request.json();
    const name = String(body.name ?? "").trim().slice(0, 80);
    const description = String(body.description ?? "").trim().slice(0, 500);
    if (!name) return Response.json({ error: "A project name is required." }, { status: 400 });
    const [project] = await db.transaction(async (tx) => {
      const [created] = await tx.insert(projects).values({ name, description, emoji: "🎚️" }).returning();
      await tx.insert(arenaProjectMembers).values({ projectId: created.id, userId: user.id, role: "owner" });
      return [created];
    });
    return Response.json({ project: { ...project, role: "owner" } }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Stem project creation failed", error);
    return Response.json({ error: "Could not create the private Stem Lab project." }, { status: 500 });
  }
}
