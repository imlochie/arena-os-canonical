import { Worker } from "bullmq";
import { getQueueConnection, SEPARATION_QUEUE } from "@waveyard/queue";
import type { SeparationJobPayload } from "@waveyard/types";
import { processSeparation } from "./separation";

const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1));
const worker = new Worker<SeparationJobPayload>(SEPARATION_QUEUE, async (job) => {
  await processSeparation(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });

worker.on("ready", () => console.info(`Waveyard separation worker ready (concurrency=${concurrency}).`));
worker.on("completed", (job) => console.info(`Separation job ${job.id} completed.`));
worker.on("failed", (job, error) => console.error(`Separation job ${job?.id ?? "unknown"} failed: ${error.message}`));

async function shutdown(signal: string) {
  console.info(`${signal} received; closing worker.`);
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
