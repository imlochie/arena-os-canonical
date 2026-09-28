import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import { acceptedAudioFilename, MAX_UPLOAD_BYTES } from "@waveyard/audio";
import { requireUser } from "@/lib/auth";
import { configuredAuthorizedSourceResolver, validateAuthorizedSourceUrl } from "@/lib/authorized-source-resolver";
import { ingestSourceFile } from "@/lib/source-ingest";
import { requireProjectRole } from "@/lib/permissions";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let directory: string | undefined;
  try {
    const user = await requireUser(); const { id: projectId } = await params;
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
    const result = await ingestSourceFile({ projectId, filePath, filename: resolved.filename, mimeType: resolved.mimeType ?? audio.headers.get("content-type") ?? "application/octet-stream", model: String(body.model ?? process.env.SEPARATION_MODEL ?? "htdemucs"), device: "auto", provenance: { method: "authorized-url", sourceUrl, title: resolved.title, artist: resolved.artist, resolver: resolved.resolver, metadata: resolved.metadata } });
    if (!result.separationQueued) return NextResponse.json({ error: "The authorized source was stored, but separation could not be queued. Start the worker/Redis and retry this source." }, { status: 503 });
    return NextResponse.json({ source: result.source, job: result.job, waveformJob: { id: result.waveformJob.id, queued: result.waveformQueued }, acquisition: { method: "authorized-url", sourceUrl, title: resolved.title ?? null, artist: resolved.artist ?? null } }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Authorized source acquisition failed.";
    console.error("authorized source intake failed", error);
    return NextResponse.json({ error: `${message} Add the material manually as an audio file if you are authorized to use it.` }, { status: 422 });
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
