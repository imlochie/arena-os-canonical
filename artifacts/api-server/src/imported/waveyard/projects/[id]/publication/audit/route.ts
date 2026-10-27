import { isUuid } from "@workspace/arena/lib/api/ids";

import { desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  projectAuditEvents,
} from "@workspace/db/waveyardSchema";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, id, "editor");
    const events = await db
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
    return Response.json({
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
