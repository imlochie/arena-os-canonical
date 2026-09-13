import { db } from "@/db";
import { collabs, collabContributions } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { logPrivacyEvent } from "@/lib/privacy";
import { apiErrorResponse, validationError } from "@/lib/apiErrors";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [collab] = await db.select().from(collabs).where(eq(collabs.id, id)).limit(1);
    if (!collab) return validationError("SESSION_NOT_FOUND", "Requested execution was not found.", 404, "session");
    const contributions = await db
      .select()
      .from(collabContributions)
      .where(eq(collabContributions.collabId, id))
      .orderBy(asc(collabContributions.round), asc(collabContributions.contribIndex));
    return Response.json({ collab, contributions });
  } catch (e) {
    console.error(e);
    return apiErrorResponse(e, { code: "READ_FAILED", message: "Unable to load execution.", stage: "persistence" });
  }
}

// DELETE → right to erasure for a single collab + contributions
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(collabContributions).where(eq(collabContributions.collabId, id));
    await db.delete(collabs).where(eq(collabs.id, id));
    await logPrivacyEvent("delete_collab", id);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return apiErrorResponse(e, { code: "DELETE_FAILED", message: "Unable to delete execution.", stage: "persistence" });
  }
}
