import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  harmonyAnalyses,
  harmonyEvents,
  sourceAssets,
} from "@/db/waveyardSchema";
import { enqueueHarmonyAnalysis } from "@/lib/waveyard/queue";
import { harmonyAnalysisProvenanceReason, HARMONY_ANALYSIS_ENGINE, HARMONY_ANALYSIS_ENGINE_VERSION } from "@/lib/waveyard/types";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

function idempotencyKey(sourceAssetId: string) { return `harmony:${sourceAssetId}:${HARMONY_ANALYSIS_ENGINE}:${HARMONY_ANALYSIS_ENGINE_VERSION}`; }

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params; 
    const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, id)).limit(1);
    if (!source) return NextResponse.json({ error: "Source not found." }, { status: 404 });
    await requireProjectRole(user.id, source.projectId, "viewer");
    const [analysis] = await db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.sourceAssetId, source.id)).limit(1);
    const events = analysis ? await db.select().from(harmonyEvents).where(eq(harmonyEvents.harmonyAnalysisId, analysis.id)).orderBy(harmonyEvents.eventIndex) : [];
    return NextResponse.json({ analysis: analysis ?? null, events });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params; 
    const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, id)).limit(1);
    if (!source) return NextResponse.json({ error: "Source not found." }, { status: 404 });
    await requireProjectRole(user.id, source.projectId, "editor");
    const [created] = await db.insert(harmonyAnalyses).values({
      projectId: source.projectId, sourceAssetId: source.id, status: "queued", stage: "queued", idempotencyKey: idempotencyKey(source.id),
      analysisEngine: HARMONY_ANALYSIS_ENGINE, analysisEngineVersion: HARMONY_ANALYSIS_ENGINE_VERSION, sourceChecksumSha256: source.checksumSha256,
    }).onConflictDoNothing({ target: harmonyAnalyses.sourceAssetId }).returning();
    const analysis = created ?? (await db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.sourceAssetId, source.id)).limit(1))[0];
    if (!analysis) throw new Error("Could not resolve harmony analysis.");
    const reason = harmonyAnalysisProvenanceReason({
      sourceAssetId: analysis.sourceAssetId, expectedSourceAssetId: source.id,
      sourceChecksumSha256: analysis.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
      analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion,
    });
    if (reason) return NextResponse.json({ error: "Existing harmony analysis provenance is stale; source reanalysis is required." }, { status: 409 });
    if (created || analysis.status === "failed") {
      if (!created) await db.update(harmonyAnalyses).set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() }).where(eq(harmonyAnalyses.id, analysis.id));
      try { await enqueueHarmonyAnalysis({ harmonyAnalysisId: analysis.id, projectId: analysis.projectId, sourceAssetId: analysis.sourceAssetId, analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion }); }
      catch (error) {
        await db.update(harmonyAnalyses).set({ status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable", errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date(), updatedAt: new Date() }).where(eq(harmonyAnalyses.id, analysis.id));
        throw error;
      }
    }
    return NextResponse.json({ analysis }, { status: created ? 201 : 200 });
  } catch (error) { if (error instanceof Response) return error; console.error("harmony analysis request failed", error); return NextResponse.json({ error: "Could not queue harmony analysis." }, { status: 503 }); }
}
