import { and, asc, eq } from "drizzle-orm";
import { getDb, vocalAnalyses, vocalPhrases, vocalPitchFrames } from "@waveyard/database";

/** Database-backed isolated-vocal observations; callers do not parse engine output. */
export async function getVocalAnalysis(projectId: string, stemAssetId: string) {
  const db = getDb();
  const [analysis] = await db.select().from(vocalAnalyses).where(and(
    eq(vocalAnalyses.projectId, projectId),
    eq(vocalAnalyses.stemAssetId, stemAssetId),
  )).limit(1);
  if (!analysis) return { analysis: null, frames: [], phrases: [] };
  const [frames, phrases] = await Promise.all([
    db.select().from(vocalPitchFrames).where(eq(vocalPitchFrames.vocalAnalysisId, analysis.id)).orderBy(asc(vocalPitchFrames.frameIndex)),
    db.select().from(vocalPhrases).where(eq(vocalPhrases.vocalAnalysisId, analysis.id)).orderBy(asc(vocalPhrases.phraseIndex)),
  ]);
  return { analysis, frames, phrases };
}
