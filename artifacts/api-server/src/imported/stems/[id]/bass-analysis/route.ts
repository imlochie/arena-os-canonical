import { and, eq } from "drizzle-orm";

import { isUuid } from "@workspace/arena/lib/api/ids";
import { db } from "@workspace/db";
import { bassAnalyses, bassEvents, sourceAssets, stemAssets } from "@workspace/db/waveyardSchema";
import { ensureBassAnalysis } from "@workspace/arena/lib/waveyard/bass-analysis";
import { bassAnalysisProvenanceReason } from "@workspace/arena/lib/waveyard/types/bass-analysis";
import { requireProjectRole, requireUser } from "@workspace/arena/lib/waveyard/local-context";

async function authorizedBassStem(id: string, userId: string, role: "viewer" | "editor") {
  const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, id)).limit(1);
  if (!stem || stem.stemType !== "bass") return null;
  await requireProjectRole(userId, stem.projectId, role);
  const [source] = await db.select().from(sourceAssets).where(and(
    eq(sourceAssets.id, stem.sourceAssetId),
    eq(sourceAssets.projectId, stem.projectId),
  )).limit(1);
  if (!source) throw new Error("Authorized bass stem has no source asset.");
  return { stem, source };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    const target = await authorizedBassStem(id, user.id, "viewer");
    if (!target) return Response.json({ error: "Isolated bass stem not found." }, { status: 404 });

    const [analysis] = await db.select().from(bassAnalyses).where(eq(bassAnalyses.stemAssetId, target.stem.id)).limit(1);
    const reason = analysis ? bassAnalysisProvenanceReason({
      sourceAssetId: analysis.sourceAssetId,
      expectedSourceAssetId: target.source.id,
      stemAssetId: analysis.stemAssetId,
      expectedStemAssetId: target.stem.id,
      sourceChecksumSha256: analysis.sourceChecksumSha256,
      expectedSourceChecksumSha256: target.source.checksumSha256,
      stemChecksumSha256: analysis.stemChecksumSha256,
      expectedStemChecksumSha256: target.stem.checksumSha256,
      analysisEngine: analysis.analysisEngine,
      analysisEngineVersion: analysis.analysisEngineVersion,
    }) : "analysis_stale";
    const current = Boolean(analysis && analysis.status === "complete" && !reason);
    const events = current
      ? await db.select().from(bassEvents).where(eq(bassEvents.bassAnalysisId, analysis!.id)).orderBy(bassEvents.eventIndex)
      : [];
    return Response.json({ analysis: analysis ?? null, events, current });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("bass analysis read failed", error);
    return Response.json({ error: "Could not read bass analysis." }, { status: 503 });
  }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    const target = await authorizedBassStem(id, user.id, "editor");
    if (!target) return Response.json({ error: "Isolated bass stem not found." }, { status: 404 });

    const result = await ensureBassAnalysis(db, target.source, target.stem);
    if (result.workerUnavailable) {
      return Response.json({ error: "Durable bass analysis requires the local Waveyard worker, which is not active in this runtime." }, { status: 503 });
    }
    if (result.stale) {
      return Response.json({ error: "Existing bass analysis provenance is stale; use the current source and separated stem." }, { status: 409 });
    }
    if (!result.analysis) throw new Error("Could not resolve bass analysis.");
    return Response.json({ analysis: result.analysis, queued: result.queued }, { status: result.queued ? 202 : 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("bass analysis request failed", error);
    return Response.json({ error: "Could not queue durable bass analysis." }, { status: 503 });
  }
}
