import { mkdtemp, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@workspace/db";
import { libraryConversionJobs, projects, sourceAcquisitions, sourceAssets, tracks } from "@workspace/db/waveyardSchema";
import { addTrackFromAudioFile } from "../library/service";
import { acceptedAudioFilename, checksumFile, MAX_UPLOAD_BYTES, sanitizedFilename } from "../audio";
import { getStorage } from "../storage";
import { CONVERSION_FORMATS, convertLocalAudio, type ConversionFormat } from "./engine";
import { libraryConversionIdempotencyKey } from "./idempotency";

const active = new Map<string, AbortController>();
let pump: Promise<void> | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let stopping = false;

async function runJob(jobId: string, controller: AbortController) {
  let temporaryDirectory: string | undefined;
  let progressWrite = Promise.resolve();
  let progressError: unknown;
  let lastPersistedProgress = -1;
  try {
    const [job] = await db.select().from(libraryConversionJobs)
      .where(eq(libraryConversionJobs.id, jobId)).limit(1);
    if (!job) return;
    const [row] = await db
      .select({
        trackId: tracks.id,
        projectId: tracks.projectId,
        title: tracks.title,
        artist: tracks.artist,
        album: tracks.album,
        source: sourceAssets,
      })
      .from(tracks)
      .innerJoin(sourceAssets, and(
        eq(sourceAssets.id, tracks.sourceAssetId),
        eq(sourceAssets.projectId, tracks.projectId),
      ))
      .innerJoin(projects, and(
        eq(projects.id, tracks.projectId),
        eq(projects.ownerId, job.ownerId),
      ))
      .where(and(eq(tracks.id, job.originalTrackId), eq(tracks.ownerId, job.ownerId)))
      .limit(1);
    if (!row || row.source.id !== job.sourceAssetId) throw new Error("The original local audio track is no longer available.");

    const [acquisition] = await db.select({ method: sourceAcquisitions.method })
      .from(sourceAcquisitions)
      .where(eq(sourceAcquisitions.sourceAssetId, row.source.id)).limit(1);
    if (acquisition?.method !== "local-upload") {
      throw new Error("Conversion is limited to files uploaded from this device.");
    }
    if (
      !acceptedAudioFilename(row.source.originalFilename) ||
      !Number.isSafeInteger(row.source.fileSizeBytes) ||
      row.source.fileSizeBytes < 1 ||
      row.source.fileSizeBytes > MAX_UPLOAD_BYTES ||
      !/^[a-f0-9]{64}$/i.test(row.source.checksumSha256)
    ) {
      throw new Error("The stored original is not a supported, verified local audio file.");
    }

    const storage = getStorage();
    if (!(await storage.exists(row.source.storageKey))) throw new Error("The original audio is missing from private storage.");
    temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-conversion-"));
    const sourcePath = join(temporaryDirectory, `source${extname(row.source.originalFilename).toLowerCase()}`);
    const format = CONVERSION_FORMATS[job.format as ConversionFormat];
    if (!format) throw new Error("The requested conversion format is no longer supported.");
    const outputPath = join(temporaryDirectory, `converted.${format.extension}`);
    await storage.getToFile(row.source.storageKey, sourcePath);
    if ((await checksumFile(sourcePath)) !== row.source.checksumSha256.toLowerCase()) {
      throw new Error("The stored original failed its checksum check.");
    }

    await db.update(libraryConversionJobs).set({
      stage: "converting",
      progress: Math.max(job.progress, 5),
      updatedAt: new Date(),
    }).where(eq(libraryConversionJobs.id, job.id));
    const verification = await convertLocalAudio(
      sourcePath,
      outputPath,
      { format: job.format as ConversionFormat, bitrate: job.bitrate as 128 | 192 | 256 | 320 },
      controller.signal,
      (percent) => {
        const progress = Math.min(85, 5 + Math.floor(percent * 0.8));
        if (progress <= lastPersistedProgress) return;
        lastPersistedProgress = progress;
        progressWrite = progressWrite.then(() => db.update(libraryConversionJobs).set({
          stage: "converting",
          progress,
          updatedAt: new Date(),
        }).where(and(
          eq(libraryConversionJobs.id, job.id),
          eq(libraryConversionJobs.status, "running"),
        ))).then(() => undefined).catch((error: unknown) => { progressError = error; });
      },
    );
    await progressWrite;
    if (progressError) throw progressError;
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Conversion interrupted.");

    await db.update(libraryConversionJobs).set({
      stage: "importing",
      progress: 92,
      updatedAt: new Date(),
    }).where(and(
      eq(libraryConversionJobs.id, job.id),
      eq(libraryConversionJobs.status, "running"),
    ));
    const result = await addTrackFromAudioFile({
      ownerId: job.ownerId,
      filePath: outputPath,
      filename: `${sanitizedFilename(row.title)}.converted.${format.extension}`,
      mimeType: format.mimeType,
      title: row.title,
      artist: row.artist,
      album: row.album,
      prepareSeparation: false,
    });
    await db.update(libraryConversionJobs).set({
      status: "complete",
      stage: "complete",
      progress: 100,
      convertedTrackId: result.track.id,
      verification: JSON.stringify(verification),
      errorMessage: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(libraryConversionJobs.id, job.id));
  } catch (error) {
    if (controller.signal.aborted || stopping) {
      await db.update(libraryConversionJobs).set({
        status: "queued",
        stage: "queued",
        progress: 0,
        errorMessage: null,
        updatedAt: new Date(),
      }).where(and(
        eq(libraryConversionJobs.id, jobId),
        eq(libraryConversionJobs.status, "running"),
      ));
    } else {
      await db.update(libraryConversionJobs).set({
        status: "failed",
        stage: "failed",
        errorMessage: (error instanceof Error ? error.message : "Local audio conversion failed.").slice(0, 1000),
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(libraryConversionJobs.id, jobId),
        eq(libraryConversionJobs.status, "running"),
      ));
    }
  } finally {
    active.delete(jobId);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function drainQueue() {
  while (!stopping) {
    const [candidate] = await db.select({ id: libraryConversionJobs.id })
      .from(libraryConversionJobs)
      .where(eq(libraryConversionJobs.status, "queued"))
      .orderBy(asc(libraryConversionJobs.createdAt))
      .limit(1);
    if (!candidate) return;
    const [claimed] = await db.update(libraryConversionJobs).set({
      status: "running",
      stage: "preparing",
      progress: 2,
      attempts: sql`${libraryConversionJobs.attempts} + 1`,
      errorMessage: null,
      startedAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(libraryConversionJobs.id, candidate.id),
      eq(libraryConversionJobs.status, "queued"),
    )).returning({ id: libraryConversionJobs.id });
    if (!claimed) continue;
    const controller = new AbortController();
    active.set(claimed.id, controller);
    await runJob(claimed.id, controller);
  }
}

function wakeWorker() {
  if (stopping || pump) return;
  pump = drainQueue().catch(() => undefined).finally(() => {
    pump = null;
  });
}

export async function startLocalLibraryConversionWorker() {
  stopping = false;
  await db.update(libraryConversionJobs).set({
    status: "queued",
    stage: "queued",
    progress: 0,
    errorMessage: null,
    updatedAt: new Date(),
  }).where(inArray(libraryConversionJobs.status, ["running"]));
  pollTimer = setInterval(wakeWorker, 2_000);
  pollTimer.unref();
  wakeWorker();
}

export function wakeLocalLibraryConversionWorker() {
  wakeWorker();
}

export async function stopLocalLibraryConversionWorker() {
  stopping = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  for (const controller of active.values()) controller.abort(new Error("Server is shutting down."));
  await pump;
}
