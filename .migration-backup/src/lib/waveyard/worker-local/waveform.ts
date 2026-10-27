/**
 * Local waveform job handler — a faithful port of the worker's
 * processWaveform (waveyard-worker/apps/worker/src/waveform.ts) against the
 * app's own tables and storage, using the app's own generateWaveform engine
 * (FFmpeg decode → bounded peaks, waveyard-peaks-v1).
 *
 * Desktop-only difference, documented in docs/desktop-runtime-plan.md §5:
 * in the cloud pipeline the separation worker provisions the source
 * analysis row; on desktop, completing a SOURCE waveform provisions the
 * analysis row (engine arena-js-dsp) and enqueues it once every related
 * waveform job is terminal — the same maybeQueueSourceAnalysis trigger the
 * worker runs for stems. (Since the local MDX stem machine landed, desktop
 * separation is real too — this trigger now fires for stem waveframes as
 * well, exactly like the worker's.)
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { sourceAnalyses, sourceAssets, stemAssets, waveformAssets, waveformJobs } from "@/db/waveyardSchema";
import { checksumFile, generateWaveform } from "@/lib/waveyard/audio";
import { getStorage, privateObjectKey } from "@/lib/waveyard/storage";
import { enqueueSourceAnalysis } from "@/lib/waveyard/queue";
import type { WaveformJobPayload } from "@/lib/waveyard/types";
import { DESKTOP_ANALYSIS_ENGINE, DESKTOP_ANALYSIS_ENGINE_VERSION } from "./analysis-engine";

export function desktopAnalysisIdempotencyKey(sourceAssetId: string) {
  return `analysis:${sourceAssetId}:${DESKTOP_ANALYSIS_ENGINE}:${DESKTOP_ANALYSIS_ENGINE_VERSION}`;
}

async function updateJob(id: string, patch: Partial<typeof waveformJobs.$inferInsert>) {
  await db.update(waveformJobs).set({ ...patch, updatedAt: new Date() }).where(eq(waveformJobs.id, id));
}

type AssetTarget = {
  storageKey: string;
  sourceAssetId: string | null;
  stemAssetId: string | null;
};

async function resolveTarget(payload: WaveformJobPayload): Promise<AssetTarget | null> {
  if (payload.stemAssetId) {
    const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, payload.stemAssetId)).limit(1);
    return stem ? { storageKey: stem.storageKey, sourceAssetId: stem.sourceAssetId, stemAssetId: stem.id } : null;
  }
  if (payload.sourceAssetId) {
    const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, payload.sourceAssetId)).limit(1);
    return source ? { storageKey: source.storageKey, sourceAssetId: source.id, stemAssetId: null } : null;
  }
  return null;
}

/**
 * Desktop adaptation of the worker's maybeQueueSourceAnalysis: provisions the
 * durable analysis row for a source whose separation cannot run locally, then
 * enqueues analysis once every related waveform job reached a terminal state.
 */
async function maybeProvisionDesktopAnalysis(projectId: string, sourceAssetId: string) {
  const [analysis] = await db
    .select()
    .from(sourceAnalyses)
    .where(and(eq(sourceAnalyses.projectId, projectId), eq(sourceAnalyses.sourceAssetId, sourceAssetId)))
    .limit(1);
  let row = analysis;
  if (!row) {
    const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, sourceAssetId)).limit(1);
    if (!source) return;
    const [created] = await db
      .insert(sourceAnalyses)
      .values({
        projectId,
        sourceAssetId,
        status: "queued",
        stage: "queued",
        idempotencyKey: desktopAnalysisIdempotencyKey(sourceAssetId),
        analysisEngine: DESKTOP_ANALYSIS_ENGINE,
        analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
        sourceChecksumSha256: source.checksumSha256,
      })
      .onConflictDoUpdate({
        target: sourceAnalyses.sourceAssetId,
        set: { status: "queued", stage: "queued", updatedAt: new Date() },
      })
      .returning();
    row = created;
  }
  if (!row || row.status !== "queued") return;

  const stems = await db
    .select({ id: stemAssets.id })
    .from(stemAssets)
    .where(and(eq(stemAssets.projectId, projectId), eq(stemAssets.sourceAssetId, sourceAssetId)));
  const stemIds = new Set(stems.map((stem) => stem.id));
  const projectWaveformJobs = await db.select().from(waveformJobs).where(eq(waveformJobs.projectId, projectId));
  const related = projectWaveformJobs.filter(
    (job) => job.sourceAssetId === sourceAssetId || (job.stemAssetId !== null && stemIds.has(job.stemAssetId)),
  );
  const terminal = new Set(["complete", "failed", "cancelled"]);
  if (!related.length || related.some((job) => !terminal.has(job.status))) return;

  try {
    await enqueueSourceAnalysis({
      sourceAnalysisId: row.id,
      projectId,
      sourceAssetId,
      analysisEngine: row.analysisEngine,
      analysisEngineVersion: row.analysisEngineVersion,
    });
  } catch (error) {
    await db
      .update(sourceAnalyses)
      .set({
        status: "failed",
        stage: "queue-unavailable",
        errorCode: "queue_unavailable",
        analysisError: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sourceAnalyses.id, row.id));
  }
}

/** Local waveform execution — same lifecycle the BullMQ worker drives. */
export async function handleWaveformJob(payloadInput: Record<string, unknown>): Promise<void> {
  const payload = payloadInput as unknown as WaveformJobPayload;
  const [job] = await db.select().from(waveformJobs).where(eq(waveformJobs.id, payload.waveformJobId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  const asset = await resolveTarget(payload);
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

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "arena-waveform-"));
  const inputPath = join(temporaryDirectory, "audio-input");
  const pcmPath = join(temporaryDirectory, "decoded.pcm");
  const documentPath = join(temporaryDirectory, "waveform.json");
  const storage = getStorage();
  let storedKey: string | undefined;
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
    await storage.getToFile(asset.storageKey, inputPath);
    await updateJob(job.id, { status: "processing", stage: "decoding" });
    const waveform = await generateWaveform(inputPath, pcmPath);
    await writeFile(documentPath, JSON.stringify(waveform));
    const checksum = await checksumFile(documentPath);

    await updateJob(job.id, { status: "finalizing", stage: "storing" });
    storedKey = privateObjectKey(job.projectId, "waveform", "json");
    await storage.putFile(storedKey, documentPath, "application/json");
    const metadata = JSON.stringify({
      format: waveform.format,
      durationSeconds: waveform.durationSeconds,
      sampleRate: waveform.sampleRate,
      channels: waveform.channels,
      resolutions: Object.keys(waveform.resolutions).map(Number),
    });

    await db.transaction(async (tx) => {
      await tx.insert(waveformAssets).values({
        projectId: job.projectId,
        sourceAssetId: asset.sourceAssetId,
        stemAssetId: asset.stemAssetId,
        waveformJobId: job.id,
        storageKey: storedKey!,
        checksumSha256: checksum,
        format: waveform.format,
        metadata,
      });
      await tx
        .update(waveformJobs)
        .set({ status: "complete", stage: "complete", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(waveformJobs.id, job.id));
    });
    if (asset.sourceAssetId) await maybeProvisionDesktopAnalysis(job.projectId, asset.sourceAssetId);
    complete = true;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown waveform failure.";
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "waveform_failed",
      errorMessage: message,
      completedAt: new Date(),
    });
    throw error;
  } finally {
    if (!complete && storedKey) await storage.delete(storedKey).catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
