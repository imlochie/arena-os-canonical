import { and, eq } from "drizzle-orm";
import { getDb, projectMembers, projects } from "@waveyard/database";

const LEVEL = { viewer: 0, contributor: 1, editor: 2, owner: 3 } as const;
type Role = keyof typeof LEVEL;

export async function requireProjectRole(userId: string, projectId: string, minimum: Role) {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Response("Project not found.", { status: 404 });
  const [membership] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId))).limit(1);
  const role = (membership?.role ?? (project.ownerId === userId ? "owner" : null)) as Role | null;
  if (!role || LEVEL[role] < LEVEL[minimum]) throw new Response("You do not have access to this project.", { status: 403 });
  return { project, role };
}
