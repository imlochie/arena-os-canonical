import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { SeparationJobPayload, WaveformJobPayload } from "@waveyard/types";

export const SEPARATION_QUEUE = "waveyard-separation";
export const WAVEFORM_QUEUE = "waveyard-waveform";
let connection: IORedis | undefined;
let separationQueue: Queue<SeparationJobPayload> | undefined;
let waveformQueue: Queue<WaveformJobPayload> | undefined;

export function getQueueConnection() {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required to enqueue processing work.");
    connection = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return connection;
}

export function getSeparationQueue() {
  if (!separationQueue) separationQueue = new Queue<SeparationJobPayload>(SEPARATION_QUEUE, { connection: getQueueConnection() });
  return separationQueue;
}

export function getWaveformQueue() {
  if (!waveformQueue) waveformQueue = new Queue<WaveformJobPayload>(WAVEFORM_QUEUE, { connection: getQueueConnection() });
  return waveformQueue;
}

export async function enqueueSeparation(payload: SeparationJobPayload) {
  return getSeparationQueue().add("separate", payload, {
    jobId: payload.processingJobId,
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
    removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 },
  });
}

export async function enqueueWaveform(payload: WaveformJobPayload) {
  return getWaveformQueue().add("generate", payload, {
    jobId: payload.waveformJobId,
    attempts: 2,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 60 * 60 * 24, count: 5000 },
    removeOnFail: { age: 60 * 60 * 24 * 7, count: 5000 },
  });
}
