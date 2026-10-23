import { NextResponse } from "next/server";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireApiAccess } from "@/lib/security/api-access";
import { guardedFormData } from "@/lib/security/request-limits";
import { findMdxModel } from "@/lib/waveyard/separation/mdx";
import {
  getModelFileStatus,
  importModelFile,
} from "@/lib/waveyard/separation/seed";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  let root: string | undefined;
  try {
    const spec = findMdxModel((await context.params).id);
    if (!spec)
      return NextResponse.json(
        { error: "Unknown model. Import one pinned registry file at a time." },
        { status: 404 },
      );
    const guard = await guardedFormData(
      request,
      Math.ceil(spec.sizeBytes * 1.5) + 65536,
    );
    if (!guard.ok) return guard.error!;
    const form = guard.form!;
    if (form.get("rightsReviewed") !== "true")
      return NextResponse.json(
        {
          error:
            "Review model source/licence and confirm authorised use before import.",
        },
        { status: 400 },
      );
    const file = form.get("file");
    if (
      !(file instanceof File) ||
      file.size <= 0 ||
      file.size > spec.sizeBytes * 1.5
    )
      return NextResponse.json(
        {
          error:
            "Provide the exact registered model file within its size bound.",
        },
        { status: 400 },
      );
    root = await mkdtemp(join(tmpdir(), "wy-owner-model-"));
    const path = join(root, "model.onnx");
    await writeFile(path, Buffer.from(await file.arrayBuffer()));
    const result = await importModelFile(spec, path, {
      signal: request.signal,
      rightsReviewed: true,
    });
    return NextResponse.json({
      result,
      model: { id: spec.id, status: await getModelFileStatus(spec) },
      inferenceCompleted: false,
      notice:
        "Exact pinned bytes verified. No inference has run; model-use permission and real-song acceptance are not established by a checksum.",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Model import failed.",
      },
      { status: 422 },
    );
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
}
