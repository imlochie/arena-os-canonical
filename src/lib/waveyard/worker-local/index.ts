/**
 * Local worker bootstrap — desktop mode only (ARENA_DESKTOP_MODE=1 without
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
} from "@/lib/waveyard/queue";
import { getLocalJobBroker, localWorkerActive, type LocalJobBroker } from "./broker";
import { handleWaveformJob } from "./waveform";
import { handleSeparationJob } from "./separation";
import { handleSourceAnalysisJob } from "./analysis";
import { handleSectionAnalysisJob } from "./sections";
import { handleExportJob } from "./export";

export { getLocalJobBroker, localWorkerActive };
export type { LocalJobBroker };

export function startLocalWorker(): LocalJobBroker | null {
  if (!localWorkerActive()) return null;
  const broker = getLocalJobBroker();
  if (broker.hasHandler(WAVEFORM_QUEUE)) return broker; // idempotent across module graphs
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
