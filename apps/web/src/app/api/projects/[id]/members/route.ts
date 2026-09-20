import { NextResponse } from "next/server";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, projectMembers, users } from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

const memberSchema = z.object({ identity: z.string().trim().min(1).max(254), role: z.enum(["editor", "contributor", "viewer"]) });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    await requireProjectRole(user.id, id, "viewer");
    const members = await getDb().select({ id: projectMembers.id, role: projectMembers.role, userId: users.id, username: users.username, displayName: users.displayName }).from(projectMembers).innerJoin(users, eq(projectMembers.userId, users.id)).where(eq(projectMembers.projectId, id));
    return NextResponse.json({ members });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    await requireProjectRole(user.id, id, "owner");
    const parsed = memberSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Provide an existing username/email and a valid project role." }, { status: 400 });
    const identity = parsed.data.identity.toLowerCase();
    const [target] = await getDb().select().from(users).where(or(eq(users.username, identity), eq(users.email, identity))).limit(1);
    if (!target) return NextResponse.json({ error: "No user matches that username or email." }, { status: 404 });
    const [membership] = await getDb().insert(projectMembers).values({ projectId: id, userId: target.id, role: parsed.data.role }).onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { role: parsed.data.role } }).returning();
    return NextResponse.json({ membership: { id: membership.id, userId: target.id, role: membership.role } }, { status: 201 });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const { userId } = await request.json().catch(() => ({}));
    await requireProjectRole(user.id, id, "owner");
    if (!userId || userId === user.id) return NextResponse.json({ error: "An owner cannot remove themselves through this endpoint." }, { status: 400 });
    await getDb().delete(projectMembers).where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, String(userId))));
    return NextResponse.json({ ok: true });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
