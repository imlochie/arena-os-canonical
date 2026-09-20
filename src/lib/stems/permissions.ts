import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { arenaProjectMembers, projects } from "@/db/schema";

export type StemProjectRole = "owner" | "editor" | "viewer";
const rank: Record<StemProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };

export async function requireStemProjectRole(userId: string, projectId: string, minimum: StemProjectRole) {
  const rows = await db.select({ project: projects, role: arenaProjectMembers.role })
    .from(arenaProjectMembers)
    .innerJoin(projects, eq(arenaProjectMembers.projectId, projects.id))
    .where(and(eq(arenaProjectMembers.projectId, projectId), eq(arenaProjectMembers.userId, userId)))
    .limit(1);
  const access = rows[0];
  if (!access) throw Response.json({ error: "This private project is not available to your account." }, { status: 403 });
  const role = access.role as StemProjectRole;
  if (!rank[role] || rank[role] < rank[minimum]) throw Response.json({ error: "Your project role does not permit this action." }, { status: 403 });
  return { project: access.project, role };
}
