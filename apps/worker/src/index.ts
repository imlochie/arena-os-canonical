import { Worker } from "bullmq";
import { getQueueConnection, SEPARATION_QUEUE, WAVEFORM_QUEUE } from "@waveyard/queue";
import type { SeparationJobPayload, WaveformJobPayload } from "@waveyard/types";
import { processSeparation } from "./separation";
import { processWaveform } from "./waveform";

const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1));
const separationWorker = new Worker<SeparationJobPayload>(SEPARATION_QUEUE, async (job) => {
  await processSeparation(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });
const waveformWorker = new Worker<WaveformJobPayload>(WAVEFORM_QUEUE, async (job) => {
  await processWaveform(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });

for (const [label, worker] of [["separation", separationWorker], ["waveform", waveformWorker]] as const) {
  worker.on("ready", () => console.info(`Waveyard ${label} worker ready (concurrency=${concurrency}).`));
  worker.on("completed", (job) => console.info(`${label} job ${job.id} completed.`));
  worker.on("failed", (job, error) => console.error(`${label} job ${job?.id ?? "unknown"} failed: ${error.message}`));
}

async function shutdown(signal: string) {
  console.info(`${signal} received; closing Waveyard workers.`);
  await Promise.all([separationWorker.close(), waveformWorker.close()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
