import { isUuid } from "@/lib/api/ids";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import { acceptedAudioFilename, MAX_UPLOAD_BYTES } from "@/lib/waveyard/audio";
import { requireUser } from "@/lib/waveyard/local-context";
import { configuredAuthorizedSourceResolver, validateAuthorizedSourceUrl } from "@/lib/waveyard/authorized-source-resolver";
import { ingestSourceFile } from "@/lib/waveyard/source-ingest"
import { defaultSeparationModel, isAcceptableSeparationModel } from "@/lib/waveyard/separation/selection";
import { requireProjectRole } from "@/lib/waveyard/local-context";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let directory: string | undefined;
  try {
    const user = await requireUser(); const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");
    const body = await request.json().catch(() => ({}));
    const sourceUrl = validateAuthorizedSourceUrl(String(body.url ?? ""));
    if (!sourceUrl) return NextResponse.json({ error: "Enter a valid http or https source URL." }, { status: 400 });
    const resolver = configuredAuthorizedSourceResolver();
    if (!resolver) return NextResponse.json({ error: "This deployment has no authorized link resolver. Download material you are authorized to use and add it as an audio file instead." }, { status: 503 });
    const resolved = await resolver.resolve(sourceUrl);
    if (!acceptedAudioFilename(resolved.filename)) return NextResponse.json({ error: "The authorized resolver returned an unsupported audio format. Add a WAV, MP3, FLAC, M4A, AAC, or OGG file manually instead." }, { status: 415 });
    const audio = await fetch(resolved.audioUrl);
    if (!audio.ok || !audio.body) return NextResponse.json({ error: "Authorized source acquisition failed. You can add the same material manually as an audio file." }, { status: 422 });
    const declared = Number(audio.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return NextResponse.json({ error: `Authorized source is larger than the ${MAX_UPLOAD_BYTES}-byte intake limit.` }, { status: 413 });
    directory = await mkdtemp(join(tmpdir(), "waveyard-authorized-source-"));
    const filePath = join(directory, `${randomUUID()}-${resolved.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
    let received = 0;
    const limit = new Transform({ transform(chunk, _encoding, done) { received += chunk.length; done(received > MAX_UPLOAD_BYTES ? new Error("Authorized source exceeded the intake limit.") : undefined, chunk); } });
    await pipeline(Readable.fromWeb(audio.body as import("node:stream/web").ReadableStream), limit, createWriteStream(filePath));
    const requestedModel = body.model !== undefined && body.model !== null && String(body.model).trim() !== "" ? String(body.model) : defaultSeparationModel();
    if (!isAcceptableSeparationModel(requestedModel)) {
      return NextResponse.json({ error: `Unknown separation target "${requestedModel}" — use the app's built-in choices.` }, { status: 400 });
    }
    const result = await ingestSourceFile({ projectId, filePath, filename: resolved.filename, mimeType: resolved.mimeType ?? audio.headers.get("content-type") ?? "application/octet-stream", model: requestedModel, device: "auto", provenance: { method: "authorized-url", sourceUrl, title: resolved.title, artist: resolved.artist, resolver: resolved.resolver, metadata: resolved.metadata } });
    // The ingest itself succeeded — a queue failure must not turn the whole
    // intake into an error. The durable separation row records its own honest
    // failure boundary (same policy as POST /api/uploads), and the response
    // carries separationQueued so the UI can surface the real state.
    return NextResponse.json({ source: result.source, job: result.job, separationQueued: result.separationQueued, waveformJob: { id: result.waveformJob.id, queued: result.waveformQueued }, acquisition: { method: "authorized-url", sourceUrl, title: resolved.title ?? null, artist: resolved.artist ?? null } }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Authorized source acquisition failed.";
    console.error("authorized source intake failed", error);
    return NextResponse.json({ error: `${message} Add the material manually as an audio file if you are authorized to use it.` }, { status: 422 });
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
