import { NextResponse } from "next/server";

import { MDX_MODELS } from "@/lib/waveyard/separation/mdx";
import { DEEP_CHECKPOINT_FILE, deepEngineStatusForThisRuntime } from "@/lib/waveyard/separation/deep";
import { deepStemsEnabled } from "@/lib/waveyard/separation/modes";
import { getModelFileStatus, modelLabel } from "@/lib/waveyard/separation/seed";
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
          primaryStem: spec.primaryStem,
          secondaryStem: spec.secondaryStem,
          sizeBytes: spec.sizeBytes,
          present: status.present,
          verified: status.verified,
          ready: status.verified,
        };
      }),
    );
    const deepStatus = deepEngineStatusForThisRuntime();
    return NextResponse.json({
      models,
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
