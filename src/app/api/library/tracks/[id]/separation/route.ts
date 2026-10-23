import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { processingJobs } from "@/db/waveyardSchema";
import { requireUser, requireProjectRole } from "@/lib/waveyard/local-context";
import { getTrack } from "@/lib/waveyard/library/service";
import { isUuid } from "@/lib/api/ids";
import { localWorkerActive } from "@/lib/waveyard/worker-local/broker";
import { startSeparationJob } from "@/lib/waveyard/separation/claim";
import { isAcceptableSeparationModel, defaultSeparationModel } from "@/lib/waveyard/separation/selection";
import { isDeepSeparationMode } from "@/lib/waveyard/separation/modes";
import { inspectDeepRuntimeReadiness } from "@/lib/waveyard/separation/deep";
import { findMdxModel, findSeparationRecipe } from "@/lib/waveyard/separation/mdx";
import { loadOrtModule, verifyModelFile } from "@/lib/waveyard/separation/session";
export const runtime = "nodejs";

async function owned(id: string) {
  const user = await requireUser();
  if (!isUuid(id)) throw NextResponse.json({ error: "Invalid track id." }, { status: 400 });
  const track = await getTrack(user.id, id);
  if (!track) throw NextResponse.json({ error: "Track not found." }, { status: 404 });
  return { user, track };
}
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { track } = await owned((await params).id);
    const jobs = await db.select().from(processingJobs).where(and(eq(processingJobs.sourceAssetId, track.source.id), eq(processingJobs.type, "separation"))).orderBy(desc(processingJobs.createdAt)).limit(20);
    return NextResponse.json({ jobs });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, track } = await owned((await params).id);
    await requireProjectRole(user.id, track.studioProjectId, "editor");
    if (!localWorkerActive()) return NextResponse.json({ error: "This engine requires Arena's native executor." }, { status: 503 });
    const input = await request.json(); const model = input.model || defaultSeparationModel();
    if (typeof model !== "string" || !isAcceptableSeparationModel(model)) return NextResponse.json({ error: "Choose a supported separation engine." }, { status: 400 });
    if (isDeepSeparationMode(model)) {
      const ready = await inspectDeepRuntimeReadiness({ modelId: model });
      if (!ready.prepared) return NextResponse.json({ error: ready.reason }, { status: 503 });
    } else {
      if (!await loadOrtModule()) throw new Error("ONNX runtime is unavailable.");
      const ids = findSeparationRecipe(model)?.runs.map(run => run.model) ?? [model];
      for (const id of new Set(ids)) { const spec = findMdxModel(id); if (!spec) throw new Error(`Unknown native model: ${id}`); await verifyModelFile(spec); }
    }
    const result = await startSeparationJob(db, { projectId: track.studioProjectId, sourceAssetId: track.source.id, type: "separation", model, requestedDevice: "auto", status: "queued", stage: "queued", idempotencyKey: `separation:${track.source.id}:${model}` }, job => ({ processingJobId: job.id, projectId: job.projectId, sourceAssetId: track.source.id, model, requestedDevice: "auto" }));
    return result.outcome === "queued" ? NextResponse.json({ job: result.job }, { status: 202 }) : NextResponse.json({ error: result.outcome === "active" ? "This recording already has an active separation attempt." : result.reason }, { status: result.outcome === "active" ? 409 : 503 });
  } catch (error) { if (error instanceof Response) return error; return NextResponse.json({ error: error instanceof Error ? error.message : "Separation could not start." }, { status: 503 }); }
}
