import { Worker } from "bullmq";
import {
  EXPORT_QUEUE,
  getQueueConnection,
  SEPARATION_QUEUE,
  SOURCE_ANALYSIS_QUEUE,
  WAVEFORM_QUEUE,
} from "@waveyard/queue";
import type {
  ExportJobPayload,
  SeparationJobPayload,
  SourceAnalysisJobPayload,
  WaveformJobPayload,
} from "@waveyard/types";
import { processExport } from "./export";
import { processSeparation } from "./separation";
import { processSourceAnalysis } from "./analysis";
import { processWaveform } from "./waveform";

const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1));
const separationWorker = new Worker<SeparationJobPayload>(SEPARATION_QUEUE, async (job) => {
  await processSeparation(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });
const waveformWorker = new Worker<WaveformJobPayload>(WAVEFORM_QUEUE, async (job) => {
  await processWaveform(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });
const sourceAnalysisWorker = new Worker<SourceAnalysisJobPayload>(SOURCE_ANALYSIS_QUEUE, async (job) => {
  await processSourceAnalysis(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });
const exportWorker = new Worker<ExportJobPayload>(EXPORT_QUEUE, async (job) => {
  await processExport(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });

for (const [label, worker] of [["separation", separationWorker], ["waveform", waveformWorker], ["source analysis", sourceAnalysisWorker], ["export", exportWorker]] as const) {
  worker.on("ready", () => console.info(`Waveyard ${label} worker ready (concurrency=${concurrency}).`));
  worker.on("completed", (job) => console.info(`${label} job ${job.id} completed.`));
  worker.on("failed", (job, error) => console.error(`${label} job ${job?.id ?? "unknown"} failed: ${error.message}`));
}

async function shutdown(signal: string) {
  console.info(`${signal} received; closing Waveyard workers.`);
  await Promise.all([
    separationWorker.close(),
    waveformWorker.close(),
    sourceAnalysisWorker.close(),
    exportWorker.close(),
  ]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
