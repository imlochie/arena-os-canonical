/**
 * Local worker bootstrap — desktop mode only (ARENA_DESKTOP_MODE=1 without
 * REDIS_URL). Registers the real local executors on the LocalJobBroker and
 * starts draining. Registered queues are exactly the engines the desktop can
 * run honestly; separation and the Python-only analyses stay unregistered so
 * their enqueues fail loudly with a desktop reason.
 */

import {
  EXPORT_QUEUE,
  SOURCE_ANALYSIS_QUEUE,
  SOURCE_SECTION_ANALYSIS_QUEUE,
  WAVEFORM_QUEUE,
} from "@/lib/waveyard/queue";
import { getLocalJobBroker, localWorkerActive, type LocalJobBroker } from "./broker";
import { handleWaveformJob } from "./waveform";
import { handleSourceAnalysisJob } from "./analysis";
import { handleSectionAnalysisJob } from "./sections";
import { handleExportJob } from "./export";

export { getLocalJobBroker, localWorkerActive, LocalJobBroker };

export function startLocalWorker(): LocalJobBroker | null {
  if (!localWorkerActive()) return null;
  const broker = getLocalJobBroker();
  if (broker.hasHandler(WAVEFORM_QUEUE)) return broker; // idempotent across module graphs
  broker.register(WAVEFORM_QUEUE, handleWaveformJob);
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
