import { extname } from "node:path";
import { eq } from "drizzle-orm";
import { checksumFile, probeAudio, sanitizedFilename } from "./audio";
import { db } from "@workspace/db";
import {
  processingJobs,
  sourceAcquisitions,
  sourceAssets,
  waveformJobs,
} from "@workspace/db/waveyardSchema";
import { enqueueSeparation, enqueueWaveform } from "./queue";
import { getStorage, privateObjectKey } from "./storage";
import { sourceObjectLockQuery } from "./source-object-lock";
import type { AudioMetadata } from "./types";

export type SourceAcquisitionProvenance = {
  method: "local-upload" | "authorized-url";
  sourceUrl?: string;
  title?: string;
  artist?: string;
  resolver?: string;
  metadata?: Record<string, unknown>;
};

/**
 * The one ingestion path for local and authorized-remote audio. Once this
 * succeeds, downstream code sees a normal SourceAsset; callers can omit
 * processing for derived local copies that do not need another stem run.
 */
type IngestSourceFileInput = {
  projectId: string;
  filePath: string;
  filename: string;
  mimeType: string;
  model: string;
  device: "auto" | "cpu" | "cuda";
  provenance: SourceAcquisitionProvenance;
  prepareProcessing?: boolean;
  /** Reuse a prior trusted probe when the caller also needs its embedded tags. */
  probedAudio?: AudioMetadata;
};

type QueuedIngestResult = {
  source: typeof sourceAssets.$inferSelect;
  job: typeof processingJobs.$inferSelect;
  waveformJob: typeof waveformJobs.$inferSelect;
  separationQueued: boolean;
  waveformQueued: boolean;
};

type UnqueuedIngestResult = {
  source: typeof sourceAssets.$inferSelect;
  job: null;
  waveformJob: null;
  separationQueued: false;
  waveformQueued: false;
};

export function ingestSourceFile(
  input: IngestSourceFileInput & { prepareProcessing?: true },
): Promise<QueuedIngestResult>;
export function ingestSourceFile(
  input: IngestSourceFileInput & { prepareProcessing: false },
): Promise<UnqueuedIngestResult>;
export async function ingestSourceFile(
  input: IngestSourceFileInput,
): Promise<QueuedIngestResult | UnqueuedIngestResult> {
  const cleanName = sanitizedFilename(input.filename);
  const metadata = input.probedAudio ?? await probeAudio(input.filePath);
  const checksum = await checksumFile(input.filePath);
  const storageKey = privateObjectKey(input.projectId, "source", extname(cleanName));
  let stored = false;
  try {
    const { source, job, waveformJob } = await db.transaction(async (tx) => {
      // Acquire the same lock as orphan cleanup before the final object is
      // written. This keeps cleanup from deleting an upload between its
      // storage write and source_assets commit.
      await tx.execute(sourceObjectLockQuery(storageKey));
      await getStorage().putFile(storageKey, input.filePath, input.mimeType || "application/octet-stream");
      stored = true;
      const [createdSource] = await tx.insert(sourceAssets).values({
        projectId: input.projectId, originalFilename: cleanName, mimeType: input.mimeType || "application/octet-stream", storageKey, checksumSha256: checksum,
        durationSeconds: Math.round(metadata.durationSeconds), sampleRate: metadata.sampleRate, channels: metadata.channels,
        codec: metadata.codec, bitrate: metadata.bitrate, fileSizeBytes: metadata.sizeBytes,
      }).returning();
      await tx.insert(sourceAcquisitions).values({
        sourceAssetId: createdSource.id, method: input.provenance.method, sourceUrl: input.provenance.sourceUrl ?? null,
        title: input.provenance.title ?? null, artist: input.provenance.artist ?? null, resolver: input.provenance.resolver ?? null,
        metadata: JSON.stringify(input.provenance.metadata ?? {}),
      });
      if (input.prepareProcessing === false) {
        return { source: createdSource, job: null, waveformJob: null };
      }
      const [createdJob] = await tx.insert(processingJobs).values({
        projectId: input.projectId, sourceAssetId: createdSource.id, type: "separation", status: "queued", stage: "queued", idempotencyKey: `separation:${createdSource.id}:${input.model}`,
        model: input.model, requestedDevice: input.device,
      }).returning();
      const [createdWaveformJob] = await tx.insert(waveformJobs).values({ projectId: input.projectId, sourceAssetId: createdSource.id, status: "queued", stage: "queued", idempotencyKey: `waveform:source:${createdSource.id}` }).returning();
      return { source: createdSource, job: createdJob, waveformJob: createdWaveformJob };
    });
    if (job === null || waveformJob === null) {
      return { source, job: null, waveformJob: null, separationQueued: false, waveformQueued: false };
    }
    let separationQueued = true;
    try { await enqueueSeparation({ processingJobId: job.id, projectId: input.projectId, sourceAssetId: source.id, model: input.model, requestedDevice: input.device }); }
    catch (error) {
      separationQueued = false;
      await db.update(processingJobs).set({ status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable", errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date(), updatedAt: new Date() }).where(eq(processingJobs.id, job.id));
    }
    let waveformQueued = true;
    try { await enqueueWaveform({ waveformJobId: waveformJob.id, projectId: input.projectId, sourceAssetId: source.id }); }
    catch (error) {
      waveformQueued = false;
      await db.update(waveformJobs).set({ status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable", errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date(), updatedAt: new Date() }).where(eq(waveformJobs.id, waveformJob.id));
    }
    return { source, job, waveformJob, separationQueued, waveformQueued };
  } catch (error) {
    if (stored) {
      // A failed transaction can have an ambiguous commit outcome. Recheck
      // under the object lock before deleting so a committed upload survives.
      await db.transaction(async (tx) => {
        await tx.execute(sourceObjectLockQuery(storageKey));
        const [asset] = await tx
          .select({ id: sourceAssets.id })
          .from(sourceAssets)
          .where(eq(sourceAssets.storageKey, storageKey))
          .limit(1);
        if (!asset) await getStorage().delete(storageKey);
      }).catch(() => undefined);
    }
    throw error;
  }
}
