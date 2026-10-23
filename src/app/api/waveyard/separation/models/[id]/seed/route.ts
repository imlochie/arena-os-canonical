import { NextResponse } from "next/server";
import { requireApiAccess } from "@/lib/security/api-access";

import { db } from "@/db";
import { findMdxModel, findSeparationRecipe } from "@/lib/waveyard/separation/mdx";
import { requeueFailedSeparationsForModel } from "@/lib/waveyard/separation/retry";
import { getModelFileStatus, modelLabel, seedModelFile } from "@/lib/waveyard/separation/seed";
import { requireUser } from "@/lib/waveyard/local-context";

export const runtime = "nodejs";

/** One-time model download for the stem machine (vision §V1 hybrid
 *  distribution): fetch the registry-pinned file, sha256-verify it, install
 *  it atomically — then re-enqueue every separation job that had failed
 *  honestly for want of this model, so "prepare engine" ends with stems
 *  actually separating again. The download URL is always the registry's
 *  own; the id is validated against the registry (nothing user-supplied
 *  is ever fetched). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(_request); if (denied) return denied;
  try {
    await requireUser();
    const { id } = await params;
    const target = decodeURIComponent(id);
    const modelIds = findSeparationRecipe(target)?.runs.map(run => run.model) ?? [target];
    const specs = [...new Set(modelIds)].map(findMdxModel);
    if (specs.some(spec => !spec)) return NextResponse.json({ error: "Unknown stem engine model." }, { status: 404 });

    const body = await _request.json().catch(() => ({}));
    if (body?.rightsReviewed !== true) return NextResponse.json({ error: "Review pinned model sources/licensing and attest authorised use before download/preparation." }, { status: 400 });
    const models = [];
    let installed = false;
    for (const spec of specs) {
      if (!spec) throw new Error("Invalid recipe model.");
      const result = await seedModelFile(spec, { signal: _request.signal, permissionReviewed: true });
      const status = await getModelFileStatus(spec);
      if (!status.verified) throw new Error("The model did not verify after installation.");
      installed ||= result.outcome === "installed";
      models.push({ id: spec.id, label: modelLabel(spec), ready: status.verified, sizeBytes: status.sizeBytes, provisioning: status.provisioning });
    }
    // A recipe is retried only AFTER every required model verifies. Download
    // completion is not inference completion; the existing job owns that state.
    _request.signal.throwIfAborted();
    const requeued = await requeueFailedSeparationsForModel(db, target);
    return NextResponse.json({
      model: models[0], models,
      outcome: installed ? "installed" : "already-present",
      ...requeued,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "The model could not be prepared.";
    console.error("model seed failed", error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
