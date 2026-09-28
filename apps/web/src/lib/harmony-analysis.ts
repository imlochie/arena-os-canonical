import { and, asc, eq } from "drizzle-orm";
import { getDb, harmonyAnalyses, harmonyEvents } from "@waveyard/database";

/** Database-backed source harmonic evidence; no consumer parses engine JSON. */
export async function getHarmonyAnalysis(projectId: string, sourceAssetId: string) {
  const db = getDb();
  const [analysis] = await db.select().from(harmonyAnalyses).where(and(
    eq(harmonyAnalyses.projectId, projectId), eq(harmonyAnalyses.sourceAssetId, sourceAssetId),
  )).limit(1);
  if (!analysis) return { analysis: null, events: [] };
  const events = await db.select().from(harmonyEvents).where(eq(harmonyEvents.harmonyAnalysisId, analysis.id)).orderBy(asc(harmonyEvents.eventIndex));
  return { analysis, events };
}
