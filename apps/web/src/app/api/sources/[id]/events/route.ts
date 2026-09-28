import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, sourceAssets, sourceEventAnalyses, sourceEvents } from "@waveyard/database";
import { enqueueSourceEventAnalysis } from "@waveyard/queue";
import { SOURCE_EVENT_ANALYSIS_ENGINE, SOURCE_EVENT_ANALYSIS_ENGINE_VERSION } from "@waveyard/types";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

function idempotencyKey(sourceAssetId: string) {
  return `events:${sourceAssetId}:${SOURCE_EVENT_ANALYSIS_ENGINE}:${SOURCE_EVENT_ANALYSIS_ENGINE_VERSION}`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, id)).limit(1);
    if (!source) return NextResponse.json({ error: "Source not found." }, { status: 404 });
    await requireProjectRole(user.id, source.projectId, "viewer");
    const [analysis] = await db.select().from(sourceEventAnalyses).where(eq(sourceEventAnalyses.sourceAssetId, source.id)).limit(1);
    const events = analysis ? await db.select().from(sourceEvents).where(eq(sourceEvents.sourceEventAnalysisId, analysis.id)) : [];
    return NextResponse.json({ analysis: analysis ?? null, events: events.sort((left, right) => left.timestampMs - right.timestampMs) });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, id)).limit(1);
    if (!source) return NextResponse.json({ error: "Source not found." }, { status: 404 });
    await requireProjectRole(user.id, source.projectId, "editor");
    const [created] = await db.insert(sourceEventAnalyses).values({
      projectId: source.projectId,
      sourceAssetId: source.id,
      status: "queued",
      stage: "queued",
      idempotencyKey: idempotencyKey(source.id),
      analysisEngine: SOURCE_EVENT_ANALYSIS_ENGINE,
      analysisEngineVersion: SOURCE_EVENT_ANALYSIS_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256,
    }).onConflictDoNothing({ target: sourceEventAnalyses.sourceAssetId }).returning();
    const analysis = created ?? (await db.select().from(sourceEventAnalyses).where(eq(sourceEventAnalyses.sourceAssetId, source.id)).limit(1))[0];
    if (!analysis) throw new Error("Could not resolve source event analysis.");
    if (analysis.sourceChecksumSha256 !== source.checksumSha256
      || analysis.analysisEngine !== SOURCE_EVENT_ANALYSIS_ENGINE
      || analysis.analysisEngineVersion !== SOURCE_EVENT_ANALYSIS_ENGINE_VERSION)
      return NextResponse.json({ error: "Existing event analysis provenance is stale; source reanalysis is required." }, { status: 409 });
    if (created || analysis.status === "failed") {
      if (!created) await db.update(sourceEventAnalyses).set({ status: "queued", stage: "queued", errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date() }).where(eq(sourceEventAnalyses.id, analysis.id));
      await enqueueSourceEventAnalysis({
        sourceEventAnalysisId: analysis.id,
        projectId: analysis.projectId,
        sourceAssetId: analysis.sourceAssetId,
        analysisEngine: analysis.analysisEngine,
        analysisEngineVersion: analysis.analysisEngineVersion,
      });
    }
    return NextResponse.json({ analysis }, { status: created ? 201 : 200 });
  } catch (error) { if (error instanceof Response) return error; console.error("event analysis request failed", error); return NextResponse.json({ error: "Could not queue event analysis." }, { status: 503 }); }
}
