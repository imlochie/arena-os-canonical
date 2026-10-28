import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

import { enqueueWaveform } from "@workspace/arena/lib/waveyard/queue";
import type { WaveformJobPayload } from "@workspace/arena/lib/waveyard/types";
import { processingJobs, waveformJobs } from "@workspace/db/waveyardSchema";

const SEPARATION_TEMP_PREFIX = "arena-separation-";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function cleanupAbandonedSeparationDirectories(
  root = tmpdir(),
  processIsAlive: (pid: number) => boolean = isProcessAlive,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SEPARATION_TEMP_PREFIX)) continue;
    const ownerText = entry.name.slice(SEPARATION_TEMP_PREFIX.length).split("-", 1)[0] ?? "";
    const ownerPid = /^\d+$/.test(ownerText) ? Number(ownerText) : null;
    // Directories created before PID scoping are abandoned once this runtime
    // starts. Newer directories are only removed after their owning process exits.
    if (ownerPid !== null && processIsAlive(ownerPid)) continue;
    await rm(join(root, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

export async function recoverInterruptedLocalSeparationJobs(
  db: ReturnType<typeof drizzle>,
  options: {
    tempRoot?: string;
    processIsAlive?: (pid: number) => boolean;
  } = {},
): Promise<{ interruptedJobIds: string[]; cleanedTempDirectories: string[] }> {
  const interrupted = await db
    .update(processingJobs)
    .set({
      status: "failed",
      stage: "interrupted",
      errorCode: "processor_interrupted",
      errorMessage: "The local processor stopped before this job finished. Retry separation to continue.",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(processingJobs.type, "separation"),
      inArray(processingJobs.status, ["queued", "preparing", "processing", "finalizing"]),
    ))
    .returning({ id: processingJobs.id });

  const cleanedTempDirectories = await cleanupAbandonedSeparationDirectories(
    options.tempRoot ?? tmpdir(),
    options.processIsAlive ?? isProcessAlive,
  );

  return {
    interruptedJobIds: interrupted.map(({ id }) => id),
    cleanedTempDirectories,
  };
}

export async function recoverPendingLocalWaveformJobs(
  db: ReturnType<typeof drizzle>,
  dispatch: (payload: WaveformJobPayload) => Promise<unknown> = enqueueWaveform,
): Promise<{ resetJobIds: string[]; enqueuedJobIds: string[]; failedJobIds: string[] }> {
  const reset = await db
    .update(waveformJobs)
    .set({
      status: "queued",
      stage: "queued",
      startedAt: null,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(inArray(waveformJobs.status, ["preparing", "processing", "finalizing"]))
    .returning({ id: waveformJobs.id });

  const pending = await db.select().from(waveformJobs).where(eq(waveformJobs.status, "queued"));
  const enqueuedJobIds: string[] = [];
  const failedJobIds: string[] = [];

  for (const job of pending) {
    const hasSource = job.sourceAssetId !== null;
    const hasStem = job.stemAssetId !== null;
    if (hasSource === hasStem) {
      await db
        .update(waveformJobs)
        .set({
          status: "failed",
          stage: "invalid-payload",
          errorCode: "invalid_payload",
          errorMessage: "The queued waveform job must reference exactly one source or stem.",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(waveformJobs.id, job.id));
      failedJobIds.push(job.id);
      continue;
    }

    const payload: WaveformJobPayload = {
      waveformJobId: job.id,
      projectId: job.projectId,
      ...(job.sourceAssetId ? { sourceAssetId: job.sourceAssetId } : {}),
      ...(job.stemAssetId ? { stemAssetId: job.stemAssetId } : {}),
    };
    try {
      await dispatch(payload);
      enqueuedJobIds.push(job.id);
    } catch (error) {
      await db
        .update(waveformJobs)
        .set({
          status: "failed",
          stage: "queue-unavailable",
          errorCode: "queue_unavailable",
          errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(waveformJobs.id, job.id));
      failedJobIds.push(job.id);
    }
  }

  return {
    resetJobIds: reset.map(({ id }) => id),
    enqueuedJobIds,
    failedJobIds,
  };
}
