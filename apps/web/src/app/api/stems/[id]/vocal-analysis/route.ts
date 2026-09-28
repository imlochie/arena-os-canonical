import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, sourceAssets, stemAssets, vocalAnalyses, vocalPhrases, vocalPitchFrames } from "@waveyard/database";
import { enqueueVocalAnalysis } from "@waveyard/queue";
import {
  vocalAnalysisProvenanceReason,
  VOCAL_ANALYSIS_ENGINE,
  VOCAL_ANALYSIS_ENGINE_VERSION,
} from "@waveyard/types";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

function idempotencyKey(stemAssetId: string) {
  return `vocal:${stemAssetId}:${VOCAL_ANALYSIS_ENGINE}:${VOCAL_ANALYSIS_ENGINE_VERSION}`;
}

async function authorizedVocalStem(id: string, userId: string, role: "viewer" | "editor") {
  const db = getDb();
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
    const target = await authorizedVocalStem(id, user.id, "viewer");
    if (!target) return NextResponse.json({ error: "Isolated vocal stem not found." }, { status: 404 });
    const db = getDb();
    const [analysis] = await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.stemAssetId, target.stem.id)).limit(1);
    const [frames, phrases] = analysis ? await Promise.all([
      db.select().from(vocalPitchFrames).where(eq(vocalPitchFrames.vocalAnalysisId, analysis.id)).orderBy(vocalPitchFrames.frameIndex),
      db.select().from(vocalPhrases).where(eq(vocalPhrases.vocalAnalysisId, analysis.id)).orderBy(vocalPhrases.phraseIndex),
    ]) : [[], []];
    return NextResponse.json({ analysis: analysis ?? null, frames, phrases });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const target = await authorizedVocalStem(id, user.id, "editor");
    if (!target) return NextResponse.json({ error: "Isolated vocal stem not found." }, { status: 404 });
    const { stem, source } = target; const db = getDb();
    const [created] = await db.insert(vocalAnalyses).values({
      projectId: stem.projectId, sourceAssetId: source.id, stemAssetId: stem.id,
      status: "queued", stage: "queued", idempotencyKey: idempotencyKey(stem.id),
      analysisEngine: VOCAL_ANALYSIS_ENGINE, analysisEngineVersion: VOCAL_ANALYSIS_ENGINE_VERSION,
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
    });
    if (reason) return NextResponse.json({ error: "Existing vocal analysis provenance is stale; stem separation is required." }, { status: 409 });
    if (created || analysis.status === "failed") {
      if (!created) await db.update(vocalAnalyses).set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() }).where(eq(vocalAnalyses.id, analysis.id));
      try {
        await enqueueVocalAnalysis({ vocalAnalysisId: analysis.id, projectId: analysis.projectId, sourceAssetId: analysis.sourceAssetId, stemAssetId: analysis.stemAssetId, analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion });
      } catch (error) {
        await db.update(vocalAnalyses).set({
          status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable",
          errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date(), updatedAt: new Date(),
        }).where(eq(vocalAnalyses.id, analysis.id));
        throw error;
      }
    }
    return NextResponse.json({ analysis }, { status: created ? 201 : 200 });
  } catch (error) { if (error instanceof Response) return error; console.error("vocal analysis request failed", error); return NextResponse.json({ error: "Could not queue vocal analysis." }, { status: 503 }); }
}
