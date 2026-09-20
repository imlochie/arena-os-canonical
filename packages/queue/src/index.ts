import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { SeparationJobPayload } from "@waveyard/types";

export const SEPARATION_QUEUE = "waveyard-separation";
let connection: IORedis | undefined;
let separationQueue: Queue<SeparationJobPayload> | undefined;

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

export async function enqueueSeparation(payload: SeparationJobPayload) {
  return getSeparationQueue().add("separate", payload, {
    jobId: payload.processingJobId,
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
    removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 },
  });
}
