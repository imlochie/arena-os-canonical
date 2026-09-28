import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, projectAuditEvents, projects } from "@waveyard/database";
import { publicationState, requireModerator } from "@/lib/publication";

const actionSchema = z.object({
  action: z.enum(["hide", "restore", "remove"]),
  reason: z.string().trim().min(3).max(1000),
});

const TARGET_STATUS = { hide: "hidden", restore: "active", remove: "removed" } as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const moderator = await requireModerator();
    const { id } = await params;
    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return NextResponse.json(
        { error: "Choose hide, restore, or remove and provide a reason.", code: "invalid_moderation_action" },
        { status: 422 },
      );
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const { action, reason } = parsed.data;
    if (action === "hide" && !["active", "reported"].includes(project.moderationStatus))
      return NextResponse.json({ error: "Only active or reported projects can be hidden." }, { status: 409 });
    if (action === "restore" && !["hidden", "reported"].includes(project.moderationStatus))
      return NextResponse.json({ error: "Only hidden or reported projects can be restored." }, { status: 409 });
    if (action === "remove" && project.moderationStatus === "removed")
      return NextResponse.json({ error: "Project is already removed." }, { status: 409 });
    const before = publicationState(project);
    const nextStatus = TARGET_STATUS[action];
    const [updated] = await db.transaction(async (tx) => {
      const [next] = await tx
        .update(projects)
        .set({ moderationStatus: nextStatus, updatedAt: new Date() })
        .where(eq(projects.id, project.id))
        .returning();
      await tx.insert(projectAuditEvents).values({
        projectId: project.id,
        actorId: moderator.id,
        eventType: action === "hide" ? "hidden" : action === "restore" ? "restored" : "removed",
        reason,
        metadata: JSON.stringify({ before, after: publicationState(next) }),
      });
      return [next];
    });
    return NextResponse.json({
      project: {
        id: updated.id,
        moderationStatus: updated.moderationStatus,
        publicationStatus: updated.publicationStatus,
        visibility: updated.visibility,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("moderation action failed", error);
    return NextResponse.json({ error: "Moderation action could not be saved." }, { status: 500 });
  }
}
