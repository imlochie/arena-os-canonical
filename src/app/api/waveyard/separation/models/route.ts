import { NextResponse } from "next/server";

import { MDX_MODELS, SEPARATION_RECIPES } from "@/lib/waveyard/separation/mdx";
import { DEEP_CHECKPOINT_FILE, deepEngineStatusForThisRuntime } from "@/lib/waveyard/separation/deep";
import { deepStemsEnabled } from "@/lib/waveyard/separation/modes";
import { getModelFileStatus, modelLabel } from "@/lib/waveyard/separation/seed";
import { loadOrtModule } from "@/lib/waveyard/separation/session";
import { requireUser } from "@/lib/waveyard/local-context";

export const runtime = "nodejs";

/** The stem engine's models, with their real state on THIS machine.
 *  Product vocabulary only — a model is "ready" or needs a one-time
 *  download; there is no infrastructure language here. The deep pass is
 *  reported the same honest way: prepared (with its six lanes) or not
 *  prepared (with the exact reason and prepare step). */
export async function GET() {
  try {
    await requireUser();
    const models = await Promise.all(
      MDX_MODELS.map(async (spec) => {
        const status = await getModelFileStatus(spec);
        return {
          id: spec.id,
          label: modelLabel(spec),
          file: spec.file, sourceUrl: spec.sourceUrl, sha256: spec.sha256, license: spec.license,
          primaryStem: spec.primaryStem,
          requiredFor: [spec.id, ...(spec.id === MDX_MODELS[0].id ? ["default"] : []), ...SEPARATION_RECIPES.filter(recipe => recipe.runs.some(run => run.model === spec.id)).map(recipe => recipe.id)],
          secondaryStem: spec.secondaryStem,
          sizeBytes: spec.sizeBytes,
          present: status.present,
          verified: status.verified,
          ready: status.verified,
          provisioning: status.provisioning,
          acquisition: status.acquisition ?? null,
        };
      }),
    );
    const deepStatus = deepEngineStatusForThisRuntime();
    const runtimeAvailable = (await loadOrtModule()) !== null;
    return NextResponse.json({
      models: models.map(model => ({ ...model, runtimeAvailable, runtimeReason: runtimeAvailable ? null : "ONNX inference runtime is unavailable; verified model files alone cannot run separation." })),
      mdxRuntime: { available: runtimeAvailable, reason: runtimeAvailable ? null : "ONNX inference runtime is unavailable or its native binding could not load. Verified downloads alone cannot run separation." },
      deep: {
        enabled: deepStemsEnabled(),
        modelId: deepStatus.modelId,
        label: deepStatus.label,
        stems: deepStatus.stems,
        prepared: deepStatus.prepared,
        reason: deepStatus.prepared ? null : deepStatus.reason,
        checkpoint: { file: DEEP_CHECKPOINT_FILE, path: deepStatus.checkpointPath, present: deepStatus.checkpointPresent },
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("model status failed", error);
    return NextResponse.json({ error: "Model status could not be read." }, { status: 500 });
  }
}
