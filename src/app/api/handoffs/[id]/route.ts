import { apiErrorResponse, validationError } from "@/lib/apiErrors";
import { db } from "@/db";
import { cognitiveSessionInputs, cognitiveSessions, handoffs } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [handoff] = await db.select().from(handoffs).where(eq(handoffs.id, id)).limit(1);
    if (!handoff) return validationError("HANDOFF_NOT_FOUND", "Handoff not found.", 404, "session");
    const [[targetSession], inputs, sourceRows] = await Promise.all([
      db.select().from(cognitiveSessions).where(eq(cognitiveSessions.id, handoff.targetSessionId)).limit(1),
      db.select().from(cognitiveSessionInputs).where(eq(cognitiveSessionInputs.sessionId, handoff.targetSessionId)),
      handoff.sourceSessionId
        ? db.select().from(cognitiveSessions).where(eq(cognitiveSessions.id, handoff.sourceSessionId)).limit(1)
        : Promise.resolve([]),
    ]);
    return Response.json({
      handoff: { ...handoff, payload: parseObject(handoff.payload), metadata: parseObject(handoff.metadata) },
      sourceSession: sourceRows[0] ?? null,
      targetSession: targetSession ?? null,
      inputs,
    });
  } catch (error) {
    console.error("handoff detail error", error);
    return apiErrorResponse(error, { code: "HANDOFF_READ_FAILED", message: "Unable to load handoff.", stage: "persistence" });
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
