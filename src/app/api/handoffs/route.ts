import { apiErrorResponse, validationError } from "@/lib/apiErrors";
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/db";
import { artifacts, cognitiveSessionInputs, cognitiveSessions, handoffs } from "@/db/schema";
import { desc, eq, or } from "drizzle-orm";
import { appendSessionEvent } from "@/lib/sessionEvents";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30) || 30, 1), 100);
    const rows = sessionId
      ? await db.select().from(handoffs).where(or(
          eq(handoffs.sourceSessionId, sessionId),
          eq(handoffs.targetSessionId, sessionId)
        )).orderBy(desc(handoffs.createdAt)).limit(limit)
      : await db.select().from(handoffs).orderBy(desc(handoffs.createdAt)).limit(limit);
    return Response.json({ handoffs: rows.map(publicHandoff) });
  } catch (error) {
    console.error("handoff list error", error);
    return apiErrorResponse(error, { code: "HANDOFF_LIST_FAILED", message: "Unable to load handoffs.", stage: "persistence" });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const targetMode = String(body.targetMode ?? "");
    if (!(["council", "arena", "collab"] as const).includes(targetMode as "council" | "arena" | "collab")) {
      return validationError("INVALID_HANDOFF_TARGET", "Target mode must be council, arena, or collab.", 400, "input");
    }
    const content = String(body.context?.content ?? "").trim();
    if (!content) return validationError("HANDOFF_CONTEXT_REQUIRED", "Explicit inherited context is required.", 400, "input");
    if (content.length > 8000) return validationError("HANDOFF_CONTEXT_TOO_LONG", "Inherited context must be 8,000 characters or fewer.", 400, "input");

    const sourceSessionId = body.sourceSessionId ? String(body.sourceSessionId) : null;
    const sourceArtifactId = body.sourceArtifactId ? String(body.sourceArtifactId) : null;
    let sourceProjectId = body.sourceProjectId ? String(body.sourceProjectId) : null;
    if (sourceSessionId) {
      const [source] = await db.select().from(cognitiveSessions).where(eq(cognitiveSessions.id, sourceSessionId)).limit(1);
      if (!source) return validationError("HANDOFF_SOURCE_NOT_FOUND", "Source session not found.", 404, "session");
      sourceProjectId = sourceProjectId ?? source.projectId;
    }
    if (sourceArtifactId) {
      const [artifact] = await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, sourceArtifactId)).limit(1);
      if (!artifact) return validationError("HANDOFF_ARTIFACT_NOT_FOUND", "Source artifact not found.", 404, "session");
    }
    if (!sourceSessionId && !sourceArtifactId && !sourceProjectId && !body.sourceRef) {
      return validationError("HANDOFF_SOURCE_REQUIRED", "A source session, artifact, project, or legacy source reference is required.", 400, "input");
    }

    const targetProjectId = body.targetProjectId ? String(body.targetProjectId) : sourceProjectId;
    const handoffId = randomUUID();
    const targetSessionId = randomUUID();
    const inputId = randomUUID();
    const contextKind = String(body.context?.kind ?? "inherited").slice(0, 40);
    const intent = body.intent ? String(body.intent).slice(0, 500) : null;
    const metadata = boundedObject(body.metadata, 4000);
    const targetMetadata = boundedObject(body.targetMetadata, 4000);
    const digest = createHash("sha256").update(content).digest("hex");

    const result = await db.transaction(async (tx) => {
      const [targetSession] = await tx.insert(cognitiveSessions).values({
        id: targetSessionId,
        projectId: targetProjectId,
        mode: targetMode,
        intent,
        title: String(body.targetTitle ?? `Handoff to ${targetMode}`).slice(0, 180),
        status: "created",
        metadata: JSON.stringify({ ...targetMetadata, handoffId }),
      }).returning();
      const [input] = await tx.insert(cognitiveSessionInputs).values({
        id: inputId,
        sessionId: targetSessionId,
        kind: contextKind,
        content,
      }).returning();
      const [handoff] = await tx.insert(handoffs).values({
        id: handoffId,
        sourceSessionId,
        targetSessionId,
        sourceArtifactId,
        sourceProjectId,
        targetProjectId,
        type: String(body.type ?? "continue").slice(0, 80),
        intent,
        payload: JSON.stringify({
          inputId,
          inputKind: contextKind,
          contentSha256: digest,
          sourceRef: body.sourceRef ? String(body.sourceRef).slice(0, 200) : null,
        }),
        metadata: JSON.stringify(metadata),
      }).returning();
      await appendSessionEvent(tx, targetSessionId, "created", { mode: targetMode, handoffId });
      await appendSessionEvent(tx, targetSessionId, "handoff_received", {
        handoffId, sourceSessionId, sourceArtifactId,
      });
      if (sourceSessionId) {
        await appendSessionEvent(tx, sourceSessionId, "handoff_created", {
          handoffId, targetSessionId, targetMode,
        });
      }
      return { handoff, targetSession, input };
    });
    return Response.json({ ...result, handoff: publicHandoff(result.handoff) }, { status: 201 });
  } catch (error) {
    console.error("handoff create error", error);
    return apiErrorResponse(error, { code: "HANDOFF_CREATE_FAILED", message: "Unable to create handoff.", stage: "persistence" });
  }
}

function publicHandoff(row: typeof handoffs.$inferSelect) {
  return { ...row, payload: parseObject(row.payload), metadata: parseObject(row.metadata) };
}

function boundedObject(value: unknown, max: number): Record<string, unknown> {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (JSON.stringify(object).length > max) throw new Error("handoff metadata too large");
  return object;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
