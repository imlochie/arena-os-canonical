
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  harmonyAnalyses,
  harmonyEvents,
  sourceAssets,
} from "@workspace/db/waveyardSchema";
import { enqueueHarmonyAnalysis } from "@workspace/arena/lib/waveyard/queue";
import { harmonyAnalysisIdempotencyKey, harmonyAnalysisProvenanceReason, HARMONY_ANALYSIS_ENGINE, HARMONY_ANALYSIS_ENGINE_VERSION, LOCAL_HARMONY_ANALYSIS_ENGINE, LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION } from "@workspace/arena/lib/waveyard/types";
import { localWorkerActive } from "@workspace/arena/lib/waveyard/worker-local/broker";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params; 
    const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, id)).limit(1);
    if (!source) return Response.json({ error: "Source not found." }, { status: 404 });
    await requireProjectRole(user.id, source.projectId, "viewer");
    const [analysis] = await db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.sourceAssetId, source.id)).limit(1);
    const events = analysis ? await db.select().from(harmonyEvents).where(eq(harmonyEvents.harmonyAnalysisId, analysis.id)).orderBy(harmonyEvents.eventIndex) : [];
    return Response.json({ analysis: analysis ?? null, events });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params; 
    const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, id)).limit(1);
    if (!source) return Response.json({ error: "Source not found." }, { status: 404 });
    await requireProjectRole(user.id, source.projectId, "editor");
    const engine = localWorkerActive() ? LOCAL_HARMONY_ANALYSIS_ENGINE : HARMONY_ANALYSIS_ENGINE;
    const engineVersion = localWorkerActive() ? LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION : HARMONY_ANALYSIS_ENGINE_VERSION;
    const [created] = await db.insert(harmonyAnalyses).values({
      projectId: source.projectId, sourceAssetId: source.id, status: "queued", stage: "queued", idempotencyKey: harmonyAnalysisIdempotencyKey(source.id, engine, engineVersion),
      analysisEngine: engine, analysisEngineVersion: engineVersion, sourceChecksumSha256: source.checksumSha256,
    }).onConflictDoNothing({ target: harmonyAnalyses.sourceAssetId }).returning();
    const analysis = created ?? (await db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.sourceAssetId, source.id)).limit(1))[0];
    if (!analysis) throw new Error("Could not resolve harmony analysis.");
    const reason = harmonyAnalysisProvenanceReason({
      sourceAssetId: analysis.sourceAssetId, expectedSourceAssetId: source.id,
      sourceChecksumSha256: analysis.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
      analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion,
    }, { engine, version: engineVersion });
    if (reason) return Response.json({ error: "Existing harmony analysis provenance is stale; source reanalysis is required." }, { status: 409 });
    let shouldQueue = Boolean(created);
    if (!created && analysis.status === "failed") {
      const [queued] = await db.update(harmonyAnalyses).set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() })
        .where(and(eq(harmonyAnalyses.id, analysis.id), eq(harmonyAnalyses.status, "failed"), eq(harmonyAnalyses.sourceChecksumSha256, source.checksumSha256))).returning({ id: harmonyAnalyses.id });
      shouldQueue = Boolean(queued);
    }
    if (shouldQueue) {
      try { await enqueueHarmonyAnalysis({ harmonyAnalysisId: analysis.id, projectId: analysis.projectId, sourceAssetId: analysis.sourceAssetId, analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion }); }
      catch (error) {
        await db.update(harmonyAnalyses).set({ status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable", errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(harmonyAnalyses.id, analysis.id), eq(harmonyAnalyses.status, "queued"), eq(harmonyAnalyses.stage, "queued"), eq(harmonyAnalyses.sourceChecksumSha256, source.checksumSha256)));
        throw error;
      }
    }
    const [current] = await db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.id, analysis.id)).limit(1);
    return Response.json({ analysis: current ?? analysis }, { status: created ? 201 : 200 });
  } catch (error) { if (error instanceof Response) return error; console.error("harmony analysis request failed", error); return Response.json({ error: "Could not queue harmony analysis." }, { status: 503 }); }
}
