import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

import { processingJobs } from "@workspace/db/waveyardSchema";

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
