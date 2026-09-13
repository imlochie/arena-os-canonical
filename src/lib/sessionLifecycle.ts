import { db } from "@/db";
import { cognitiveSessions } from "@/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { appendSessionEvent } from "./sessionEvents";

export const SESSION_STATUSES = ["created", "running", "completed", "failed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type SessionMode = "council" | "arena" | "collab";
export const TERMINAL_SESSION_STATES: readonly SessionStatus[] = ["completed", "failed"];

const PREVIOUS_STATES: Record<SessionStatus, SessionStatus[]> = {
  created: [],
  running: ["created"],
  completed: ["running"],
  failed: ["created", "running"],
};

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && SESSION_STATUSES.includes(value as SessionStatus);
}

export interface SessionTransitionOptions {
  payload?: Record<string, string | number | boolean | null>;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export type ArenaTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Apply a generic status transition inside an existing application transaction. */
export async function transitionSessionInTransaction(
  tx: ArenaTransaction,
  sessionId: string,
  state: SessionStatus,
  options: SessionTransitionOptions = {}
) {
  const now = new Date();
  const patch: Partial<typeof cognitiveSessions.$inferInsert> = { status: state, updatedAt: now };
  if (state === "running") patch.startedAt = now;
  if (state === "completed") patch.completedAt = now;
  if (state === "failed") patch.failedAt = now;
  if (options.errorCode !== undefined) patch.errorCode = options.errorCode;
  if (options.errorMessage !== undefined) patch.errorMessage = options.errorMessage;

  const allowedPrevious = PREVIOUS_STATES[state];
  if (allowedPrevious.length === 0) throw new Error(`cannot transition an existing session to ${state}`);
  const [session] = await tx.update(cognitiveSessions).set(patch).where(and(
    eq(cognitiveSessions.id, sessionId),
    inArray(cognitiveSessions.status, allowedPrevious)
  )).returning();
  if (!session) throw new Error(`invalid cognitive session transition to ${state}`);

  const event = await appendSessionEvent(tx, sessionId, state, options.payload ?? {});
  return { session, event };
}

/** Records an authoritative generic status transition atomically. */
export async function transitionSession(
  sessionId: string,
  state: SessionStatus,
  options: SessionTransitionOptions = {},
  database: Pick<typeof db, "transaction"> = db
) {
  return database.transaction((tx) => transitionSessionInTransaction(tx, sessionId, state, options));
}

/**
 * Advances a mode-owned stage while the generic session remains `running`.
 * The expected previous stage prevents a mode from skipping its own sequence.
 */
export async function advanceSessionStage(
  sessionId: string,
  stage: string,
  options: {
    expectedPreviousStage: string | null;
    payload?: Record<string, string | number | boolean | null>;
  },
  database: Pick<typeof db, "transaction"> = db
) {
  if (!stage.trim()) throw new Error("session stage is required");
  return database.transaction(async (tx) => {
    const stagePredicate = options.expectedPreviousStage === null
      ? isNull(cognitiveSessions.currentStage)
      : eq(cognitiveSessions.currentStage, options.expectedPreviousStage);
    const [session] = await tx.update(cognitiveSessions).set({
      currentStage: stage,
      updatedAt: new Date(),
    }).where(and(
      eq(cognitiveSessions.id, sessionId),
      eq(cognitiveSessions.status, "running"),
      stagePredicate
    )).returning();
    if (!session) throw new Error(`invalid session stage transition to ${stage}`);
    const event = await appendSessionEvent(tx, sessionId, "stage_started", {
      stage,
      ...(options.payload ?? {}),
    });
    return { session, event };
  });
}
