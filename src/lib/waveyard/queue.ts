/**
 * Waveyard queue — honest enqueue boundary.
 *
 * The original Waveyard web app enqueues processing work directly onto Redis
 * (BullMQ) for the Waveyard worker to execute. Arena OS does the same when
 * REDIS_URL is set; without it, enqueue functions throw a plain
 * "queue unavailable" error — which the ported ingest/analysis code handles
 * by marking the job row `failed / queue_unavailable` with the reason,
 * surfaced honestly in the UI. Nothing is faked: a job that was not enqueued
 * says so.
 *
 * Queue names and payload shapes are identical to the original
 * packages/queue, so the waveyard-worker container (or any worker pointed at
 * the same Redis) consumes the exact same jobs.
 */

import type IORedis from "ioredis";
import { getLocalJobBroker, localWorkerActive } from "./worker-local/broker";
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
  if (localWorkerActive()) return true; // the desktop's in-process executor
  return Boolean(process.env.REDIS_URL);
}

function queueUnavailable(): Error {
  return new Error(
    process.env.REDIS_URL
      ? "Queue unavailable: Redis is not reachable."
      : "Queue unavailable: REDIS_URL is not set — the Waveyard worker is not configured.",
  );
}

/** bullmq and ioredis are real dependencies; they are loaded lazily so the
 *  module never touches Redis unless a call is actually made. */
async function getBull(): Promise<typeof import("bullmq")> {
  if (!process.env.REDIS_URL) throw queueUnavailable();
  return import("bullmq");
}

async function getConnection(): Promise<IORedis> {
  const { default: Redis } = await import("ioredis");
  return new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null,
  });
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

type QueueHandle = { queue: import("bullmq").Queue; connection: IORedis };

async function openQueue(queueName: string): Promise<QueueHandle> {
  const bullmq = await getBull();
  const connection = await getConnection();
  const queue = new bullmq.Queue(queueName, { connection });
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
/**
 * Desktop transport: with ARENA_DESKTOP_MODE=1 and no REDIS_URL, enqueue and
 * queue-API calls route to the in-process LocalJobBroker instead of BullMQ
 * (docs/desktop-runtime-plan.md §5). Job rows keep their exact lifecycle; a
 * queue with no local executor rejects honestly.
 */
function localQueueApi(queueName: string): QueueLike {
  const broker = getLocalJobBroker();
  return {
    getJob: async () => undefined,
    add: async (_jobName: string, payload: Record<string, unknown>, options: Record<string, unknown>) =>
      broker.submit(queueName, String(options.jobId ?? ""), payload),
    close: async () => undefined,
  };
}

export async function makeQueueApi(queueName: string): Promise<QueueLike> {
  if (localWorkerActive()) return localQueueApi(queueName);
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
  if (localWorkerActive()) return getLocalJobBroker().submit(queueName, jobId, payload);
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
