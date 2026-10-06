import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  sourceEventAnalyses,
  sourceEvents,
} from "@/db/waveyardSchema";

/** Database-backed source-event access; callers never parse worker output formats. */
export async function getSourceEvents(projectId: string, sourceAssetId: string) {
  
  const [analysis] = await db.select().from(sourceEventAnalyses).where(and(
    eq(sourceEventAnalyses.projectId, projectId),
    eq(sourceEventAnalyses.sourceAssetId, sourceAssetId),
  )).limit(1);
  if (!analysis) return { analysis: null, events: [] };
  const events = await db.select().from(sourceEvents).where(and(
    eq(sourceEvents.projectId, projectId),
    eq(sourceEvents.sourceEventAnalysisId, analysis.id),
  )).orderBy(asc(sourceEvents.timestampMs));
  return { analysis, events };
}
