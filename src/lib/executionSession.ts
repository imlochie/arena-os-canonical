import { db } from "@/db";
import { cognitiveSessionInputs, cognitiveSessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { transitionSession } from "./sessionLifecycle";
import type { SessionMode } from "./sessionLifecycle";
import { appendSessionEvent } from "./sessionEvents";
import type { ExecutionMode } from "./executionPolicy";
import { runtimeError } from "./errors";

export async function prepareExecutionSession(input: {
  sessionId?: string;
  mode: SessionMode;
  executionMode?: ExecutionMode;
  projectId: string | null;
  title: string;
  intent?: string;
  content: string;
  metadata?: Record<string, unknown>;
}, database: typeof db = db) {
  let sessionId = input.sessionId;
  if (sessionId) {
    const [session] = await database.select().from(cognitiveSessions).where(eq(cognitiveSessions.id, sessionId)).limit(1);
    if (!session || session.mode !== input.mode) throw runtimeError({
      code: "SESSION_NOT_FOUND",
      message: `${input.mode} session not found.`,
      stage: "session",
      sessionId,
    });
    if (session.status !== "created") throw runtimeError({
      code: "INVALID_SESSION_STATE",
      message: `${input.mode} session has already started.`,
      stage: "session",
      sessionId,
    });
    await database.update(cognitiveSessions).set({
      projectId: input.projectId ?? session.projectId,
      executionMode: input.executionMode ?? session.executionMode,
      title: input.title,
      intent: input.intent ?? session.intent,
      metadata: JSON.stringify({ ...safelyParseMetadata(session.metadata), ...(input.metadata ?? {}) }),
      updatedAt: new Date(),
    }).where(eq(cognitiveSessions.id, sessionId));
  } else {
    const result = await database.transaction(async (tx) => {
      const [session] = await tx.insert(cognitiveSessions).values({
        mode: input.mode,
        executionMode: input.executionMode ?? "online",
        projectId: input.projectId,
        title: input.title,
        intent: input.intent,
        metadata: JSON.stringify(input.metadata ?? {}),
        status: "created",
      }).returning();
      await tx.insert(cognitiveSessionInputs).values({ sessionId: session.id, kind: "primary", content: input.content });
      await appendSessionEvent(tx, session.id, "created", { mode: input.mode });
      return session;
    });
    sessionId = result.id;
  }
  await transitionSession(sessionId, "running", { payload: { mode: input.mode } }, database);
  return sessionId;
}

function safelyParseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
