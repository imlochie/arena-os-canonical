import { Worker } from "bullmq";
import {
  DRUM_ANALYSIS_QUEUE,
  EXPORT_QUEUE,
  HARMONY_ANALYSIS_QUEUE,
  getQueueConnection,
  SEPARATION_QUEUE,
  SOURCE_ANALYSIS_QUEUE,
  SOURCE_EVENT_ANALYSIS_QUEUE,
  SOURCE_SECTION_ANALYSIS_QUEUE,
  VOCAL_ANALYSIS_QUEUE,
  WAVEFORM_QUEUE,
} from "@waveyard/queue";
import type {
  DrumAnalysisJobPayload,
  ExportJobPayload,
  HarmonyAnalysisJobPayload,
  SeparationJobPayload,
  SourceAnalysisJobPayload,
  SourceEventAnalysisJobPayload,
  SourceSectionAnalysisJobPayload,
  VocalAnalysisJobPayload,
  WaveformJobPayload,
} from "@waveyard/types";
import { processDrumAnalysis } from "./drums";
import { processExport } from "./export";
import { processHarmonyAnalysis } from "./harmony";
import { processSeparation } from "./separation";
import { processSourceAnalysis } from "./analysis";
import { processSourceEventAnalysis } from "./events";
import { processSourceSectionAnalysis } from "./sections";
import { processVocalAnalysis } from "./vocal";
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
const sourceSectionAnalysisWorker = new Worker<SourceSectionAnalysisJobPayload>(SOURCE_SECTION_ANALYSIS_QUEUE, async (job) => {
  await processSourceSectionAnalysis(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });
const sourceEventAnalysisWorker = new Worker<SourceEventAnalysisJobPayload>(SOURCE_EVENT_ANALYSIS_QUEUE, async (job) => {
  await processSourceEventAnalysis(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });
const vocalAnalysisWorker = new Worker<VocalAnalysisJobPayload>(VOCAL_ANALYSIS_QUEUE, async (job) => {
  await processVocalAnalysis(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });
const harmonyAnalysisWorker = new Worker<HarmonyAnalysisJobPayload>(HARMONY_ANALYSIS_QUEUE, async (job) => {
  await processHarmonyAnalysis(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });
const drumAnalysisWorker = new Worker<DrumAnalysisJobPayload>(DRUM_ANALYSIS_QUEUE, async (job) => {
  await processDrumAnalysis(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });
const exportWorker = new Worker<ExportJobPayload>(EXPORT_QUEUE, async (job) => {
  await processExport(job.data, async (stage) => { await job.updateProgress({ stage }); });
}, { connection: getQueueConnection(), concurrency });

for (const [label, worker] of [["separation", separationWorker], ["waveform", waveformWorker], ["source analysis", sourceAnalysisWorker], ["source section analysis", sourceSectionAnalysisWorker], ["source event analysis", sourceEventAnalysisWorker], ["harmony analysis", harmonyAnalysisWorker], ["drum analysis", drumAnalysisWorker], ["vocal analysis", vocalAnalysisWorker], ["export", exportWorker]] as const) {
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
    sourceSectionAnalysisWorker.close(),
    sourceEventAnalysisWorker.close(),
    harmonyAnalysisWorker.close(),
    drumAnalysisWorker.close(),
    vocalAnalysisWorker.close(),
    exportWorker.close(),
  ]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
