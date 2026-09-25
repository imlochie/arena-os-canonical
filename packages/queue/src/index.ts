import { Queue } from "bullmq";
import IORedis from "ioredis";
import type {
  ExportJobPayload,
  SeparationJobPayload,
  WaveformJobPayload,
} from "@waveyard/types";

export const SEPARATION_QUEUE = "waveyard-separation";
export const WAVEFORM_QUEUE = "waveyard-waveform";
export const EXPORT_QUEUE = "waveyard-export";
export const TEST_FAULTS = [
  "waveform-storage-read",
  "waveform-storage-write",
  "waveform-after-write",
  "waveform-worker-restart",
  "export-render",
] as const;
export type TestFault = (typeof TEST_FAULTS)[number];

const TEST_FAULT_PREFIX = "waveyard:test-fault:";
const TEST_FAULT_EVENT_PREFIX = "waveyard:test-fault-event:";
const TEST_FAULT_TTL_SECONDS = 15 * 60;

let connection: IORedis | undefined;
let separationQueue: Queue<SeparationJobPayload> | undefined;
let waveformQueue: Queue<WaveformJobPayload> | undefined;
let exportQueue: Queue<ExportJobPayload> | undefined;

export function getQueueConnection() {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required to enqueue processing work.");
    connection = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return connection;
}

export function getSeparationQueue() {
  if (!separationQueue)
    separationQueue = new Queue<SeparationJobPayload>(SEPARATION_QUEUE, {
      connection: getQueueConnection(),
    });
  return separationQueue;
}

export function getWaveformQueue() {
  if (!waveformQueue)
    waveformQueue = new Queue<WaveformJobPayload>(WAVEFORM_QUEUE, {
      connection: getQueueConnection(),
    });
  return waveformQueue;
}

export function getExportQueue() {
  if (!exportQueue)
    exportQueue = new Queue<ExportJobPayload>(EXPORT_QUEUE, {
      connection: getQueueConnection(),
    });
  return exportQueue;
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

export async function enqueueExport(payload: ExportJobPayload) {
  return getExportQueue().add("render", payload, {
    jobId: payload.exportJobId,
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
    removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 },
  });
}

/** Test-only hooks are inert unless Compose supplies a per-run token. */
export function testFaultsEnabled() {
  return Boolean(process.env.WAVEYARD_TEST_FAULT_TOKEN);
}

function testFaultKey(fault: TestFault) {
  return `${TEST_FAULT_PREFIX}${fault}`;
}

function testFaultEventKey(fault: TestFault) {
  return `${TEST_FAULT_EVENT_PREFIX}${fault}`;
}

function assertTestFault(fault: string): asserts fault is TestFault {
  if (!(TEST_FAULTS as readonly string[]).includes(fault))
    throw new Error("Unknown test fault.");
}

/** Arms one or more one-time faults for the real worker test gate. */
export async function armTestFault(fault: TestFault, count = 1) {
  if (!testFaultsEnabled()) throw new Error("Test fault injection is disabled.");
  assertTestFault(fault);
  if (!Number.isInteger(count) || count < 1 || count > 4)
    throw new Error("Test fault count must be between 1 and 4.");
  const redis = getQueueConnection();
  await redis.set(testFaultKey(fault), String(count), "EX", TEST_FAULT_TTL_SECONDS);
  await redis.del(testFaultEventKey(fault));
}

/** Atomically consumes a fault so a retry always runs against the real boundary. */
export async function consumeTestFault(fault: TestFault) {
  if (!testFaultsEnabled()) return false;
  assertTestFault(fault);
  const consumed = await getQueueConnection().eval(
    `
      local remaining = tonumber(redis.call("GET", KEYS[1]) or "0")
      if remaining < 1 then return 0 end
      if remaining == 1 then redis.call("DEL", KEYS[1])
      else redis.call("DECR", KEYS[1]) end
      return 1
    `,
    1,
    testFaultKey(fault),
  );
  return consumed === 1;
}

export type TestFaultEvent = {
  fault: TestFault;
  event: string;
  cleanupVerified?: boolean;
  at: string;
};

export async function recordTestFaultEvent(
  event: TestFaultEvent,
): Promise<void> {
  if (!testFaultsEnabled()) return;
  assertTestFault(event.fault);
  const redis = getQueueConnection();
  await redis.rpush(testFaultEventKey(event.fault), JSON.stringify(event));
  await redis.expire(testFaultEventKey(event.fault), TEST_FAULT_TTL_SECONDS);
}

export async function readTestFaultEvents(fault: TestFault) {
  if (!testFaultsEnabled()) throw new Error("Test fault injection is disabled.");
  assertTestFault(fault);
  const values = await getQueueConnection().lrange(testFaultEventKey(fault), 0, -1);
  return values.map((value) => JSON.parse(value) as TestFaultEvent);
}
