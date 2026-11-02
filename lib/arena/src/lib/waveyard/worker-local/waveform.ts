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
import type { drizzle } from "drizzle-orm/node-postgres";

import { db } from "@workspace/db";
import { sourceAnalyses, sourceAssets, stemAssets, waveformAssets, waveformJobs } from "@workspace/db/waveyardSchema";
import { checksumFile, generateWaveform } from "@workspace/arena/lib/waveyard/audio";
import { getStorage, type StorageProvider } from "@workspace/arena/lib/waveyard/storage";
import { enqueueSourceAnalysis } from "@workspace/arena/lib/waveyard/queue";
import type { WaveformJobPayload } from "@workspace/arena/lib/waveyard/types";
import { DESKTOP_ANALYSIS_ENGINE, DESKTOP_ANALYSIS_ENGINE_VERSION } from "./analysis-engine";

export const ORPHAN_WAVEFORM_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
export const WAVEFORM_MAX_ATTEMPTS = 3;
export const WAVEFORM_RETRY_BACKOFF_MS = [1_000, 5_000] as const;
const GENERATED_WAVEFORM_KEY = /^projects\/[^/]+\/waveform\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const TRANSIENT_WAVEFORM_ERROR_CODES = new Set([
  "EAGAIN",
  "EBUSY",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

export function desktopAnalysisIdempotencyKey(sourceAssetId: string) {
  return `analysis:${sourceAssetId}:${DESKTOP_ANALYSIS_ENGINE}:${DESKTOP_ANALYSIS_ENGINE_VERSION}`;
}

/**
 * Remove only old, generated waveform objects that have no canonical asset row.
 * The grace period protects an upload while its finalization transaction is
 * still in flight, including when the database query races with a new upload.
 */
export async function cleanupOrphanedWaveformObjects(
  dependencies: {
    db?: ReturnType<typeof drizzle>;
    storage?: StorageProvider;
    now?: Date;
    gracePeriodMs?: number;
  } = {},
): Promise<string[]> {
  const database = dependencies.db ?? db;
  const storage = dependencies.storage ?? getStorage();
  const now = dependencies.now ?? new Date();
  const gracePeriodMs = dependencies.gracePeriodMs ?? ORPHAN_WAVEFORM_GRACE_PERIOD_MS;
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(gracePeriodMs) || gracePeriodMs < 1) {
    throw new Error("A valid cleanup time and positive grace period are required.");
  }

  const cutoff = now.getTime() - gracePeriodMs;
  const [objects, assets] = await Promise.all([
    storage.listObjects("projects"),
    database.select({ storageKey: waveformAssets.storageKey }).from(waveformAssets),
  ]);
  const referencedKeys = new Set(assets.map((asset) => asset.storageKey));
  const removed: string[] = [];
  for (const object of objects) {
    if (
      !GENERATED_WAVEFORM_KEY.test(object.key) ||
      object.lastModified.getTime() > cutoff ||
      referencedKeys.has(object.key)
    ) {
      continue;
    }
    await storage.delete(object.key);
    removed.push(object.key);
  }
  return removed;
}

async function updateJob(database: ReturnType<typeof drizzle>, id: string, patch: Partial<typeof waveformJobs.$inferInsert>) {
  await database.update(waveformJobs).set({ ...patch, updatedAt: new Date() }).where(eq(waveformJobs.id, id));
}

export function isTransientWaveformFailure(error: unknown): boolean {
  const details = error && typeof error === "object"
    ? error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; stderr?: unknown; signal?: unknown; cause?: unknown }
    : {};
  let current: unknown = error;
  const visited = new Set<object>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const code = "code" in current && typeof current.code === "string" ? current.code.toUpperCase() : "";
    if (TRANSIENT_WAVEFORM_ERROR_CODES.has(code) || code.startsWith("08")) return true;
    current = "cause" in current ? current.cause : null;
  }
  if (details.signal === "SIGKILL") return true;

  const status = Number(details.statusCode ?? details.status);
  if (Number.isInteger(status) && (status === 408 || status === 425 || status === 429 || status >= 500)) return true;

  const causeMessage = details.cause instanceof Error ? details.cause.message : "";
  const message = [
    typeof details.message === "string" ? details.message : String(error ?? ""),
    typeof details.stderr === "string" ? details.stderr : "",
    causeMessage,
  ].join("\n");
  return /resource temporarily unavailable|temporarily unavailable|temporary failure|timed out|cannot allocate memory|device or resource busy/i.test(message);
}

type AssetTarget = {
  storageKey: string;
  sourceAssetId: string | null;
  stemAssetId: string | null;
};

async function resolveTarget(database: ReturnType<typeof drizzle>, payload: WaveformJobPayload): Promise<AssetTarget | null> {
  if (payload.stemAssetId) {
    const [stem] = await database.select().from(stemAssets).where(eq(stemAssets.id, payload.stemAssetId)).limit(1);
    return stem ? { storageKey: stem.storageKey, sourceAssetId: stem.sourceAssetId, stemAssetId: stem.id } : null;
  }
  if (payload.sourceAssetId) {
    const [source] = await database.select().from(sourceAssets).where(eq(sourceAssets.id, payload.sourceAssetId)).limit(1);
    return source ? { storageKey: source.storageKey, sourceAssetId: source.id, stemAssetId: null } : null;
  }
  return null;
}

/**
 * Desktop adaptation of the worker's maybeQueueSourceAnalysis: provisions the
 * durable analysis row for a source whose separation cannot run locally, then
 * enqueues analysis once every related waveform job reached a terminal state.
 */
async function maybeProvisionDesktopAnalysis(database: ReturnType<typeof drizzle>, projectId: string, sourceAssetId: string) {
  const [analysis] = await database
    .select()
    .from(sourceAnalyses)
    .where(and(eq(sourceAnalyses.projectId, projectId), eq(sourceAnalyses.sourceAssetId, sourceAssetId)))
    .limit(1);
  let row = analysis;
  if (!row) {
    const [source] = await database.select().from(sourceAssets).where(eq(sourceAssets.id, sourceAssetId)).limit(1);
    if (!source) return;
    const [created] = await database
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

  const stems = await database
    .select({ id: stemAssets.id })
    .from(stemAssets)
    .where(and(eq(stemAssets.projectId, projectId), eq(stemAssets.sourceAssetId, sourceAssetId)));
  const stemIds = new Set(stems.map((stem) => stem.id));
  const projectWaveformJobs = await database.select().from(waveformJobs).where(eq(waveformJobs.projectId, projectId));
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
    await database
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
export async function handleWaveformJob(
  payloadInput: Record<string, unknown>,
  dependencies: {
    db?: ReturnType<typeof drizzle>;
    storage?: StorageProvider;
    generateWaveform?: typeof generateWaveform;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const database = dependencies.db ?? db;
  const storage = dependencies.storage ?? getStorage();
  const generate = dependencies.generateWaveform ?? generateWaveform;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const payload = payloadInput as unknown as WaveformJobPayload;
  const [job] = await database.select().from(waveformJobs).where(eq(waveformJobs.id, payload.waveformJobId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  const asset = await resolveTarget(database, payload);
  if (!asset) {
    await updateJob(database, job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "asset_missing",
      errorMessage: "The waveform audio asset is unavailable.",
      completedAt: new Date(),
    });
    throw new Error("The waveform audio asset is unavailable.");
  }

  const attemptsAlreadyMade = Math.max(0, job.attempts ?? 0);
  if (attemptsAlreadyMade >= WAVEFORM_MAX_ATTEMPTS) {
    const message = `Waveform generation exhausted its ${WAVEFORM_MAX_ATTEMPTS}-attempt automatic retry limit.`;
    await updateJob(database, job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "waveform_retry_exhausted",
      errorMessage: message,
      completedAt: new Date(),
    });
    throw new Error(message);
  }

  // A stable key makes retries idempotent even if a failed write left an
  // object behind and best-effort cleanup could not remove it.
  const storedKey = `projects/${job.projectId}/waveform/${job.id}.json`;
  const runAttempt = async (attempt: number) => {
    let temporaryDirectory: string | undefined;
    try {
      await updateJob(database, job.id, {
        status: "preparing",
        stage: "preparing",
        startedAt: new Date(),
        attempts: attempt,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
      });
      temporaryDirectory = await mkdtemp(join(tmpdir(), "arena-waveform-"));
      const inputPath = join(temporaryDirectory, "audio-input");
      const pcmPath = join(temporaryDirectory, "decoded.pcm");
      const documentPath = join(temporaryDirectory, "waveform.json");
      await storage.getToFile(asset.storageKey, inputPath);
      await updateJob(database, job.id, { status: "processing", stage: "decoding" });
      const waveform = await generate(inputPath, pcmPath);
      await writeFile(documentPath, JSON.stringify(waveform));
      const checksum = await checksumFile(documentPath);

      await updateJob(database, job.id, { status: "finalizing", stage: "storing" });
      await storage.putFile(storedKey, documentPath, "application/json");
      const metadata = JSON.stringify({
        format: waveform.format,
        durationSeconds: waveform.durationSeconds,
        sampleRate: waveform.sampleRate,
        channels: waveform.channels,
        resolutions: Object.keys(waveform.resolutions).map(Number),
      });

      await database.transaction(async (tx) => {
        await tx.insert(waveformAssets).values({
          projectId: job.projectId,
          sourceAssetId: asset.sourceAssetId,
          stemAssetId: asset.stemAssetId,
          waveformJobId: job.id,
          storageKey: storedKey,
          checksumSha256: checksum,
          format: waveform.format,
          metadata,
        });
        await tx
          .update(waveformJobs)
          .set({ status: "complete", stage: "complete", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(waveformJobs.id, job.id));
      });
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  for (let attempt = attemptsAlreadyMade + 1; attempt <= WAVEFORM_MAX_ATTEMPTS; attempt += 1) {
    try {
      await runAttempt(attempt);
      if (asset.sourceAssetId) {
        try {
          await maybeProvisionDesktopAnalysis(database, job.projectId, asset.sourceAssetId);
        } catch (error) {
          console.error("Waveform completed but desktop source analysis could not be scheduled.", error);
        }
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown waveform failure.";
      const retryable = isTransientWaveformFailure(error);
      if (retryable && attempt < WAVEFORM_MAX_ATTEMPTS) {
        const delay = WAVEFORM_RETRY_BACKOFF_MS[Math.min(attempt - 1, WAVEFORM_RETRY_BACKOFF_MS.length - 1)];
        await updateJob(database, job.id, {
          status: "processing",
          stage: "retrying",
          attempts: attempt,
          errorCode: "waveform_retrying",
          errorMessage: `Temporary failure on attempt ${attempt}/${WAVEFORM_MAX_ATTEMPTS}; retrying after ${delay} ms: ${message}`,
          completedAt: null,
        });
        await sleep(delay);
        continue;
      }

      const exhausted = retryable && attempt >= WAVEFORM_MAX_ATTEMPTS;
      await updateJob(database, job.id, {
        status: "failed",
        stage: "failed",
        attempts: attempt,
        errorCode: exhausted ? "waveform_retry_exhausted" : "waveform_failed",
        errorMessage: exhausted
          ? `Waveform generation failed after ${attempt} attempts: ${message}`
          : message,
        completedAt: new Date(),
      });
      throw error;
    }
  }
}
