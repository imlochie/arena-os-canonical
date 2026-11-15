import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { analyzeHarmonicCandidate } from "../lib/arena/src/lib/waveyard/worker-local/harmonic-candidate";

if (!parentPort) throw new Error("Candidate worker must run in a worker thread.");
const pcm = new Float32Array(workerData.pcm as ArrayBuffer);
const rssBeforeBytes = process.memoryUsage().rss;
const started = performance.now();
const analysis = analyzeHarmonicCandidate(pcm);
const runtimeMs = performance.now() - started;
parentPort.postMessage({
  runtimeMs,
  rssBeforeBytes,
  rssAfterBytes: process.memoryUsage().rss,
  events: analysis.events,
  tuning: analysis.tuning,
  diagnostics: analysis.diagnostics,
  hypotheses: analysis.hypotheses,
});
