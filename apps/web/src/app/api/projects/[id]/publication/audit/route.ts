import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, projectAuditEvents } from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    await requireProjectRole(user.id, id, "editor");
    const events = await getDb()
      .select({
        id: projectAuditEvents.id,
        actorId: projectAuditEvents.actorId,
        eventType: projectAuditEvents.eventType,
        reason: projectAuditEvents.reason,
        metadata: projectAuditEvents.metadata,
        createdAt: projectAuditEvents.createdAt,
      })
      .from(projectAuditEvents)
      .where(eq(projectAuditEvents.projectId, id))
      .orderBy(desc(projectAuditEvents.createdAt));
    return NextResponse.json({
      events: events.map((event) => ({
        ...event,
        metadata: JSON.parse(event.metadata),
      })),
    });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
