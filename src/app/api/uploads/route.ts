import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { acceptedAudioFilename, checksumFile, MAX_UPLOAD_BYTES, probeAudio, sanitizedFilename } from "@/lib/waveyard/audio";
import { db } from "@/db";
import {
  processingJobs,
  sourceAcquisitions,
  sourceAssets,
  waveformJobs,
} from "@/db/waveyardSchema";
import { enqueueSeparation, enqueueWaveform } from "@/lib/waveyard/queue";
import { getStorage, privateObjectKey } from "@/lib/waveyard/storage";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let temporaryDirectory: string | undefined;
  let storedKey: string | undefined;
  let persisted = false;
  try {
    const user = await requireUser();
    const form = await request.formData();
    const projectId = String(form.get("projectId") ?? "");
    const requestedModel = String(form.get("model") ?? process.env.SEPARATION_MODEL ?? "htdemucs");
    const requestedDevice = String(form.get("device") ?? process.env.STEM_DEVICE ?? "auto");
    const upload = form.get("file");
    if (!projectId || !(upload instanceof File)) return NextResponse.json({ error: "Project and audio file are required." }, { status: 400 });
    if (!acceptedAudioFilename(upload.name)) return NextResponse.json({ error: "Supported formats are WAV, MP3, FLAC, M4A, AAC, and OGG." }, { status: 415 });
    if (upload.size <= 0 || upload.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: `Audio must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes.` }, { status: 413 });
    if (!/^(auto|cpu|cuda)$/.test(requestedDevice)) return NextResponse.json({ error: "Invalid processing device." }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");

    // Honest offline probe fallback: when the server has no ffprobe, the
    // browser's Web Audio decode (real duration/sampleRate/channels from the
    // actual file) may stand in — recorded as probeSource "client-webaudio".
    const clientProbe = {
      durationSeconds: Number(form.get("clientDurationSeconds") ?? NaN),
      sampleRate: Number(form.get("clientSampleRate") ?? NaN),
      channels: Number(form.get("clientChannels") ?? NaN),
      codec: String(form.get("clientCodec") ?? "browser-decoded"),
    };
    const clientProbeUsable = Number.isFinite(clientProbe.durationSeconds) && clientProbe.durationSeconds > 0
      && Number.isFinite(clientProbe.sampleRate) && clientProbe.sampleRate > 0
      && Number.isFinite(clientProbe.channels) && clientProbe.channels > 0;

    temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-upload-"));
    const cleanName = sanitizedFilename(upload.name);
    const localUpload = join(temporaryDirectory, `${randomUUID()}${extname(cleanName).toLowerCase()}`);
    await writeFile(localUpload, Buffer.from(await upload.arrayBuffer()));
    let metadata: Awaited<ReturnType<typeof probeAudio>>;
    let probeSource = "server-ffprobe";
    try {
      metadata = await probeAudio(localUpload);
    } catch (probeError) {
      const message = probeError instanceof Error ? probeError.message : String(probeError);
      const ffprobeMissing = /ENOENT|not found|spawn/i.test(message);
      if (!ffprobeMissing || !clientProbeUsable) throw probeError;
      metadata = { ...clientProbe, bitrate: null, sizeBytes: upload.size } as Awaited<ReturnType<typeof probeAudio>>;
      probeSource = "client-webaudio";
    }
    const checksum = await checksumFile(localUpload);
    const storageKey = privateObjectKey(projectId, "source", extname(cleanName));
    await getStorage().putFile(storageKey, localUpload, upload.type || "application/octet-stream");
    storedKey = storageKey;

    
    const { source, job, waveformJob } = await db.transaction(async (tx) => {
      const [createdSource] = await tx.insert(sourceAssets).values({
        projectId, originalFilename: cleanName, mimeType: upload.type || "application/octet-stream", storageKey, checksumSha256: checksum,
        durationSeconds: Math.round(metadata.durationSeconds), sampleRate: metadata.sampleRate, channels: metadata.channels,
        codec: metadata.codec, bitrate: metadata.bitrate, fileSizeBytes: metadata.sizeBytes,
      }).returning();
      await tx.insert(sourceAcquisitions).values({ sourceAssetId: createdSource.id, method: "local-upload", metadata: JSON.stringify({ filename: cleanName, probeSource }) });
      const [createdJob] = await tx.insert(processingJobs).values({
        projectId, sourceAssetId: createdSource.id, type: "separation", status: "queued", stage: "queued", idempotencyKey: `separation:${createdSource.id}:${requestedModel}`,
        model: requestedModel, requestedDevice,
      }).returning();
      const [createdWaveformJob] = await tx.insert(waveformJobs).values({
        projectId, sourceAssetId: createdSource.id, status: "queued", stage: "queued", idempotencyKey: `waveform:source:${createdSource.id}`,
      }).returning();
      return { source: createdSource, job: createdJob, waveformJob: createdWaveformJob };
    });
    persisted = true;
    // Every queue is attempted independently: a separation outage (the
    // desktop runtime has no Python separation executor) must not prevent
    // the waveform from being generated — each durable row records its own
    // honest failure boundary. (Desktop runtime fix; see
    // docs/desktop-runtime-plan.md §5.)
    let separationQueued = true;
    try {
      await enqueueSeparation({ processingJobId: job.id, projectId, sourceAssetId: source.id, model: requestedModel, requestedDevice: requestedDevice as "auto" | "cpu" | "cuda" });
    } catch (queueError) {
      separationQueued = false;
      await db.update(processingJobs).set({ status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable", errorMessage: queueError instanceof Error ? queueError.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date(), updatedAt: new Date() }).where(eq(processingJobs.id, job.id));
    }
    let waveformQueued = true;
    try {
      await enqueueWaveform({ waveformJobId: waveformJob.id, projectId, sourceAssetId: source.id });
    } catch (queueError) {
      waveformQueued = false;
      await db.update(waveformJobs).set({ status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable", errorMessage: queueError instanceof Error ? queueError.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date(), updatedAt: new Date() }).where(eq(waveformJobs.id, waveformJob.id));
    }
    if (!separationQueued)
      return NextResponse.json({ error: "The upload was stored, but separation could not be queued. Start the worker/Redis and retry this source.", source, waveformJobId: waveformJob.id, waveformQueued }, { status: 503 });
    return NextResponse.json({ source, job, waveformJob: { id: waveformJob.id, queued: waveformQueued } }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Upload failed.";
    if (/ffprobe|decode|valid timed stream/i.test(message)) return NextResponse.json({ error: "The file could not be decoded as supported audio. Nothing was queued." }, { status: 422 });
    console.error("upload failed", error);
    return NextResponse.json({ error: "Upload failed before processing started." }, { status: 500 });
  } finally {
    if (storedKey && !persisted) await getStorage().delete(storedKey).catch(() => undefined);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
