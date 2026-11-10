import app from "./app";
import { logger } from "./lib/logger";
import {
  startLocalWorker,
  drainLocalWorker,
  recoverInterruptedLocalSeparationJobs,
  recoverPendingLocalWaveformJobs,
  recoverPendingLocalSourceAnalyses,
  recoverPendingLocalSourceSectionAnalyses,
  recoverPendingLocalDrumAnalyses,
  recoverPendingLocalHarmonyAnalyses,
  recoverPendingLocalVocalAnalyses,
  cleanupOrphanedSourceObjects,
  cleanupAbandonedAudioRestoreUploadDirectories,
} from "@workspace/arena/lib/waveyard/worker-local";
import { db, pool } from "@workspace/db";
import { recoverInterruptedAgentBridgeTasks } from "@workspace/arena/lib/modelHub/agentBridge";
import { closeAllBrowserSessions } from "@workspace/arena/lib/spaces/browser";
import {
  runWaveyardStartupRecovery,
  startApiServerAfterBestEffortRestoreUploadCleanup,
  waitForServerListening,
} from "./lib/waveyard-startup-recovery";
import { shutdownAudioCaptures } from "./lib/waveyard/audio-capture-manager";
import {
  startLocalLibraryConversionWorker,
  stopLocalLibraryConversionWorker,
} from "@workspace/arena/lib/waveyard/conversion/jobs";

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
  const { recovery, waveformRecovery, sourceAnalysisRecovery, sectionAnalysisRecovery,
    drumAnalysisRecovery, harmonyAnalysisRecovery, vocalAnalysisRecovery } = await runWaveyardStartupRecovery(
    async () => {
      const recovery = await recoverInterruptedLocalSeparationJobs(db);
      const waveformRecovery = await recoverPendingLocalWaveformJobs(db);
      const sourceAnalysisRecovery = await recoverPendingLocalSourceAnalyses(db);
      const sectionAnalysisRecovery = await recoverPendingLocalSourceSectionAnalyses(db);
      const drumAnalysisRecovery = await recoverPendingLocalDrumAnalyses(db);
      const harmonyAnalysisRecovery = await recoverPendingLocalHarmonyAnalyses(db);
      const vocalAnalysisRecovery = await recoverPendingLocalVocalAnalyses(db);
      return { recovery, waveformRecovery, sourceAnalysisRecovery, sectionAnalysisRecovery,
        drumAnalysisRecovery, harmonyAnalysisRecovery, vocalAnalysisRecovery };
    },
    {
      onRetry: (error, attempt, delayMs) => logger.warn({
        attempt,
        delayMs,
        error,
      }, "Transient database connection failure during Waveyard startup recovery; retrying"),
    },
  );
  logger.info({
    queues: worker.registeredQueues(),
    interrupted: recovery.interruptedJobIds.length,
    cleanedTempDirectories: recovery.cleanedTempDirectories.length,
    requeuedWaveforms: waveformRecovery.requeuedJobIds.length,
    failedWaveformRequeues: waveformRecovery.failedJobIds.length,
    resetWaveforms: waveformRecovery.resetJobIds.length,
    enqueuedWaveforms: waveformRecovery.enqueuedJobIds.length,
    waveformQueueFailures: waveformRecovery.failedJobIds.length,
    requeuedSourceAnalyses: sourceAnalysisRecovery.requeuedJobIds.length,
    failedSourceAnalysisRequeues: sourceAnalysisRecovery.failedJobIds.length,
    requeuedSectionAnalyses: sectionAnalysisRecovery.requeuedJobIds.length,
    failedSectionAnalysisRequeues: sectionAnalysisRecovery.failedJobIds.length,
    requeuedDrumAnalyses: drumAnalysisRecovery.requeuedJobIds.length,
    failedDrumAnalysisRequeues: drumAnalysisRecovery.failedJobIds.length,
    requeuedHarmonyAnalyses: harmonyAnalysisRecovery.requeuedJobIds.length,
    failedHarmonyAnalysisRequeues: harmonyAnalysisRecovery.failedJobIds.length,
    requeuedVocalAnalyses: vocalAnalysisRecovery.requeuedJobIds.length,
    failedVocalAnalysisRequeues: vocalAnalysisRecovery.failedJobIds.length,
  }, "Waveyard local processors ready");
}
await startLocalLibraryConversionWorker();


if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

if (process.env.ARENA_DESKTOP_MODE === "1") {
  // The old process is gone. Preserve mission journals for manual resume and
  // expire bridge requests whose waiting HTTP caller no longer exists.
  await pool.query("update space_missions set status='checkpointed', status_detail='The desktop app restarted. Review the saved journal, then resume.', updated_at=now() where status='running'");
  const interruptedAgentTasks = await recoverInterruptedAgentBridgeTasks(db);
  logger.info({ expiredAgentBridgeTasks: interruptedAgentTasks.length }, "Interrupted agent-bridge tasks expired after desktop restart");
}

let sourceCleanupTask: Promise<void> | undefined;
// Restore uploads can be abandoned in every API mode, so keep this cleanup
// before listen and outside the local-worker conditional.
const server = await startApiServerAfterBestEffortRestoreUploadCleanup(
  () => cleanupAbandonedAudioRestoreUploadDirectories(),
  () => app.listen(port, process.env.ARENA_DESKTOP_MODE === "1" ? "127.0.0.1" : "0.0.0.0", () => {
    logger.info({ port }, "Server listening");
  }),
  {
    onCleanupComplete: (cleanedCount) => logger.info({
      cleanedRestoreUploadDirectories: cleanedCount,
    }, "Abandoned Waveyard restore uploads removed"),
    // Restore cleanup is best-effort; a filesystem issue must not prevent the
    // API from serving requests or restoring audio.
    onCleanupFailure: (error) => logger.warn({ error }, "Abandoned Waveyard restore upload cleanup failed"),
  },
);
if (worker) {
  sourceCleanupTask = waitForServerListening(server)
    .then(async () => {
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
      logger.info({ removedOrphanSourceObjects: removed.length }, "Waveyard source cleanup finished");
    })
    .catch((error) => {
      logger.warn({ error }, "Waveyard source cleanup failed; continuing without deleting additional files");
    });
}
server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 20_000);
  deadline.unref();
  try {
    const serverClosed = new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });

    const captureShutdown = await shutdownAudioCaptures();
    if (captureShutdown.preserved > 0) {
      logger.info(captureShutdown, "Active Waveyard capture was preserved for recovery");
    }
    if (captureShutdown.forced > 0 || captureShutdown.unresponsive > 0) {
      logger.warn(captureShutdown, "A Waveyard capture host required forced shutdown");
    }

    await stopLocalLibraryConversionWorker();
    let serverCloseTimer: NodeJS.Timeout | undefined;
    const requestsDrained = await Promise.race([
      serverClosed.then(() => true),
      new Promise<boolean>((resolve) => {
        serverCloseTimer = setTimeout(() => resolve(false), 8_000);
      }),
    ]);
    if (serverCloseTimer) clearTimeout(serverCloseTimer);
    if (!requestsDrained) logger.warn("HTTP requests did not drain before the shutdown deadline");

    const drained = await drainLocalWorker();
    if (!drained) {
      logger.warn(
        "Local worker drain timed out; unfinished separation jobs will be marked interrupted on next start.",
      );
    }
    if (sourceCleanupTask) await sourceCleanupTask;
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
