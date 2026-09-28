import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, projectAuditEvents, projects } from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { publicProjectResolution, publicationState } from "@/lib/publication";

const reportSchema = z.object({ reason: z.string().trim().min(3).max(1000) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const parsed = reportSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return NextResponse.json(
        { error: "Provide a report reason between 3 and 1000 characters." },
        { status: 422 },
      );
    const { project } = await publicProjectResolution(id);
    const result = await getDb().transaction(async (tx) => {
      const [created] = await tx
        .insert(projectAuditEvents)
        .values({
          projectId: project.id,
          actorId: user.id,
          eventType: "report_submitted",
          reason: parsed.data.reason,
          metadata: JSON.stringify({ before: publicationState(project), after: { ...publicationState(project), moderationStatus: "reported" } }),
        })
        .onConflictDoNothing()
        .returning({ id: projectAuditEvents.id });
      if (created && project.moderationStatus === "active")
        await tx
          .update(projects)
          .set({ moderationStatus: "reported", updatedAt: new Date() })
          .where(eq(projects.id, project.id));
      return Boolean(created);
    });
    return NextResponse.json({ reported: true, reused: !result }, { status: result ? 201 : 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("public project report failed", error);
    return NextResponse.json({ error: "Project report could not be saved." }, { status: 500 });
  }
}
