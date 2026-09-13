import { db } from "@/db";
import { cognitiveSessionEvents, cognitiveSessions } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export type SessionEventTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Atomically reserve and append the next sequence number for one session.
 *
 * PostgreSQL serializes concurrent updates of the same session row, so each
 * writer receives a distinct number without scanning the event table. Writers
 * for unrelated sessions remain independent. Callers provide their existing
 * transaction so state mutation and its event commit together.
 */
export async function appendSessionEvent(
  tx: SessionEventTransaction,
  sessionId: string,
  type: string,
  payload: Record<string, unknown> = {}
) {
  const [reservation] = await tx.update(cognitiveSessions).set({
    nextEventSequence: sql`${cognitiveSessions.nextEventSequence} + 1`,
  }).where(eq(cognitiveSessions.id, sessionId)).returning({
    sequence: sql<number>`${cognitiveSessions.nextEventSequence} - 1`,
  });
  if (!reservation) throw new Error("cannot append event to missing cognitive session");

  const [event] = await tx.insert(cognitiveSessionEvents).values({
    sessionId,
    type,
    sequence: reservation.sequence,
    payload: JSON.stringify(payload),
  }).returning();
  return event;
}
