import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { and, eq } from "drizzle-orm";
import { checksumFile, validateAudio, type SeparationEngineMetadata, type ValidatedStem } from "@waveyard/audio";
import { getDb, processingJobs, sourceAssets, stemAssets } from "@waveyard/database";
import { getStorage, privateObjectKey } from "@waveyard/storage";
import type { SeparationJobPayload, StemType } from "@waveyard/types";

const STEMS: StemType[] = ["vocals", "drums", "bass", "other"];

async function updateJob(id: string, patch: Partial<typeof processingJobs.$inferInsert>) {
  await getDb().update(processingJobs).set({ ...patch, updatedAt: new Date() }).where(eq(processingJobs.id, id));
}

function runPython(args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const python = process.env.PYTHON_BIN ?? "python3";
    const current = process.cwd();
    const root = process.env.WAVEYARD_ROOT ?? (existsSync(resolve(current, "services/separation/separate.py")) ? current : resolve(current, "../.."));
    const script = resolve(root, "services/separation/separate.py");
    const child = spawn(python, [script, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`Demucs process failed (exit ${code}): ${(stderr || stdout).slice(-2000)}`));
    });
  });
}

async function validateStems(outputDirectory: string): Promise<ValidatedStem[]> {
  const results: ValidatedStem[] = [];
  for (const stemType of STEMS) {
    const path = join(outputDirectory, `${stemType}.wav`);
    const metadata = await validateAudio(path);
    results.push({ stemType, path, metadata, checksumSha256: await checksumFile(path) });
  }
  return results;
}

export async function processSeparation(payload: SeparationJobPayload, reportStage: (stage: string) => Promise<void>) {
  const db = getDb();
  const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, payload.processingJobId)).limit(1);
  if (!job) throw new Error("Processing job no longer exists.");
  if (job.status === "complete") return;
  if (job.status === "cancelled") return;

  const [source] = await db.select().from(sourceAssets).where(and(eq(sourceAssets.id, payload.sourceAssetId), eq(sourceAssets.projectId, payload.projectId))).limit(1);
  if (!source) throw new Error("Authorized source asset is missing.");

  const tempDirectory = await mkdtemp(join(tmpdir(), "waveyard-separation-"));
  const inputPath = join(tempDirectory, "source-upload");
  const outputDirectory = join(tempDirectory, "output");
  const storage = getStorage();
  const uploadedKeys: string[] = [];
  let completed = false;

  try {
    await updateJob(job.id, { status: "preparing", stage: "preparing", startedAt: new Date(), errorCode: null, errorMessage: null });
    await reportStage("preparing");
    await storage.getToFile(source.storageKey, inputPath);

    await updateJob(job.id, { status: "processing", stage: "separating", attempts: (job.attempts ?? 0) + 1 });
    await reportStage("separating");
    const { stdout } = await runPython(["--input", inputPath, "--output", outputDirectory, "--model", payload.model, "--device", payload.requestedDevice], tempDirectory);
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as SeparationEngineMetadata;
    if (!result.resolvedDevice || result.engine !== "demucs") throw new Error("Demucs adapter returned invalid engine metadata.");

    await updateJob(job.id, { status: "finalizing", stage: "validating", resolvedDevice: result.resolvedDevice });
    await reportStage("validating");
    const validatedStems = await validateStems(outputDirectory);

    const values: (typeof stemAssets.$inferInsert)[] = [];
    for (const stem of validatedStems) {
      const storageKey = privateObjectKey(job.projectId, "stem", "wav");
      await storage.putFile(storageKey, stem.path, "audio/wav");
      uploadedKeys.push(storageKey);
      values.push({
        projectId: job.projectId,
        sourceAssetId: source.id,
        separationJobId: job.id,
        stemType: stem.stemType,
        engine: "demucs",
        model: payload.model,
        modelVersion: result.modelVersion ?? payload.model,
        storageKey,
        checksumSha256: stem.checksumSha256,
        durationSeconds: Math.round(stem.metadata.durationSeconds),
        sampleRate: stem.metadata.sampleRate,
        channels: stem.metadata.channels,
        codec: stem.metadata.codec,
        format: "wav",
        fileSizeBytes: stem.metadata.sizeBytes,
      });
    }

    await db.transaction(async (tx) => {
      await tx.delete(stemAssets).where(eq(stemAssets.separationJobId, job.id));
      await tx.insert(stemAssets).values(values);
      await tx.update(processingJobs).set({ status: "complete", stage: "complete", completedAt: new Date(), updatedAt: new Date(), metadata: JSON.stringify({ engine: "demucs", model: payload.model, resolvedDevice: result.resolvedDevice, outputCount: values.length }) }).where(eq(processingJobs.id, job.id));
    });
    completed = true;
    await reportStage("complete");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown separation failure.";
    await updateJob(job.id, { status: "failed", stage: "failed", errorCode: "separation_failed", errorMessage: message, completedAt: new Date() });
    throw error;
  } finally {
    if (!completed) {
      await Promise.allSettled(uploadedKeys.map((key) => storage.delete(key)));
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
