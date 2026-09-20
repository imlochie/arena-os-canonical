import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { stemProcessingJobs, stemSourceAssets } from "@/db/schema";
import { acceptedAudioFilename, checksumFile, extensionFor, probeAudio, sanitizedFilename } from "@/lib/stems/audio";
import { requireStemUser } from "@/lib/stems/auth";
import { requireStemProjectRole } from "@/lib/stems/permissions";
import { enqueueStemSeparation } from "@/lib/stems/queue";
import { getStemStorage, privateObjectKey } from "@/lib/stems/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = Number(process.env.STEM_MAX_UPLOAD_BYTES ?? 524_288_000);

function workerUrl() { return process.env.STEM_WORKER_URL?.replace(/\/$/, ""); }
function pipelineEnabled() { return process.env.STEM_PIPELINE_ENABLED === "true"; }

async function readForm(request: Request) {
  try { return await request.formData(); }
  catch { throw Response.json({ error: "A multipart audio upload is required." }, { status: 400 }); }
}

async function submitToArenaPipeline(request: Request) {
  let temporaryDirectory: string | undefined;
  let storedKey: string | undefined;
  let persisted = false;
  try {
    const user = await requireStemUser();
    const form = await readForm(request);
    const projectId = String(form.get("projectId") ?? "");
    const upload = form.get("file");
    const model = String(form.get("model") ?? process.env.STEM_MODEL ?? "htdemucs").slice(0, 120);
    const requestedDevice = String(form.get("device") ?? process.env.STEM_DEVICE ?? "auto");
    if (!projectId || !(upload instanceof File)) return Response.json({ error: "Choose a private project and an audio file." }, { status: 400 });
    if (!acceptedAudioFilename(upload.name)) return Response.json({ error: "Supported formats are WAV, MP3, FLAC, M4A, AAC, and OGG." }, { status: 415 });
    if (upload.size <= 0 || upload.size > MAX_UPLOAD_BYTES) return Response.json({ error: `Audio must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes.` }, { status: 413 });
    if (!/^(auto|cpu|cuda)$/.test(requestedDevice)) return Response.json({ error: "Choose auto, cpu, or cuda as the processing device." }, { status: 400 });
    await requireStemProjectRole(user.id, projectId, "editor");

    temporaryDirectory = await mkdtemp(join(tmpdir(), "arena-stem-upload-"));
    const filename = sanitizedFilename(upload.name);
    const localUpload = join(temporaryDirectory, `${randomUUID()}${extname(filename).toLowerCase()}`);
    await writeFile(localUpload, Buffer.from(await upload.arrayBuffer()));
    const metadata = await probeAudio(localUpload);
    const checksum = await checksumFile(localUpload);
    const storageKey = privateObjectKey(projectId, "source", extensionFor(filename));
    await getStemStorage().putFile(storageKey, localUpload, upload.type || "application/octet-stream");
    storedKey = storageKey;

    const { source, job } = await db.transaction(async (tx) => {
      const [source] = await tx.insert(stemSourceAssets).values({
        projectId, originalFilename: filename, mimeType: upload.type || "application/octet-stream", storageKey, checksumSha256: checksum,
        durationSeconds: Math.round(metadata.durationSeconds), sampleRate: metadata.sampleRate, channels: metadata.channels,
        codec: metadata.codec, bitrate: metadata.bitrate, fileSizeBytes: metadata.sizeBytes,
      }).returning();
      const [job] = await tx.insert(stemProcessingJobs).values({
        projectId, sourceAssetId: source.id, status: "queued", stage: "queued",
        idempotencyKey: `separation:${source.id}:${model}`, model, requestedDevice,
      }).returning();
      return { source, job };
    });
    persisted = true;

    try {
      await enqueueStemSeparation({ processingJobId: job.id, projectId, sourceAssetId: source.id, model, requestedDevice: requestedDevice as "auto" | "cpu" | "cuda" });
    } catch (error) {
      await db.update(stemProcessingJobs).set({ status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable", errorMessage: error instanceof Error ? error.message.slice(0, 1_000) : "Queue unavailable.", completedAt: new Date(), updatedAt: new Date() }).where(eq(stemProcessingJobs.id, job.id));
      return Response.json({ error: "The source was stored, but Redis did not accept the job. Start the queue and retry this source." }, { status: 503 });
    }
    return Response.json({ source: { ...source, storageKey: undefined }, job }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Upload failed.";
    if (/ffprobe|decode|timed stream/i.test(message)) return Response.json({ error: "The file could not be decoded as supported audio. Nothing was queued." }, { status: 422 });
    console.error("Arena stem upload failed", error);
    return Response.json({ error: "Upload failed before processing started." }, { status: 500 });
  } finally {
    if (storedKey && !persisted) await getStemStorage().delete(storedKey).catch(() => undefined);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

// Compatibility adapter for an operator-provided worker. The durable Arena
// pipeline takes precedence when STEM_PIPELINE_ENABLED=true.
async function forwardToConfiguredWorker(request: Request) {
  const target = workerUrl();
  if (!target) return Response.json({ error: "Stem separation is unavailable: configure STEM_PIPELINE_ENABLED with Arena storage/queue or a real STEM_WORKER_URL." }, { status: 503 });
  const form = await readForm(request);
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return Response.json({ error: "Choose an audio file to send to the configured worker." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "Audio file exceeds the configured stem-worker upload limit." }, { status: 413 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const upstream = await fetch(`${target}/v1/separations`, { method: "POST", body: form, signal: controller.signal, headers: { "X-Arena-Project": String(form.get("projectId") ?? "") } });
    const body = await upstream.json().catch(() => ({ error: "Stem worker returned an invalid response." }));
    return Response.json(body, { status: upstream.status });
  } catch {
    return Response.json({ error: "The configured stem worker did not accept the separation request." }, { status: 503 });
  } finally { clearTimeout(timeout); }
}

export async function POST(request: Request) {
  return pipelineEnabled() ? submitToArenaPipeline(request) : forwardToConfiguredWorker(request);
}
