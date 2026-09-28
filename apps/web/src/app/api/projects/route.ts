import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, projectMembers, projects } from "@waveyard/database";
import { requireUser } from "@/lib/auth";

const createSchema = z.object({ title: z.string().trim().min(1).max(160), description: z.string().trim().max(4000).optional(), genre: z.string().trim().max(80).optional(), licenseCode: z.string().trim().max(80).optional() });
export async function GET() {
  try {
    const user = await requireUser();
    const rows = await getDb().select({ project: projects, role: projectMembers.role }).from(projectMembers).innerJoin(projects, eq(projectMembers.projectId, projects.id)).where(eq(projectMembers.userId, user.id)).orderBy(desc(projects.updatedAt)).limit(50);
    return NextResponse.json({ projects: rows.map((row) => ({ ...row.project, role: row.role })) });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "A project title is required." }, { status: 400 });
    const db = getDb();
    const project = await db.transaction(async (tx) => {
      const [created] = await tx.insert(projects).values({ ownerId: user.id, title: parsed.data.title, description: parsed.data.description ?? "", genre: parsed.data.genre || null, licenseCode: parsed.data.licenseCode || "all-rights-reserved" }).returning();
      await tx.insert(projectMembers).values({ projectId: created.id, userId: user.id, role: "owner" });
      return created;
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
