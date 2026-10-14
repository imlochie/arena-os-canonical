/**
 * Deep stems — the A7 engine bridge's request surface.
 *
 * The deck's "separate into layers" flow (stem-layers) pulls the MDX
 * registry's trained categories out of a stem; the DEEP pass runs the
 * owner-prepared Demucs engine (htdemucs_6s) instead and rides the SAME
 * durable job pipeline: one processing_jobs row, one queue payload, the
 * worker handler's deep branch, the shared stem-creation tail and per-stem
 * waveform jobs. Six sources come back — vocals, drums, bass, guitar, piano,
 * other (the residual) — so two lanes no other pass can produce (guitar,
 * piano) appear.
 *
 *   GET  → is this machine prepared? (model, six lanes, honest reason, the
 *          exact checkpoint path that was checked)
 *   POST { sourceAssetId }            → whole-song deep pass (six stems)
 *   POST { stemAssetId }              → deep LAYERS of that stem
 *                                      ("other/guitar" = guitar inside the
 *                                      melody lane — recursive separation,
 *                                      deep)
 *
 * One ACTIVE deep job per target — a repeat request while one is queued or
 * running is an honest 409, exactly like stem-layers; once that attempt is
 * complete or failed the same target can be run again as a fresh row
 * (separation/claim.ts — the database arbitrates, so concurrent requests
 * never start two). When the engine is not prepared the request is refused
 * BEFORE a job row exists (503 + the prepare step) — a queued job that can
 * never run would be dishonest.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { sourceAssets, stemAssets } from "@/db/waveyardSchema";
import { requireProjectRole, requireUser } from "@/lib/waveyard/local-context";
import { enqueueSeparation } from "@/lib/waveyard/queue";
import { claimProcessingJob } from "@/lib/waveyard/separation/claim";
import { DEEP_CHECKPOINT_FILE, deepEngineStatusForThisRuntime } from "@/lib/waveyard/separation/deep";
import { DEEP_MODEL_ID, deepStemsEnabled } from "@/lib/waveyard/separation/modes";
import { isUuid } from "@/lib/api/ids";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireUser();
    const status = deepEngineStatusForThisRuntime();
    return NextResponse.json({
      deep: {
        enabled: deepStemsEnabled(),
        modelId: status.modelId,
        label: status.label,
        stems: status.stems,
        prepared: status.prepared,
        python: status.prepared ? status.python : null,
        demucsVersion: status.prepared ? status.demucsVersion : null,
        reason: status.prepared ? null : status.reason,
        checkpoint: { file: DEEP_CHECKPOINT_FILE, path: status.checkpointPath, present: status.checkpointPresent },
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("deep engine status failed", error);
    return NextResponse.json({ error: "The deep engine status could not be read." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");

    if (!deepStemsEnabled()) {
      return NextResponse.json({ error: "The deep pass is not enabled in this build." }, { status: 404 });
    }
    const status = deepEngineStatusForThisRuntime();
    if (!status.prepared) {
      return NextResponse.json({ error: status.reason, deep: { prepared: false } }, { status: 503 });
    }

    const body = (await request.json().catch(() => ({}))) as { sourceAssetId?: unknown; stemAssetId?: unknown };
    const stemAssetId = typeof body.stemAssetId === "string" ? body.stemAssetId : "";
    const sourceAssetId = typeof body.sourceAssetId === "string" ? body.sourceAssetId : "";

    // The target: one stem (deep layers, "<parent>/<child>") or the whole
    // source (the six stems at the top level).
    let parentStem: typeof stemAssets.$inferSelect | null = null;
    let targetSourceAssetId = "";
    if (stemAssetId !== "") {
      if (!isUuid(stemAssetId)) return NextResponse.json({ error: "Pick a stem to run deeper." }, { status: 400 });
      const [stem] = await db
        .select()
        .from(stemAssets)
        .where(and(eq(stemAssets.id, stemAssetId), eq(stemAssets.projectId, projectId)))
        .limit(1);
      if (!stem) return NextResponse.json({ error: "That stem is not in this project." }, { status: 404 });
      // Same honesty rule as stem-layers: layering a layer is legal but
      // rarely what anyone means — refuse one level deep to keep names sane.
      if (stem.stemType.includes("/")) {
        return NextResponse.json(
          { error: "This stem is already a layer — go deeper on the parent stem instead." },
          { status: 422 },
        );
      }
      parentStem = stem;
      targetSourceAssetId = stem.sourceAssetId;
    } else {
      if (!isUuid(sourceAssetId)) return NextResponse.json({ error: "Pick the song to run deeper." }, { status: 400 });
      const [source] = await db
        .select()
        .from(sourceAssets)
        .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.projectId, projectId)))
        .limit(1);
      if (!source) return NextResponse.json({ error: "That source is not in this project." }, { status: 404 });
      targetSourceAssetId = source.id;
    }

    // Idempotency is per TARGET (not per project) and per ACTIVE attempt:
    // one queued/running deep job per target, two targets run independently,
    // and a target whose last attempt is complete or failed can be run again
    // as a fresh row (the earlier attempt stays as history).
    const idempotencyKey = `separation-deep:${parentStem?.id ?? targetSourceAssetId}`;
    const claim = await claimProcessingJob(db, {
      projectId,
      sourceAssetId: targetSourceAssetId,
      type: "separation",
      status: "queued",
      stage: "queued",
      idempotencyKey,
      model: DEEP_MODEL_ID,
      requestedDevice: "auto",
      metadata: JSON.stringify({
        kind: parentStem ? "deep-layers" : "deep-stems",
        deep: true,
        engine: "demucs",
        modelName: status.modelName,
        checkpoint: DEEP_CHECKPOINT_FILE,
        parentStemAssetId: parentStem?.id,
        parentStemType: parentStem?.stemType,
      }),
    });
    if (!claim.created) {
      return NextResponse.json(
        {
          error: "This deep pass is already running — its lanes appear when it finishes.",
          job: claim.active ? { id: claim.active.id, status: claim.active.status, stage: claim.active.stage } : null,
        },
        { status: 409 },
      );
    }
    const job = claim.job;

    try {
      await enqueueSeparation({
        processingJobId: job.id,
        projectId,
        sourceAssetId: targetSourceAssetId,
        model: DEEP_MODEL_ID,
        requestedDevice: "auto",
        ...(parentStem ? { parentStemAssetId: parentStem.id } : {}),
      });
    } catch {
      // The durable job stays queued; the local worker's requeue sweep
      // picks it up (same contract as first-pass separation).
    }

    return NextResponse.json(
      {
        job: { id: job.id },
        deep: {
          modelId: DEEP_MODEL_ID,
          label: status.label,
          stems: status.stems,
          target: parentStem ? { stemType: parentStem.stemType } : { source: true },
        },
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("deep stem request failed", error);
    return NextResponse.json({ error: "The deep separation could not be started." }, { status: 500 });
  }
}
