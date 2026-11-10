import { isUuid } from "@workspace/arena/lib/api/ids";

import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  drumAnalyses,
  drumEvents,
  sourceAssets,
  stemAssets,
} from "@workspace/db/waveyardSchema";
import { enqueueDrumAnalysis } from "@workspace/arena/lib/waveyard/queue";
import {
  drumAnalysisProvenanceReason,
  drumAnalysisIdempotencyKey,
  isSupportedDrumStemType,
  DRUM_ANALYSIS_ENGINE,
  DRUM_ANALYSIS_ENGINE_VERSION,
  LOCAL_DRUM_ANALYSIS_ENGINE,
  LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
} from "@workspace/arena/lib/waveyard/types";
import { localWorkerActive } from "@workspace/arena/lib/waveyard/worker-local/broker";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";

async function authorizedDrumStem(id: string, userId: string, role: "viewer" | "editor") {
  
  const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, id)).limit(1);
  if (!stem || !isSupportedDrumStemType(stem.stemType)) return null;
  await requireProjectRole(userId, stem.projectId, role);
  const [source] = await db.select().from(sourceAssets).where(and(eq(sourceAssets.id, stem.sourceAssetId), eq(sourceAssets.projectId, stem.projectId))).limit(1);
  if (!source) throw new Error("Authorized drum stem has no source asset.");
  return { stem, source };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    const target = await authorizedDrumStem(id, user.id, "viewer");
    if (!target) return Response.json({ error: "Isolated drum stem not found." }, { status: 404 });
    
    const [analysis] = await db.select().from(drumAnalyses).where(eq(drumAnalyses.stemAssetId, target.stem.id)).limit(1);
    const events = analysis ? await db.select().from(drumEvents).where(eq(drumEvents.drumAnalysisId, analysis.id)).orderBy(drumEvents.eventIndex) : [];
    return Response.json({ analysis: analysis ?? null, events });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    const target = await authorizedDrumStem(id, user.id, "editor");
    if (!target) return Response.json({ error: "Isolated drum stem not found." }, { status: 404 });
    const { stem, source } = target; 
    const engine = localWorkerActive() ? LOCAL_DRUM_ANALYSIS_ENGINE : DRUM_ANALYSIS_ENGINE;
    const engineVersion = localWorkerActive() ? LOCAL_DRUM_ANALYSIS_ENGINE_VERSION : DRUM_ANALYSIS_ENGINE_VERSION;
    const [created] = await db.insert(drumAnalyses).values({
      projectId: stem.projectId, sourceAssetId: source.id, stemAssetId: stem.id,
      status: "queued", stage: "queued", idempotencyKey: drumAnalysisIdempotencyKey(stem.id, engine, engineVersion),
      analysisEngine: engine, analysisEngineVersion: engineVersion,
      sourceChecksumSha256: source.checksumSha256, stemChecksumSha256: stem.checksumSha256,
    }).onConflictDoNothing({ target: drumAnalyses.stemAssetId }).returning();
    const analysis = created ?? (await db.select().from(drumAnalyses).where(eq(drumAnalyses.stemAssetId, stem.id)).limit(1))[0];
    if (!analysis) throw new Error("Could not resolve drum analysis.");
    const reason = drumAnalysisProvenanceReason({
      sourceAssetId: analysis.sourceAssetId, expectedSourceAssetId: source.id,
      stemAssetId: analysis.stemAssetId, expectedStemAssetId: stem.id,
      sourceChecksumSha256: analysis.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
      stemChecksumSha256: analysis.stemChecksumSha256, expectedStemChecksumSha256: stem.checksumSha256,
      analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion,
    }, { engine, version: engineVersion });
    if (reason) return Response.json({ error: "Existing drum analysis provenance is stale; stem separation is required." }, { status: 409 });
    let shouldQueue = Boolean(created);
    if (!created && analysis.status === "failed") {
      const [queued] = await db.update(drumAnalyses).set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() })
        .where(and(eq(drumAnalyses.id, analysis.id), eq(drumAnalyses.status, "failed"), eq(drumAnalyses.sourceChecksumSha256, source.checksumSha256), eq(drumAnalyses.stemChecksumSha256, stem.checksumSha256))).returning({ id: drumAnalyses.id });
      shouldQueue = Boolean(queued);
    }
    if (shouldQueue) {
      try {
        await enqueueDrumAnalysis({ drumAnalysisId: analysis.id, projectId: analysis.projectId, sourceAssetId: analysis.sourceAssetId, stemAssetId: analysis.stemAssetId, analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion });
      } catch (error) {
        await db.update(drumAnalyses).set({ status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable", errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(drumAnalyses.id, analysis.id), eq(drumAnalyses.status, "queued"), eq(drumAnalyses.stage, "queued"), eq(drumAnalyses.sourceChecksumSha256, source.checksumSha256), eq(drumAnalyses.stemChecksumSha256, stem.checksumSha256)));
        throw error;
      }
    }
    const [current] = await db.select().from(drumAnalyses).where(eq(drumAnalyses.id, analysis.id)).limit(1);
    return Response.json({ analysis: current ?? analysis }, { status: created ? 201 : 200 });
  } catch (error) { if (error instanceof Response) return error; console.error("drum analysis request failed", error); return Response.json({ error: "Could not queue drum analysis." }, { status: 503 }); }
}
