/**
 * Local worker bootstrap — whenever the runtime policy says this process
 * owns processing (desktop, dev, or WAVEYARD_LOCAL_WORKER=1; never with
 * REDIS_URL). Registers the real local executors on the LocalJobBroker and
 * starts draining. Registered queues are exactly the engines the desktop
 * can run honestly: waveforms, the in-process MDX-Net stem machine
 * (worker-local/separation.ts — zero setup, no Python), source/section
 * analysis, and export. The Python-only stem analyses (drums, harmony,
 * vocals, events) stay unregistered so their enqueues fail loudly with a
 * desktop reason rather than pretending.
 */

import {
  EXPORT_QUEUE,
  SEPARATION_QUEUE,
  SOURCE_ANALYSIS_QUEUE,
  SOURCE_SECTION_ANALYSIS_QUEUE,
  WAVEFORM_QUEUE,
} from "@workspace/arena/lib/waveyard/queue";
import { getLocalJobBroker, localWorkerActive, type LocalJobBroker } from "./broker";
import {
  cleanupOrphanedWaveformObjects,
  handleWaveformJob,
  isTransientWaveformFailure,
} from "./waveform";
import { cleanupOrphanedSourceObjects } from "./source-cleanup";
import { runStartupCleanup } from "./startup-cleanup";
import { handleSeparationJob } from "./separation";
import { handleSourceAnalysisJob } from "./analysis";
import { handleSectionAnalysisJob } from "./sections";
import { handleExportJob } from "./export";

export { getLocalJobBroker, localWorkerActive };
export { cleanupOrphanedSourceObjects, ORPHAN_SOURCE_GRACE_PERIOD_MS } from "./source-cleanup";
export {
  isStartupCleanupPending,
  runStartupCleanup,
  STARTUP_CLEANUP_MAX_ATTEMPTS,
  STARTUP_CLEANUP_RETRY_DELAYS_MS,
} from "./startup-cleanup";
export {
  cleanupAbandonedAudioRestoreUploadDirectories,
  recoverInterruptedLocalSeparationJobs,
  recoverPendingLocalWaveformJobs,
} from "./recovery";
export type { LocalJobBroker };
export type LocalWorkerCleanupOverrides = {
  waveform?: () => Promise<unknown>;
  source?: () => Promise<unknown>;
};

export function startLocalWorker(cleanupOverrides: LocalWorkerCleanupOverrides = {}): LocalJobBroker | null {
  if (!localWorkerActive()) return null;
  const broker = getLocalJobBroker();
  if (broker.hasHandler(WAVEFORM_QUEUE)) return broker; // idempotent across module graphs
  void runStartupCleanup("waveforms", cleanupOverrides.waveform ?? cleanupOrphanedWaveformObjects, {
    isTransient: isTransientWaveformFailure,
    onRetry: ({ attempt, nextAttempt, maxAttempts, delayMs, error }) => {
      console.warn(
        `Waveform orphan cleanup failed; retrying ${nextAttempt}/${maxAttempts} in ${delayMs}ms after attempt ${attempt}.`,
        error,
      );
    },
    onDeferred: ({ attempts, maxAttempts, error }) => {
      console.warn(
        `Waveform orphan cleanup deferred after ${attempts}/${maxAttempts} attempts; it will be retried after the next worker restart.`,
        error,
      );
    },
  });
  void (cleanupOverrides.source ?? cleanupOrphanedSourceObjects)().catch((error) => {
    console.warn("Source orphan cleanup failed; it will retry after the next worker restart.", error);
  });
  broker.register(WAVEFORM_QUEUE, handleWaveformJob);
  broker.register(SEPARATION_QUEUE, handleSeparationJob);
  broker.register(SOURCE_ANALYSIS_QUEUE, handleSourceAnalysisJob);
  broker.register(SOURCE_SECTION_ANALYSIS_QUEUE, handleSectionAnalysisJob);
  broker.register(EXPORT_QUEUE, handleExportJob);
  return broker;
}

/** Graceful shutdown: wait for in-flight + queued jobs. */
export function drainLocalWorker(timeoutMs = 15_000): Promise<boolean> {
  return getLocalJobBroker().drain(timeoutMs);
}

export function localWorkerStats() {
  if (!localWorkerActive()) return null;
  const broker = getLocalJobBroker();
  return broker.hasHandler(WAVEFORM_QUEUE) ? broker.stats() : null;
}
