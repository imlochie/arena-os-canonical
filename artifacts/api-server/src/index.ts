import app from "./app";
import { logger } from "./lib/logger";
import {
  startLocalWorker,
  drainLocalWorker,
  recoverInterruptedLocalSeparationJobs,
  recoverPendingLocalWaveformJobs,
  cleanupOrphanedSourceObjects,
} from "@workspace/arena/lib/waveyard/worker-local";
import { db, pool } from "@workspace/db";
import { closeAllBrowserSessions } from "@workspace/arena/lib/spaces/browser";
import { runWaveyardStartupRecovery } from "./lib/waveyard-startup-recovery";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// The Express runtime must register the same real processors as the desktop
// runtime before accepting uploads. Policy keeps hosted Redis deployments out.
const worker = startLocalWorker();
if (worker) {
  // The in-memory broker and worker threads belonged to the previous API
  // process. Mark its jobs retryable and remove only their abandoned temp dirs.
  const { recovery, waveformRecovery } = await runWaveyardStartupRecovery(
    async () => {
      const recovery = await recoverInterruptedLocalSeparationJobs(db);
      const waveformRecovery = await recoverPendingLocalWaveformJobs(db);
      return { recovery, waveformRecovery };
    },
    {
      onRetry: (error, attempt, delayMs) => logger.warn({
        attempt,
        delayMs,
        error,
      }, "Transient database connection failure during Waveyard startup recovery; retrying"),
    },
  );
  let removedOrphanSourceObjects = 0;
  try {
    const removed = await runWaveyardStartupRecovery(
      cleanupOrphanedSourceObjects,
      {
        onRetry: (error, attempt, delayMs) => logger.warn({
          attempt,
          delayMs,
          error,
        }, "Transient database connection failure during Waveyard source cleanup; retrying"),
      },
    );
    removedOrphanSourceObjects = removed.length;
  } catch (error) {
    logger.warn({ error }, "Waveyard source cleanup failed; continuing startup without deleting additional files");
  }
  logger.info({
    queues: worker.registeredQueues(),
    interrupted: recovery.interruptedJobIds.length,
    cleanedTempDirectories: recovery.cleanedTempDirectories.length,
    requeuedWaveforms: waveformRecovery.requeuedJobIds.length,
    failedWaveformRequeues: waveformRecovery.failedJobIds.length,
    resetWaveforms: waveformRecovery.resetJobIds.length,
    enqueuedWaveforms: waveformRecovery.enqueuedJobIds.length,
    waveformQueueFailures: waveformRecovery.failedJobIds.length,
    removedOrphanSourceObjects,
  }, "Waveyard local processors ready");
}


if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

if (process.env.ARENA_DESKTOP_MODE === "1") {
  // The old process is gone. Preserve its journal and make interrupted tasks
  // resumable; never silently rerun an in-flight interaction.
  await pool.query("update space_missions set status='checkpointed', status_detail='The desktop app restarted. Review the saved journal, then resume.', updated_at=now() where status='running'");
}

const server = app.listen(port, process.env.ARENA_DESKTOP_MODE === "1" ? "127.0.0.1" : "0.0.0.0", () => {
  logger.info({ port }, "Server listening");
});
server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  const deadline = setTimeout(() => process.exit(1), 20_000);
  deadline.unref();
  try {
    const drained = await drainLocalWorker();
    if (!drained) {
      logger.warn(
        "Local worker drain timed out; unfinished separation jobs will be marked interrupted on next start.",
      );
    }
    await closeAllBrowserSessions();
    await pool.end();
  } catch (err) {
    logger.error({ err }, "Error during graceful shutdown");
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
  process.exit(process.exitCode ?? 0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
// Electron on Windows cannot deliver POSIX SIGTERM gracefully. Use IPC first.
process.on("message", (message) => { if (message === "shutdown") void shutdown(); });
