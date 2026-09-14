import { db } from "@/db";
import { cognitiveSessionInputs, cognitiveSessions } from "@/db/schema";
import { getCognitiveJob } from "@/lib/cognitiveJobs";
import { appendSessionEvent } from "@/lib/sessionEvents";
import { parseExecutionConfig } from "@/lib/executionConfig";
import { apiErrorResponse, validationError } from "@/lib/apiErrors";
import { desc, eq, inArray } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30) || 30, 1), 100);
  const projectId = url.searchParams.get("projectId");

  try {
    const base = db.select().from(cognitiveSessions);
    const rows = projectId
      ? await base.where(eq(cognitiveSessions.projectId, projectId)).orderBy(desc(cognitiveSessions.createdAt)).limit(limit)
      : await base.orderBy(desc(cognitiveSessions.createdAt)).limit(limit);
    const inputs = rows.length
      ? await db.select().from(cognitiveSessionInputs).where(inArray(cognitiveSessionInputs.sessionId, rows.map((row) => row.id)))
      : [];
    return Response.json({
      sessions: rows.map((session) => ({
        ...session,
        metadata: safelyParseMetadata(session.metadata),
        primaryInput: inputs.find((input) => input.sessionId === session.id && input.kind === "primary") ?? null,
      })),
    });
  } catch (error) {
    console.error("cognitive sessions GET error", error);
    return apiErrorResponse(error, { code: "SESSION_LIST_FAILED", message: "Unable to load cognitive sessions.", stage: "persistence" });
  }
}

// Create the durable session before execution. Council remains synchronous in
// this slice, but this ID lets a second request observe authoritative progress.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const mode = String(body.mode ?? "council");
    if (!(["council", "arena", "collab"] as const).includes(mode as "council" | "arena" | "collab")) {
      return validationError("UNSUPPORTED_SESSION_MODE", "Session mode must be council, arena, or collab.");
    }
    const legacyMaterial = String(body.material ?? "").trim();
    const inputBody = body.input && typeof body.input === "object" ? body.input : null;
    const content = String(inputBody?.content ?? legacyMaterial).trim();
    if (!content) return validationError("SESSION_INPUT_REQUIRED", "Session input is required.");
    if (content.length > 8000) return validationError("SESSION_INPUT_TOO_LONG", "Session input must be 8,000 characters or fewer.");

    const executionConfig = parseExecutionConfig(body);
    const executionMode = executionConfig.mode;
    const fallbackPolicy = executionConfig.fallbackPolicy;
    const maxExecutionAttempts = executionConfig.maxExecutionAttempts;
    const jobId = String(body.jobId ?? body.metadata?.jobId ?? "second_brain");
    const job = mode === "council" ? getCognitiveJob(jobId) : null;
    const metadata = {
      ...(body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : {}),
      ...(job ? { jobId: job.id } : {}),
    };
    const encodedMetadata = JSON.stringify(metadata);
    if (encodedMetadata.length > 4000) return validationError("SESSION_METADATA_TOO_LONG", "Session metadata is too large.");

    const result = await db.transaction(async (tx) => {
      const [session] = await tx.insert(cognitiveSessions).values({
        projectId: body.projectId ? String(body.projectId) : null,
        mode,
        executionMode,
        maxExecutionAttempts,
        fallbackPolicy,
        intent: body.intent ? String(body.intent).slice(0, 160) : null,
        title: String(body.title ?? (job ? `${job.emoji} ${job.name}` : `Untitled ${mode} session`)).slice(0, 180),
        metadata: encodedMetadata,
        status: "created",
      }).returning();
      const [input] = await tx.insert(cognitiveSessionInputs).values({
        sessionId: session.id,
        kind: String(inputBody?.kind ?? "primary").slice(0, 40),
        content,
      }).returning();
      const event = await appendSessionEvent(tx, session.id, "created", {
        mode, intent: session.intent,
      });
      return { session, inputs: [input], event };
    });

    return Response.json(result, { status: 201 });
  } catch (error) {
    console.error("cognitive session POST error", error);
    return apiErrorResponse(error, { code: "SESSION_CREATE_FAILED", message: "Unable to create cognitive session.", stage: "persistence" });
  }
}

function safelyParseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
