import { isUuid } from "@workspace/arena/lib/api/ids";

import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  sourceAssets,
  stemAssets,
  vocalAnalyses,
  vocalPhrases,
  vocalPitchFrames,
} from "@workspace/db/waveyardSchema";
import { enqueueVocalAnalysis } from "@workspace/arena/lib/waveyard/queue";
import {
  vocalAnalysisIdempotencyKey,
  vocalAnalysisProvenanceReason,
  VOCAL_ANALYSIS_ENGINE,
  VOCAL_ANALYSIS_ENGINE_VERSION,
  LOCAL_VOCAL_ANALYSIS_ENGINE,
  LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
} from "@workspace/arena/lib/waveyard/types";
import { localWorkerActive } from "@workspace/arena/lib/waveyard/worker-local/broker";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";

async function authorizedVocalStem(id: string, userId: string, role: "viewer" | "editor") {
  
  const [stem] = await db.select().from(stemAssets).where(and(eq(stemAssets.id, id), eq(stemAssets.stemType, "vocals"))).limit(1);
  if (!stem) return null;
  await requireProjectRole(userId, stem.projectId, role);
  const [source] = await db.select().from(sourceAssets).where(and(
    eq(sourceAssets.id, stem.sourceAssetId), eq(sourceAssets.projectId, stem.projectId),
  )).limit(1);
  if (!source) throw new Error("Authorized vocal stem has no source asset.");
  return { stem, source };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    const target = await authorizedVocalStem(id, user.id, "viewer");
    if (!target) return Response.json({ error: "Isolated vocal stem not found." }, { status: 404 });
    
    const [analysis] = await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.stemAssetId, target.stem.id)).limit(1);
    const [frames, phrases] = analysis ? await Promise.all([
      db.select().from(vocalPitchFrames).where(eq(vocalPitchFrames.vocalAnalysisId, analysis.id)).orderBy(vocalPitchFrames.frameIndex),
      db.select().from(vocalPhrases).where(eq(vocalPhrases.vocalAnalysisId, analysis.id)).orderBy(vocalPhrases.phraseIndex),
    ]) : [[], []];
    return Response.json({ analysis: analysis ?? null, frames, phrases });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    const target = await authorizedVocalStem(id, user.id, "editor");
    if (!target) return Response.json({ error: "Isolated vocal stem not found." }, { status: 404 });
    const { stem, source } = target; 
    const engine = localWorkerActive() ? LOCAL_VOCAL_ANALYSIS_ENGINE : VOCAL_ANALYSIS_ENGINE;
    const engineVersion = localWorkerActive() ? LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION : VOCAL_ANALYSIS_ENGINE_VERSION;
    const [created] = await db.insert(vocalAnalyses).values({
      projectId: stem.projectId, sourceAssetId: source.id, stemAssetId: stem.id,
      status: "queued", stage: "queued", idempotencyKey: vocalAnalysisIdempotencyKey(stem.id, engine, engineVersion),
      analysisEngine: engine, analysisEngineVersion: engineVersion,
      sourceChecksumSha256: source.checksumSha256, stemChecksumSha256: stem.checksumSha256,
    }).onConflictDoNothing({ target: vocalAnalyses.stemAssetId }).returning();
    const analysis = created ?? (await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.stemAssetId, stem.id)).limit(1))[0];
    if (!analysis) throw new Error("Could not resolve vocal analysis.");
    const reason = vocalAnalysisProvenanceReason({
      sourceAssetId: analysis.sourceAssetId, expectedSourceAssetId: source.id,
      stemAssetId: analysis.stemAssetId, expectedStemAssetId: stem.id,
      sourceChecksumSha256: analysis.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
      stemChecksumSha256: analysis.stemChecksumSha256, expectedStemChecksumSha256: stem.checksumSha256,
      analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion,
    }, { engine, version: engineVersion });
    if (reason) return Response.json({ error: "Existing vocal analysis provenance is stale; stem separation is required." }, { status: 409 });
    let shouldQueue = Boolean(created);
    if (!created && analysis.status === "failed") {
      const [queued] = await db.update(vocalAnalyses).set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() })
        .where(and(eq(vocalAnalyses.id, analysis.id), eq(vocalAnalyses.status, "failed"), eq(vocalAnalyses.sourceChecksumSha256, source.checksumSha256), eq(vocalAnalyses.stemChecksumSha256, stem.checksumSha256))).returning({ id: vocalAnalyses.id });
      shouldQueue = Boolean(queued);
    }
    if (shouldQueue) {
      try {
        await enqueueVocalAnalysis({ vocalAnalysisId: analysis.id, projectId: analysis.projectId, sourceAssetId: analysis.sourceAssetId, stemAssetId: analysis.stemAssetId, analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion });
      } catch (error) {
        await db.update(vocalAnalyses).set({
          status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable",
          errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(vocalAnalyses.id, analysis.id), eq(vocalAnalyses.status, "queued"), eq(vocalAnalyses.stage, "queued"), eq(vocalAnalyses.sourceChecksumSha256, source.checksumSha256), eq(vocalAnalyses.stemChecksumSha256, stem.checksumSha256)));
        throw error;
      }
    }
    const [current] = await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.id, analysis.id)).limit(1);
    return Response.json({ analysis: current ?? analysis }, { status: created ? 201 : 200 });
  } catch (error) { if (error instanceof Response) return error; console.error("vocal analysis request failed", error); return Response.json({ error: "Could not queue vocal analysis." }, { status: 503 }); }
}
