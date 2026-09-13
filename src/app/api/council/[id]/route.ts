import { db } from "@/db";
import { councilArtifacts, councilRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import { logPrivacyEvent } from "@/lib/privacy";
import { parseCouncilSynthesis } from "@/lib/councilSynthesis";
import { apiErrorResponse, validationError } from "@/lib/apiErrors";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [run] = await db.select().from(councilRuns).where(eq(councilRuns.id, id)).limit(1);
    if (!run) return validationError("SESSION_NOT_FOUND", "Requested execution was not found.", 404, "session");
    const artifacts = await db.select().from(councilArtifacts).where(eq(councilArtifacts.runId, id));
    return Response.json({
      run: {
        ...run,
        synthesisData: run.structuredSynthesis ? parseCouncilSynthesis(run.structuredSynthesis) : null,
      },
      artifacts,
    });
  } catch (e) {
    console.error(e);
    return apiErrorResponse(e, { code: "READ_FAILED", message: "Unable to load execution.", stage: "persistence" });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(councilArtifacts).where(eq(councilArtifacts.runId, id));
    await db.delete(councilRuns).where(eq(councilRuns.id, id));
    await logPrivacyEvent("delete_council", id);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return apiErrorResponse(e, { code: "DELETE_FAILED", message: "Unable to delete execution.", stage: "persistence" });
  }
}
