import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { checksumFile, generateWaveform } from "@waveyard/audio";
import {
  getDb,
  sourceAssets,
  stemAssets,
  waveformAssets,
  waveformJobs,
} from "@waveyard/database";
import {
  consumeTestFault,
  recordTestFaultEvent,
  type TestFault,
} from "@waveyard/queue";
import { getStorage, privateObjectKey } from "@waveyard/storage";
import type { WaveformJobPayload } from "@waveyard/types";

async function consumeStemWaveformFault(
  payload: WaveformJobPayload,
  fault: TestFault,
) {
  if (!payload.stemAssetId || !(await consumeTestFault(fault))) return false;
  await recordTestFaultEvent({
    fault,
    event: "injected",
    at: new Date().toISOString(),
  });
  return true;
}

async function updateJob(
  id: string,
  patch: Partial<typeof waveformJobs.$inferInsert>,
) {
  await getDb()
    .update(waveformJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(waveformJobs.id, id));
}

/** Worker-owned waveform extraction. The web process never invokes ffmpeg. */
export async function processWaveform(
  payload: WaveformJobPayload,
  reportStage: (stage: string) => Promise<void>,
) {
  const db = getDb();
  const [job] = await db
    .select()
    .from(waveformJobs)
    .where(eq(waveformJobs.id, payload.waveformJobId))
    .limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  const invalidPayload =
    (payload.sourceAssetId ? 1 : 0) + (payload.stemAssetId ? 1 : 0) !== 1 ||
    job.projectId !== payload.projectId ||
    job.sourceAssetId !== (payload.sourceAssetId ?? null) ||
    job.stemAssetId !== (payload.stemAssetId ?? null);
  if (invalidPayload) {
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "invalid_payload",
      errorMessage:
        "Waveform queue payload does not match its durable job target.",
      completedAt: new Date(),
    });
    throw new Error("Waveform payload does not match its durable job target.");
  }

  const [asset] = payload.sourceAssetId
    ? await db
        .select()
        .from(sourceAssets)
        .where(
          and(
            eq(sourceAssets.id, payload.sourceAssetId),
            eq(sourceAssets.projectId, payload.projectId),
          ),
        )
        .limit(1)
    : await db
        .select()
        .from(stemAssets)
        .where(
          and(
            eq(stemAssets.id, payload.stemAssetId!),
            eq(stemAssets.projectId, payload.projectId),
          ),
        )
        .limit(1);
  if (!asset) {
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "asset_missing",
      errorMessage: "The waveform audio asset is unavailable.",
      completedAt: new Date(),
    });
    throw new Error("The waveform audio asset is unavailable.");
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "waveyard-waveform-"),
  );
  const inputPath = join(temporaryDirectory, "audio-input");
  const pcmPath = join(temporaryDirectory, "decoded.pcm");
  const documentPath = join(temporaryDirectory, "waveform.json");
  const storage = getStorage();
  let storedKey: string | undefined;
  let injectedFault: TestFault | undefined;
  let complete = false;
  try {
    await updateJob(job.id, {
      status: "preparing",
      stage: "preparing",
      startedAt: new Date(),
      attempts: (job.attempts ?? 0) + 1,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
    });
    await reportStage("preparing");
    if (await consumeStemWaveformFault(payload, "waveform-storage-read")) {
      injectedFault = "waveform-storage-read";
      throw new Error("Injected waveform storage read failure.");
    }
    await storage.getToFile(asset.storageKey, inputPath);

    await updateJob(job.id, { status: "processing", stage: "decoding" });
    await reportStage("decoding");
    if (await consumeStemWaveformFault(payload, "waveform-worker-restart")) {
      // Docker restarts this intentional non-zero exit. BullMQ then recovers
      // the stalled job using its original durable waveform-job identifier.
      process.exit(75);
    }
    const waveform = await generateWaveform(inputPath, pcmPath);
    await writeFile(documentPath, JSON.stringify(waveform));
    const checksumSha256 = await checksumFile(documentPath);

    await updateJob(job.id, { status: "finalizing", stage: "storing" });
    await reportStage("storing");
    storedKey = privateObjectKey(job.projectId, "waveform", "json");
    if (await consumeStemWaveformFault(payload, "waveform-storage-write")) {
      injectedFault = "waveform-storage-write";
      throw new Error("Injected waveform storage write failure.");
    }
    await storage.putFile(storedKey, documentPath, "application/json");
    if (await consumeStemWaveformFault(payload, "waveform-after-write")) {
      injectedFault = "waveform-after-write";
      throw new Error("Injected failure after waveform storage write.");
    }
    const metadata = JSON.stringify({
      format: waveform.format,
      durationSeconds: waveform.durationSeconds,
      sampleRate: waveform.sampleRate,
      channels: waveform.channels,
      resolutions: Object.keys(waveform.resolutions).map(Number),
    });

    await db.transaction(async (tx) => {
      // The partial unique indexes make a completed artifact immutable for its
      // source/stem. Do not delete a prior row/object on retry: completion and
      // the asset record are committed atomically below.
      await tx.insert(waveformAssets).values({
        projectId: job.projectId,
        sourceAssetId: payload.sourceAssetId ?? null,
        stemAssetId: payload.stemAssetId ?? null,
        waveformJobId: job.id,
        storageKey: storedKey!,
        checksumSha256,
        format: waveform.format,
        metadata,
      });
      await tx
        .update(waveformJobs)
        .set({
          status: "complete",
          stage: "complete",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(waveformJobs.id, job.id));
    });
    complete = true;
    await reportStage("complete");
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 1800)
        : "Unknown waveform failure.";
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "waveform_failed",
      errorMessage: message,
      completedAt: new Date(),
    });
    throw error;
  } finally {
    if (!complete && storedKey) {
      let cleanupVerified = false;
      try {
        await storage.delete(storedKey);
        cleanupVerified = !(await storage.exists(storedKey));
      } catch {
        // Preserve the original lifecycle failure; the fault audit makes an
        // unsuccessful cleanup visible to the release gate.
      }
      if (injectedFault === "waveform-after-write")
        await recordTestFaultEvent({
          fault: injectedFault,
          event: "cleanup",
          cleanupVerified,
          at: new Date().toISOString(),
        });
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
