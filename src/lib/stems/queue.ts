import { Queue } from "bullmq";
import IORedis from "ioredis";

export type SeparationJobPayload = {
  processingJobId: string;
  projectId: string;
  sourceAssetId: string;
  model: string;
  requestedDevice: "auto" | "cpu" | "cuda";
};

export const STEM_SEPARATION_QUEUE = "arena-stem-separation";
let connection: IORedis | undefined;
let queue: Queue<SeparationJobPayload> | undefined;

export function getStemQueueConnection() {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required for durable stem processing.");
    connection = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
  }
  return connection;
}

export function getStemQueue() {
  if (!queue) queue = new Queue<SeparationJobPayload>(STEM_SEPARATION_QUEUE, { connection: getStemQueueConnection() });
  return queue;
}

export async function enqueueStemSeparation(payload: SeparationJobPayload) {
  return getStemQueue().add("separate", payload, {
    jobId: payload.processingJobId,
    // Failed source work is retained and retried only through the authorized
    // retry endpoint; it never silently turns a terminal DB record into success.
    attempts: 1,
    removeOnComplete: { age: 60 * 60 * 24, count: 1_000 },
    removeOnFail: { age: 60 * 60 * 24 * 7, count: 1_000 },
  });
}

export async function retryStemSeparation(payload: SeparationJobPayload) {
  const queue = getStemQueue();
  const prior = await queue.getJob(payload.processingJobId);
  if (prior && await prior.isFailed()) {
    await prior.retry("failed");
    return;
  }
  await enqueueStemSeparation(payload);
}
