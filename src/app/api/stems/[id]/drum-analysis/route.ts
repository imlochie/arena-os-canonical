import { isUuid } from "@/lib/api/ids";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  drumAnalyses,
  drumEvents,
  sourceAssets,
  stemAssets,
} from "@/db/waveyardSchema";
import { enqueueDrumAnalysis } from "@/lib/waveyard/queue";
import {
  drumAnalysisProvenanceReason,
  isSupportedDrumStemType,
  DRUM_ANALYSIS_ENGINE,
  DRUM_ANALYSIS_ENGINE_VERSION,
} from "@/lib/waveyard/types";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

function idempotencyKey(stemAssetId: string) { return `drums:${stemAssetId}:${DRUM_ANALYSIS_ENGINE}:${DRUM_ANALYSIS_ENGINE_VERSION}`; }

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
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    const target = await authorizedDrumStem(id, user.id, "viewer");
    if (!target) return NextResponse.json({ error: "Isolated drum stem not found." }, { status: 404 });
    
    const [analysis] = await db.select().from(drumAnalyses).where(eq(drumAnalyses.stemAssetId, target.stem.id)).limit(1);
    const events = analysis ? await db.select().from(drumEvents).where(eq(drumEvents.drumAnalysisId, analysis.id)).orderBy(drumEvents.eventIndex) : [];
    return NextResponse.json({ analysis: analysis ?? null, events });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    const target = await authorizedDrumStem(id, user.id, "editor");
    if (!target) return NextResponse.json({ error: "Isolated drum stem not found." }, { status: 404 });
    const { stem, source } = target; 
    const [created] = await db.insert(drumAnalyses).values({
      projectId: stem.projectId, sourceAssetId: source.id, stemAssetId: stem.id,
      status: "queued", stage: "queued", idempotencyKey: idempotencyKey(stem.id),
      analysisEngine: DRUM_ANALYSIS_ENGINE, analysisEngineVersion: DRUM_ANALYSIS_ENGINE_VERSION,
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
    });
    if (reason) return NextResponse.json({ error: "Existing drum analysis provenance is stale; stem separation is required." }, { status: 409 });
    if (created || analysis.status === "failed") {
      if (!created) await db.update(drumAnalyses).set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() }).where(eq(drumAnalyses.id, analysis.id));
      try {
        await enqueueDrumAnalysis({ drumAnalysisId: analysis.id, projectId: analysis.projectId, sourceAssetId: analysis.sourceAssetId, stemAssetId: analysis.stemAssetId, analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion });
      } catch (error) {
        await db.update(drumAnalyses).set({ status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable", errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date(), updatedAt: new Date() }).where(eq(drumAnalyses.id, analysis.id));
        throw error;
      }
    }
    return NextResponse.json({ analysis }, { status: created ? 201 : 200 });
  } catch (error) { if (error instanceof Response) return error; console.error("drum analysis request failed", error); return NextResponse.json({ error: "Could not queue drum analysis." }, { status: 503 }); }
}
