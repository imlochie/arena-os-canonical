/**
 * Review workflow — decisions recorded, never auto-executed.
 *
 * Approve/reject/reopen write state + a decision marker on the review item
 * (the human said so). Arena does not rename, move, delete or download
 * anything here — that class of operation keeps its own guardrails when it
 * arrives.
 */

import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { archiveObservations, archiveReviewItems } from "@/db/schema";

export type ReviewDecision = "approve" | "reject" | "reopen";

export type ReviewItemView = {
  id: number;
  subjectKey: string;
  title: string;
  kind: string;
  state: string;
  classification: string | null;
  providerKind: string | null;
  summary: string;
  evidence: string[];
  decision: string | null;
  decidedAt: string | null;
  updatedAt: string;
  currentObservationId: number | null;
  previousObservationId: number | null;
};

function payloadSummary(payload: unknown): string {
  if (payload && typeof payload === "object" && "summary" in payload) {
    const value = (payload as { summary?: unknown }).summary;
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function evidenceList(evidence: unknown): string[] {
  return Array.isArray(evidence) ? evidence.filter((e): e is string => typeof e === "string") : [];
}

export async function listReviewItems(limit = 200): Promise<ReviewItemView[]> {
  const rows = await db.select().from(archiveReviewItems).orderBy(desc(archiveReviewItems.updatedAt)).limit(limit);
  const views: ReviewItemView[] = [];
  for (const row of rows) {
    const observations = await db
      .select()
      .from(archiveObservations)
      .where(eq(archiveObservations.reviewItemId, row.id))
      .orderBy(desc(archiveObservations.observedAt))
      .limit(2);
    views.push({
      id: row.id,
      subjectKey: row.subjectKey,
      title: row.title,
      kind: row.kind,
      state: row.state,
      classification: row.classification,
      providerKind: row.providerKind,
      summary: payloadSummary(row.payload) || row.title,
      evidence: evidenceList(row.evidence),
      decision: row.decision,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
      currentObservationId: observations[0]?.id ?? null,
      previousObservationId: observations[1]?.id ?? null,
    });
  }
  return views;
}

export async function decideReviewItem(id: number, decision: ReviewDecision): Promise<ReviewItemView | null> {
  const rows = await db.select().from(archiveReviewItems).where(eq(archiveReviewItems.id, id)).limit(1);
  if (!rows.length) return null;
  const now = new Date();
  const state =
    decision === "approve" ? "completed" : decision === "reject" ? "dismissed" : "needs_you";
  await db
    .update(archiveReviewItems)
    .set({
      state,
      decision: decision === "approve" ? "approved" : decision === "reject" ? "rejected" : null,
      decidedAt: decision === "reopen" ? null : now,
      updatedAt: now,
    })
    .where(eq(archiveReviewItems.id, id));
  const all = await listReviewItems(500);
  return all.find((v) => v.id === id) ?? null;
}

/** Test-only: clear the review tables for suite isolation. */
export async function clearReviewTablesForTests(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("test helper refused in production");
  await db.delete(archiveObservations);
  await db.delete(archiveReviewItems);
}
