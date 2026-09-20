import { eq, or } from "drizzle-orm";
import { db } from "@/db";
import { arenaProjectMembers, arenaUsers } from "@/db/schema";
import { requireStemUser } from "@/lib/stems/auth";
import { requireStemProjectRole, type StemProjectRole } from "@/lib/stems/permissions";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireStemUser();
    const { id } = await params;
    await requireStemProjectRole(user.id, id, "owner");
    const body = await request.json();
    const identity = String(body.identity ?? "").trim().toLowerCase();
    const role = String(body.role ?? "viewer") as StemProjectRole;
    if (!identity || !["editor", "viewer"].includes(role)) return Response.json({ error: "Choose an existing user and an editor or viewer role." }, { status: 400 });
    const [member] = await db.select().from(arenaUsers).where(or(eq(arenaUsers.username, identity), eq(arenaUsers.email, identity))).limit(1);
    if (!member) return Response.json({ error: "No Arena Stem Lab account matches that username or email." }, { status: 404 });
    const [membership] = await db.insert(arenaProjectMembers).values({ projectId: id, userId: member.id, role })
      .onConflictDoUpdate({ target: [arenaProjectMembers.projectId, arenaProjectMembers.userId], set: { role } }).returning();
    return Response.json({ member: { id: member.id, username: member.username, displayName: member.displayName, role: membership.role } }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Stem project invitation failed", error);
    return Response.json({ error: "Could not update project membership." }, { status: 500 });
  }
}
