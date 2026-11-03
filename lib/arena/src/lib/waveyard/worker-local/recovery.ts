import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

import { enqueueWaveform } from "@workspace/arena/lib/waveyard/queue";
import {
  AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX,
  AUDIO_RESTORE_UPLOAD_RETENTION_MS,
} from "@workspace/arena/lib/waveyard/library/audio-restore";
import type { WaveformJobPayload } from "@workspace/arena/lib/waveyard/types";
import { processingJobs, waveformJobs } from "@workspace/db/waveyardSchema";

const SEPARATION_TEMP_PREFIX = "arena-separation-";
const PENDING_WAVEFORM_STATUSES = ["queued", "preparing", "processing", "finalizing"];
const WAVEFORM_RECOVERY_CLAIM_STAGE = "recovery-submitting";
const WAVEFORM_RECOVERY_OWNER_MARKER_PREFIX = "arena-waveform-recovery-owner-";
const LEGACY_WAVEFORM_CLAIM_MAX_AGE_MS = 5 * 60_000;
const activeWaveformRecoveryClaims = new Set<string>();
const waveformRecoveryProcessInstanceId = randomUUID();
let registeredWaveformRecoveryProcess: WaveformRecoveryProcessIdentity | undefined;

export type WaveformRecoveryProcessIdentity = {
  pid: number;
  instanceId: string;
  isProcessAlive(pid: number): boolean;
  instanceIdForPid(pid: number): string | null;
  now(): number;
};

function ownerMarkerPath(pid: number): string {
  return join(tmpdir(), `${WAVEFORM_RECOVERY_OWNER_MARKER_PREFIX}${pid}`);
}

function registerWaveformRecoveryProcess(): WaveformRecoveryProcessIdentity {
  if (registeredWaveformRecoveryProcess) return registeredWaveformRecoveryProcess;
  const markerPath = ownerMarkerPath(process.pid);
  const temporaryMarkerPath = `${markerPath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryMarkerPath, waveformRecoveryProcessInstanceId, { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporaryMarkerPath, markerPath);
  } catch (error) {
    // Windows cannot replace an existing destination with rename. The PID
    // cannot belong to both processes at once, so replacing its stale marker
    // is safe; competing recovery claims are still guarded by the row CAS.
    if (!["EEXIST", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    rmSync(markerPath, { force: true });
    renameSync(temporaryMarkerPath, markerPath);
  }
  process.once("exit", () => {
    try {
      if (readFileSync(markerPath, "utf8") === waveformRecoveryProcessInstanceId) unlinkSync(markerPath);
    } catch { /* Process exit cleanup is best-effort; a reused PID replaces this marker. */ }
  });

  registeredWaveformRecoveryProcess = {
    pid: process.pid,
    instanceId: waveformRecoveryProcessInstanceId,
    isProcessAlive,
    instanceIdForPid(pid) {
      try {
        return readFileSync(ownerMarkerPath(pid), "utf8") || null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    now: Date.now,
  };
  return registeredWaveformRecoveryProcess;
}

function isWaveformRecoveryClaimActive(
  stage: string | null,
  updatedAt: Date | null,
  identity: WaveformRecoveryProcessIdentity,
): boolean {
  if (!stage?.startsWith(`${WAVEFORM_RECOVERY_CLAIM_STAGE}:`)) return false;
  const [, ownerPidText, ownerInstanceId, claimId] = stage.split(":");
  if (!/^\d+$/.test(ownerPidText ?? "")) return false;
  const ownerPid = Number(ownerPidText);
  if (ownerPid === identity.pid) return activeWaveformRecoveryClaims.has(stage);
  if (!identity.isProcessAlive(ownerPid)) return false;
  if (ownerInstanceId && claimId) {
    return identity.instanceIdForPid(ownerPid) === ownerInstanceId;
  }
  // Older versions wrote only a PID and per-claim nonce. They cannot be
  // matched to a process incarnation, so preserve them briefly for rolling
  // restarts, then reclaim even if the OS has reused their PID.
  const ageMs = updatedAt ? identity.now() - updatedAt.getTime() : Number.POSITIVE_INFINITY;
  return ageMs >= 0 && ageMs < LEGACY_WAVEFORM_CLAIM_MAX_AGE_MS;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove only old Waveyard restore upload directories. Upload directories
 * include their creating API PID so an active restore is preserved even when
 * it runs longer than the retention period.
 */
export async function cleanupAbandonedAudioRestoreUploadDirectories(
  root = tmpdir(),
  now = Date.now(),
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
    if (!entry.isDirectory() || !entry.name.startsWith(AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX)) continue;

    const ownerMatch = /^(\d+)-/.exec(entry.name.slice(AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX.length));
    if (ownerMatch && processIsAlive(Number(ownerMatch[1]))) continue;

    const directoryPath = join(root, entry.name);
    let details;
    try {
      details = await stat(directoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (now - details.mtimeMs < AUDIO_RESTORE_UPLOAD_RETENTION_MS) continue;

    await rm(directoryPath, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
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

/**
 * Re-submit waveform work after a local API restart. The database commit and
 * local broker submission are separate operations, so queued rows may never
 * have reached a worker. Active rows are also stale: their old in-memory
 * worker no longer exists after this process starts.
 */
export async function recoverPendingLocalWaveformJobs(
  db: ReturnType<typeof drizzle>,
  enqueue: (payload: WaveformJobPayload) => Promise<unknown> = enqueueWaveform,
  processIdentity?: WaveformRecoveryProcessIdentity,
): Promise<{
  resetJobIds: string[];
  enqueuedJobIds: string[];
  requeuedJobIds: string[];
  failedJobIds: string[];
}> {
  const identity = processIdentity ?? registerWaveformRecoveryProcess();
  const pending = await db
    .select()
    .from(waveformJobs)
    .where(inArray(waveformJobs.status, PENDING_WAVEFORM_STATUSES));
  const resetJobIds: string[] = [];
  const enqueuedJobIds: string[] = [];
  const requeuedJobIds: string[] = [];
  const failedJobIds: string[] = [];

  for (const job of pending) {
    if (isWaveformRecoveryClaimActive(job.stage, job.updatedAt, identity)) continue;
    const recoveryClaimStage = `${WAVEFORM_RECOVERY_CLAIM_STAGE}:${identity.pid}:${identity.instanceId}:${randomUUID()}`;
    activeWaveformRecoveryClaims.add(recoveryClaimStage);
    try {
      const claim = await db.transaction(async (tx) => {
        // Commit a unique claim before enqueue so the worker can update the
        // row while the queue call is in flight. Active claims are not
        // reclaimed; claims owned by a stopped process can be reclaimed on
        // the next recovery pass.
        const [claimed] = await tx
          .update(waveformJobs)
          .set({
            status: "queued",
            stage: recoveryClaimStage,
            errorCode: null,
            errorMessage: null,
            startedAt: null,
            completedAt: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(waveformJobs.id, job.id),
            inArray(waveformJobs.status, PENDING_WAVEFORM_STATUSES),
            eq(waveformJobs.stage, job.stage),
          ))
          .returning();
        if (!claimed) return null;

        const hasSource = claimed.sourceAssetId !== null;
        const hasStem = claimed.stemAssetId !== null;
        if (hasSource === hasStem) {
          await tx
            .update(waveformJobs)
            .set({
              status: "failed",
              stage: "invalid-payload",
              errorCode: "invalid_payload",
              errorMessage: "The queued waveform job must reference exactly one source or stem.",
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(waveformJobs.id, claimed.id));
          return { id: claimed.id, failed: true as const };
        }

        const payload: WaveformJobPayload = {
          waveformJobId: claimed.id,
          projectId: claimed.projectId,
          ...(claimed.sourceAssetId ? { sourceAssetId: claimed.sourceAssetId } : {}),
          ...(claimed.stemAssetId ? { stemAssetId: claimed.stemAssetId } : {}),
        };
        return { id: claimed.id, failed: false as const, payload };
      });
      if (!claim) continue;
      if (job.status !== "queued") resetJobIds.push(claim.id);
      if (claim.failed) {
        failedJobIds.push(claim.id);
        continue;
      }

      let submissionFailed = false;
      try {
        await enqueue(claim.payload);
      } catch (error) {
        const [failed] = await db
          .update(waveformJobs)
          .set({
            status: "failed",
            stage: "queue-unavailable",
            errorCode: "queue_unavailable",
            errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(
            eq(waveformJobs.id, claim.id),
            eq(waveformJobs.status, "queued"),
            eq(waveformJobs.stage, recoveryClaimStage),
          ))
          .returning({ id: waveformJobs.id });
        submissionFailed = Boolean(failed);
      }
      if (submissionFailed) {
        failedJobIds.push(claim.id);
        continue;
      }
      // A rejected acknowledgement can arrive after a worker already finished
      // the claimed job. The guarded failure update affects no row in that
      // case, so report the work as submitted rather than failed.
      enqueuedJobIds.push(claim.id);
      requeuedJobIds.push(claim.id);
    } finally {
      activeWaveformRecoveryClaims.delete(recoveryClaimStage);
    }
  }

  return { resetJobIds, enqueuedJobIds, requeuedJobIds, failedJobIds };
}
