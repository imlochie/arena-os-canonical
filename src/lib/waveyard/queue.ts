/**
 * Waveyard queue — honest enqueue boundary.
 *
 * The original Waveyard web app enqueues processing work directly onto Redis
 * (BullMQ) for the Waveyard worker to execute. Arena OS does not ship bullmq
 * or assume a running Redis: enqueue functions therefore
 *
 *   - enqueue for real when REDIS_URL is set AND bullmq is installed, and
 *   - throw a plain "queue unavailable" error otherwise — which the ported
 *     ingest/analysis code already handles by marking the job row
 *     `failed / queue_unavailable` with the reason, surfaced honestly in the
 *     UI. Nothing is faked: a job that was not enqueued says so.
 *
 * Queue names and payload shapes are identical to the original
 * packages/queue, so a deployed worker (waveyard-worker/) consumes the exact
 * same jobs.
 */

import type {
  ExportJobPayload,
  SeparationJobPayload,
  SourceAnalysisJobPayload,
  DrumAnalysisJobPayload,
  HarmonyAnalysisJobPayload,
  SourceEventAnalysisJobPayload,
  SourceSectionAnalysisJobPayload,
  VocalAnalysisJobPayload,
  WaveformJobPayload,
} from "./types";

export const SEPARATION_QUEUE = "waveyard-separation";
export const WAVEFORM_QUEUE = "waveyard-waveform";
export const SOURCE_ANALYSIS_QUEUE = "waveyard-source-analysis";
export const SOURCE_SECTION_ANALYSIS_QUEUE = "waveyard-source-section-analysis";
export const SOURCE_EVENT_ANALYSIS_QUEUE = "waveyard-source-event-analysis";
export const DRUM_ANALYSIS_QUEUE = "waveyard-drum-analysis";
export const HARMONY_ANALYSIS_QUEUE = "waveyard-harmony-analysis";
export const VOCAL_ANALYSIS_QUEUE = "waveyard-vocal-analysis";
export const EXPORT_QUEUE = "waveyard-export";

export function queueConfigured() {
  return Boolean(process.env.REDIS_URL);
}

function queueUnavailable(): Error {
  return new Error(
    process.env.REDIS_URL
      ? "Queue unavailable: bullmq is not installed in this app install (worker runtime missing)."
      : "Queue unavailable: REDIS_URL is not set — the Waveyard worker is not configured.",
  );
}

/** bullmq is an optional runtime (present only when the worker is deployed),
 *  so it is imported dynamically and typed loosely. */
async function getBull(): Promise<any> {
  if (!process.env.REDIS_URL) throw queueUnavailable();
  try {
    const specifier = "bullmq";
    return await import(/* webpackIgnore: true */ specifier);
  } catch {
    throw queueUnavailable();
  }
}

export type QueueJobLike = {
  retry(): Promise<unknown>;
  remove(): Promise<unknown>;
  getState(): Promise<unknown>;
};

export type QueueLike = {
  getJob(id: string): Promise<QueueJobLike | undefined | null>;
  add(jobName: string, payload: Record<string, unknown>, options: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
};

type QueueHandle = { queue: any; connection: { disconnect(): void } };

async function openQueue(queueName: string): Promise<QueueHandle> {
  const bullmq = await getBull();
  const IORedis = (bullmq as any).IORedis as new (url: string, opts: Record<string, unknown>) => { disconnect(): void };
  const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const queue = new (bullmq as any).Queue(queueName, { connection });
  return { queue, connection };
}

function closeQueue(handle: QueueHandle) {
  return (async () => {
    try {
      await handle.queue.close();
    } finally {
      handle.connection.disconnect();
    }
  })();
}

/** Direct queue access for retry routes. Throws when the worker is not
 *  configured — ported routes catch that and answer honestly (503). */
export async function makeQueueApi(queueName: string): Promise<QueueLike> {
  const handle = await openQueue(queueName);
  return {
    getJob: (id: string) => handle.queue.getJob(id),
    add: (jobName: string, payload: Record<string, unknown>, options: Record<string, unknown>) =>
      handle.queue.add(jobName, payload, options),
    close: () => closeQueue(handle),
  };
}

export async function getSeparationQueue(): Promise<QueueLike> {
  return makeQueueApi(SEPARATION_QUEUE);
}

export async function getWaveformQueue(): Promise<QueueLike> {
  return makeQueueApi(WAVEFORM_QUEUE);
}

export async function getSourceAnalysisQueue(): Promise<QueueLike> {
  return makeQueueApi(SOURCE_ANALYSIS_QUEUE);
}

export async function getSourceSectionAnalysisQueue(): Promise<QueueLike> {
  return makeQueueApi(SOURCE_SECTION_ANALYSIS_QUEUE);
}

export async function getSourceEventAnalysisQueue(): Promise<QueueLike> {
  return makeQueueApi(SOURCE_EVENT_ANALYSIS_QUEUE);
}

export async function getDrumAnalysisQueue(): Promise<QueueLike> {
  return makeQueueApi(DRUM_ANALYSIS_QUEUE);
}

export async function getHarmonyAnalysisQueue(): Promise<QueueLike> {
  return makeQueueApi(HARMONY_ANALYSIS_QUEUE);
}

export async function getVocalAnalysisQueue(): Promise<QueueLike> {
  return makeQueueApi(VOCAL_ANALYSIS_QUEUE);
}

export async function getExportQueue(): Promise<QueueLike> {
  return makeQueueApi(EXPORT_QUEUE);
}

async function enqueue(queueName: string, jobName: string, payload: Record<string, unknown>, jobId: string) {
  const handle = await openQueue(queueName);
  try {
    return await handle.queue.add(jobName, payload, {
      jobId,
      attempts: 2,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 60 * 60 * 24, count: 5000 },
      removeOnFail: { age: 60 * 60 * 24 * 7, count: 5000 },
    });
  } finally {
    await closeQueue(handle);
  }
}

export async function enqueueSeparation(payload: SeparationJobPayload) {
  return enqueue(SEPARATION_QUEUE, "separate", payload as unknown as Record<string, unknown>, payload.processingJobId);
}

export async function enqueueWaveform(payload: WaveformJobPayload) {
  return enqueue(WAVEFORM_QUEUE, "generate", payload as unknown as Record<string, unknown>, payload.waveformJobId);
}

export async function enqueueSourceAnalysis(payload: SourceAnalysisJobPayload) {
  return enqueue(SOURCE_ANALYSIS_QUEUE, "analyze", payload as unknown as Record<string, unknown>, payload.sourceAnalysisId);
}

export async function enqueueSourceSectionAnalysis(payload: SourceSectionAnalysisJobPayload) {
  return enqueue(SOURCE_SECTION_ANALYSIS_QUEUE, "analyze-sections", payload as unknown as Record<string, unknown>, payload.sourceSectionAnalysisId);
}

export async function enqueueSourceEventAnalysis(payload: SourceEventAnalysisJobPayload) {
  return enqueue(SOURCE_EVENT_ANALYSIS_QUEUE, "analyze-events", payload as unknown as Record<string, unknown>, payload.sourceEventAnalysisId);
}

export async function enqueueDrumAnalysis(payload: DrumAnalysisJobPayload) {
  return enqueue(DRUM_ANALYSIS_QUEUE, "analyze-drums", payload as unknown as Record<string, unknown>, payload.drumAnalysisId);
}

export async function enqueueHarmonyAnalysis(payload: HarmonyAnalysisJobPayload) {
  return enqueue(HARMONY_ANALYSIS_QUEUE, "analyze-harmony", payload as unknown as Record<string, unknown>, payload.harmonyAnalysisId);
}

export async function enqueueVocalAnalysis(payload: VocalAnalysisJobPayload) {
  return enqueue(VOCAL_ANALYSIS_QUEUE, "analyze-vocal", payload as unknown as Record<string, unknown>, payload.vocalAnalysisId);
}

export async function enqueueExport(payload: ExportJobPayload) {
  return enqueue(EXPORT_QUEUE, "render", payload as unknown as Record<string, unknown>, payload.exportJobId);
}
