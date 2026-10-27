import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  drumAnalyses,
  drumEvents,
} from "@/db/waveyardSchema";

/** Auth-scoped callers get one isolated-stem rhythmic evidence document. */
export async function getDrumAnalysis(projectId: string, stemAssetId: string) {
  
  const [analysis] = await db.select().from(drumAnalyses).where(and(
    eq(drumAnalyses.projectId, projectId), eq(drumAnalyses.stemAssetId, stemAssetId),
  )).limit(1);
  if (!analysis) return { analysis: null, events: [] };
  const events = await db.select().from(drumEvents).where(eq(drumEvents.drumAnalysisId, analysis.id)).orderBy(asc(drumEvents.eventIndex));
  return { analysis, events };
}
