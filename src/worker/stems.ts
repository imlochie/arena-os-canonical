import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { stemAssets, stemProcessingJobs, stemSourceAssets, stemWorkerHeartbeats } from "@/db/schema";
import { checksumFile, run, STEM_TYPES, validateAudio, type StemType } from "@/lib/stems/audio";
import { getStemQueueConnection, STEM_SEPARATION_QUEUE, type SeparationJobPayload } from "@/lib/stems/queue";
import { getStemStorage, privateObjectKey } from "@/lib/stems/storage";

const workerId = process.env.STEM_WORKER_ID ?? "primary";
const defaultModel = process.env.STEM_MODEL ?? "htdemucs";
const requestedDevice = process.env.STEM_DEVICE ?? "auto";

async function heartbeat(device = requestedDevice) {
  await db.insert(stemWorkerHeartbeats).values({ id: workerId, engine: "demucs", model: defaultModel, device, lastSeenAt: new Date() })
    .onConflictDoUpdate({ target: stemWorkerHeartbeats.id, set: { engine: "demucs", model: defaultModel, device, lastSeenAt: new Date() } });
}

async function updateJob(id: string, patch: Partial<typeof stemProcessingJobs.$inferInsert>) {
  await db.update(stemProcessingJobs).set({ ...patch, updatedAt: new Date() }).where(eq(stemProcessingJobs.id, id));
}

async function runDemucs(input: string, output: string, model: string, device: "auto" | "cpu" | "cuda", cwd: string) {
  const script = resolve(process.env.ARENA_ROOT ?? process.cwd(), "services", "separation", "separate.py");
  if (!existsSync(script)) throw new Error("Arena Demucs adapter is missing.");
  const { stdout } = await run(process.env.PYTHON_BIN ?? "python3", [script, "--input", input, "--output", output, "--model", model, "--device", device], cwd);
  const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { engine?: string; modelVersion?: string; resolvedDevice?: string };
  if (result.engine !== "demucs" || !result.resolvedDevice) throw new Error("Demucs adapter returned incomplete engine metadata.");
  return result as { engine: "demucs"; modelVersion?: string; resolvedDevice: string };
}

async function processSeparation(payload: SeparationJobPayload, reportStage: (stage: string) => Promise<void>) {
  const [job] = await db.select().from(stemProcessingJobs).where(eq(stemProcessingJobs.id, payload.processingJobId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  const [source] = await db.select().from(stemSourceAssets)
    .where(and(eq(stemSourceAssets.id, payload.sourceAssetId), eq(stemSourceAssets.projectId, payload.projectId))).limit(1);
  if (!source) throw new Error("The authorized source asset is unavailable.");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "arena-stem-"));
  const input = join(temporaryDirectory, "source-audio");
  const output = join(temporaryDirectory, "output");
  const storage = getStemStorage();
  const uploaded: string[] = [];
  let completed = false;

  try {
    await updateJob(job.id, { status: "preparing", stage: "preparing", attempts: (job.attempts ?? 0) + 1, startedAt: new Date(), errorCode: null, errorMessage: null, completedAt: null });
    await reportStage("preparing");
    await storage.getToFile(source.storageKey, input);

    await updateJob(job.id, { status: "processing", stage: "separating" });
    await reportStage("separating");
    const engine = await runDemucs(input, output, payload.model, payload.requestedDevice, temporaryDirectory);
    await heartbeat(engine.resolvedDevice);

    await updateJob(job.id, { status: "validating", stage: "validating", resolvedDevice: engine.resolvedDevice });
    await reportStage("validating");
    const assets: Array<typeof stemAssets.$inferInsert> = [];
    for (const stemType of STEM_TYPES) {
      const file = join(output, `${stemType}.wav`);
      const metadata = await validateAudio(file);
      const storageKey = privateObjectKey(job.projectId, "stem", "wav");
      await storage.putFile(storageKey, file, "audio/wav");
      uploaded.push(storageKey);
      assets.push({
        projectId: job.projectId,
        sourceAssetId: source.id,
        separationJobId: job.id,
        stemType: stemType as StemType,
        engine: "demucs",
        model: payload.model,
        modelVersion: engine.modelVersion ?? payload.model,
        storageKey,
        checksumSha256: await checksumFile(file),
        durationSeconds: Math.round(metadata.durationSeconds),
        sampleRate: metadata.sampleRate,
        channels: metadata.channels,
        codec: metadata.codec,
        format: "wav",
        fileSizeBytes: metadata.sizeBytes,
      });
    }

    await db.transaction(async (tx) => {
      await tx.delete(stemAssets).where(eq(stemAssets.separationJobId, job.id));
      await tx.insert(stemAssets).values(assets);
      await tx.update(stemProcessingJobs).set({
        status: "complete", stage: "complete", completedAt: new Date(), updatedAt: new Date(),
        metadata: JSON.stringify({ engine: "demucs", model: payload.model, resolvedDevice: engine.resolvedDevice, outputCount: assets.length }),
      }).where(eq(stemProcessingJobs.id, job.id));
    });
    completed = true;
    await reportStage("complete");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1_800) : "Unknown separation failure.";
    await updateJob(job.id, { status: "failed", stage: "failed", errorCode: "separation_failed", errorMessage: message, completedAt: new Date() });
    throw error;
  } finally {
    if (!completed) await Promise.allSettled(uploaded.map((key) => storage.delete(key)));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const concurrency = Math.max(1, Number(process.env.STEM_WORKER_CONCURRENCY ?? 1));
let worker: Worker<SeparationJobPayload> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

async function start() {
  // Do not advertise an available worker until the actual Demucs Python module
  // and its device runtime can be imported.
  await run(process.env.PYTHON_BIN ?? "python3", ["-c", "import demucs, torch; print(demucs.__version__)"]);
  worker = new Worker<SeparationJobPayload>(STEM_SEPARATION_QUEUE, async (job) => {
    await heartbeat();
    await processSeparation(job.data, async (stage) => { await job.updateProgress({ stage }); });
  }, { connection: getStemQueueConnection(), concurrency });
  heartbeatTimer = setInterval(() => { void heartbeat().catch((error) => console.error("Stem worker heartbeat failed", error)); }, 20_000);
  await heartbeat();
  worker.on("ready", () => console.info(`Arena stem worker ready (concurrency=${concurrency}).`));
  worker.on("failed", (job, error) => console.error(`Stem job ${job?.id ?? "unknown"} failed: ${error.message}`));
}

async function shutdown(signal: string) {
  console.info(`${signal} received; stopping Arena stem worker.`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await worker?.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
void start().catch((error) => {
  console.error("Arena stem worker cannot start", error);
  process.exit(1);
});
