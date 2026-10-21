/** Import a checkpoint the owner already possesses.
 *
 * The uploaded file is validated BEFORE it is used: it must be
 * the exact htdemucs_6s checkpoint (its sha256 must match the
 * identity Demucs itself encodes in the filename). A mislabelled
 * or wrong file is rejected — never accepted because of its
 * name. The upload is bounded and stored only in the app's
 * models directory. */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { guardedFormData } from "@/lib/security/request-limits";
import { deepModelSpec } from "@/lib/waveyard/separation/modes";
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/waveyard/local-context";
import { resolveModelsDir } from "@/lib/waveyard/separation/session";
import { getPreparationManager } from "@/lib/waveyard/separation/provision-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CHECKPOINT_BYTES = 200_000_000;

export async function POST(request: Request) {
  try {
    await requireUser();
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json({ error: "Upload a checkpoint file." }, { status: 400 });
    }
    const guard = await guardedFormData(request, MAX_CHECKPOINT_BYTES);
    if (!guard.ok) return guard.error!;
    const form = guard.form!;
    if (form === null) {
      return NextResponse.json({ error: "The upload could not be read." }, { status: 400 });
    }
    const spec = deepModelSpec(String(form.get("model") ?? "deep_6s"));
    const file = form.get("checkpoint");
    if (file === null || typeof file === "string") {
      return NextResponse.json({ error: "Attach the checkpoint file to import." }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "The upload was not a file." }, { status: 400 });
    }
    // Accept the canonical name or any name — identity is proven by
    // content, not filename. Reject absurd sizes up front.
    if (file.size > MAX_CHECKPOINT_BYTES || file.size === 0) {
      return NextResponse.json({ error: `That file is ${file.size} bytes — it is not the ${spec.file} checkpoint.` }, { status: 400 });
    }
    // Write to a temp path, then let the manager validate + place it.
    const manager = getPreparationManager(spec.id);
    const modelsDir = resolveModelsDir();
    const tempDir = modelsDir;
    const tempPath = `${tempDir}/.import-${randomUUID()}.th`;
    const { rm } = await import("node:fs/promises");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(modelsDir, { recursive: true });
    try {
      await pipeline(Readable.fromWeb(file.stream() as import("node:stream/web").ReadableStream), createWriteStream(tempPath, { flags: "wx" }));
      const result = await manager.importCheckpoint(tempPath);
      if (!result.ok) {
        return NextResponse.json({ error: result.error ?? "The checkpoint could not be imported." }, { status: 422 });
      }
      return NextResponse.json({ ok: true, checkpoint: spec.file }, { status: 200 });
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("deep checkpoint import failed", error);
    return NextResponse.json({ error: "The checkpoint could not be imported." }, { status: 500 });
  }
}
