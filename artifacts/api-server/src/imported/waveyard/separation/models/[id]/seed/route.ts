

import { db } from "@workspace/db";
import { findMdxModel } from "@workspace/arena/lib/waveyard/separation/mdx";
import { requeueFailedSeparationsForModel } from "@workspace/arena/lib/waveyard/separation/retry";
import { getModelFileStatus, modelLabel, seedModelFile } from "@workspace/arena/lib/waveyard/separation/seed";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";

export const runtime = "nodejs";

/** One-time model download for the stem machine (vision §V1 hybrid
 *  distribution): fetch the registry-pinned file, sha256-verify it, install
 *  it atomically — then re-enqueue every separation job that had failed
 *  honestly for want of this model, so "prepare engine" ends with stems
 *  actually separating again. The download URL is always the registry's
 *  own; the id is validated against the registry (nothing user-supplied
 *  is ever fetched). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const spec = findMdxModel(decodeURIComponent(id));
    if (!spec) return Response.json({ error: "Unknown stem engine model." }, { status: 404 });

    const result = await seedModelFile(spec);
    const status = await getModelFileStatus(spec);
    if (!status.verified) {
      // Defensive: seedModelFile only returns success after verification.
      return Response.json({ error: "The model did not verify after installation." }, { status: 500 });
    }
    const requeued =
      result.outcome === "installed"
        ? await requeueFailedSeparationsForModel(db, spec.id)
        : { considered: 0, requeued: 0, failures: [] };
    return Response.json({
      model: { id: spec.id, label: modelLabel(spec), ready: status.verified, sizeBytes: status.sizeBytes },
      outcome: result.outcome,
      ...requeued,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "The model could not be prepared.";
    console.error("model seed failed", error);
    return Response.json({ error: message }, { status: 502 });
  }
}
