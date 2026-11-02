import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir, type as osType } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertQualityReport, summarizePairedQuality } from "./waveyard-quality-comparison.mjs";
import { createBlindListeningKit } from "./waveyard-blind-listening.mjs";
import {
  summarize,
  summarizeModelStages,
  summarizeStageTotals,
  validatePairedRuns,
} from "./waveyard-benchmark-summary.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testPath = join(
  workspaceRoot,
  "lib/arena/src/lib/waveyard/worker-local/separation-real-ort.test.ts",
);
const tsxCli = join(workspaceRoot, "scripts/node_modules/tsx/dist/cli.mjs");
const inputPath =
  process.env.WAVEYARD_REAL_AUDIO_INPUT?.trim() ||
  process.env.WAVEYARD_REAL_AUDIO_WAV?.trim();
const referenceManifestPath = process.env.WAVEYARD_REAL_AUDIO_REFERENCE_MANIFEST?.trim();
const reportPath = resolve(
  process.env.WAVEYARD_REAL_AUDIO_REPORT?.trim() ||
    "generated-artifacts/waveyard-real-audio-benchmark.json",
);
const listeningDirectory = resolve(
  process.env.WAVEYARD_REAL_AUDIO_LISTENING_DIR?.trim() ||
    join(dirname(reportPath), `${basename(reportPath, ".json")}-blind-listening`),
);
const repetitionText = process.env.WAVEYARD_REAL_AUDIO_BENCHMARK_REPETITIONS?.trim() || "3";
const repetitions = Number(repetitionText);

assert.ok(inputPath, "Set WAVEYARD_REAL_AUDIO_INPUT to the audio file for the paired benchmark.");
assert.ok(
  Number.isInteger(repetitions) && repetitions >= 2 && repetitions <= 10,
  "WAVEYARD_REAL_AUDIO_BENCHMARK_REPETITIONS must be an integer from 2 to 10.",
);

const settings = {
  sequential: { intraOpThreads: 2, interOpThreads: 1 },
  parallel: { intraOpThreads: 1, interOpThreads: 2 },
};
const modes = Object.keys(settings);
const intermediateDirectory = await mkdtemp(join(tmpdir(), "waveyard-paired-benchmark-"));
const runs = [];

async function measure(mode, repetition, order) {
  const reportFile = join(intermediateDirectory, `${repetition}-${mode}.json`);
  const configuration = settings[mode];
  const auditionDirectory =
    repetition === 1 ? join(intermediateDirectory, "blind-listening-source", mode) : undefined;
  const env = {
    ...process.env,
    WAVEYARD_REAL_AUDIO_BENCHMARK_CHILD: "1",
    WAVEYARD_REAL_AUDIO_BENCHMARK_CPU_ONLY: "1",
    WAVEYARD_ORT_EXECUTION_MODE: mode,
    WAVEYARD_ORT_INTRA_OP_THREADS: String(configuration.intraOpThreads),
    WAVEYARD_ORT_INTER_OP_THREADS: String(configuration.interOpThreads),
    WAVEYARD_REAL_AUDIO_REPORT: reportFile,
  };
  if (auditionDirectory) env.WAVEYARD_REAL_AUDIO_AUDITION_DIR = auditionDirectory;
  delete env.WAVEYARD_REAL_AUDIO_BENCHMARK_REPETITIONS;

  console.log(
    `Benchmark repetition ${repetition}/${repetitions}, order ${order}: ${mode} ` +
      `(requested intra/inter ${configuration.intraOpThreads}/${configuration.interOpThreads}, CPU provider)`,
  );
  const child = spawnSync(
    process.execPath,
    [tsxCli, "--test", "--test-name-pattern", "real audio excerpt", testPath],
    {
      cwd: workspaceRoot,
      env,
      stdio: "inherit",
      timeout: 600_000,
    },
  );
  if (child.error) throw child.error;
  assert.equal(child.status, 0, `${mode} repetition ${repetition} failed.`);

  const report = JSON.parse(await readFile(reportFile, "utf8"));
  assert.equal(report.platform, process.platform, "The measurement must report its actual platform.");
  assert.equal(report.requestedDevice, "cpu", "Paired comparisons must use the CPU provider.");
  assert.equal(report.result.resolvedDevice, "cpu", "The CPU provider must be the one actually used.");
  assert.equal(report.ortExecutionMode, mode, "The requested execution mode must actually be applied.");
  assert.equal(
    report.ortIntraOpThreads,
    configuration.intraOpThreads,
    "The requested intra-op setting must not be clamped.",
  );
  assert.equal(
    report.ortInterOpThreads,
    configuration.interOpThreads,
    "The requested inter-op setting must not be clamped.",
  );
  return {
    mode,
    repetition,
    order,
    ...(auditionDirectory ? { auditionDirectory } : {}),
    ...report,
  };
}

try {
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const order = repetition % 2 === 1 ? modes : [...modes].reverse();
    for (const mode of order) {
      runs.push(await measure(mode, repetition, order.join(" then ")));
    }
  }

  validatePairedRuns(runs, modes, repetitions);

  const firstReferenceEvaluation = runs[0].result.referenceEvaluation;
  const inputIdentity = {
    filename: basename(runs[0].input.filename),
    sha256: runs[0].input.sha256,
    processedExcerptSha256: runs[0].input.processedExcerptSha256,
    processedStartSeconds: runs[0].input.processedStartSeconds,
    processedDurationSeconds: runs[0].input.processedDurationSeconds,
    sampleRate: runs[0].input.sampleRate,
    channels: runs[0].input.channels,
    models: runs[0].models,
    referenceEvaluation: firstReferenceEvaluation
      ? {
          dataset: firstReferenceEvaluation.dataset,
          datasetUrl: firstReferenceEvaluation.datasetUrl,
          track: firstReferenceEvaluation.track,
          license: firstReferenceEvaluation.license,
          attribution: firstReferenceEvaluation.attribution,
          referenceSha256: firstReferenceEvaluation.referenceSha256,
        }
      : null,
  };
  assertQualityReport(runs[0]);
  assert.match(
    inputIdentity.processedExcerptSha256,
    /^[a-f0-9]{64}$/i,
    "Every paired comparison needs the checksum of the exact processed excerpt.",
  );
  for (const run of runs) {
    const referenceEvaluation = run.result.referenceEvaluation;
    assert.deepEqual(
      {
        filename: basename(run.input.filename),
        sha256: run.input.sha256,
        processedExcerptSha256: run.input.processedExcerptSha256,
        processedStartSeconds: run.input.processedStartSeconds,
        processedDurationSeconds: run.input.processedDurationSeconds,
        sampleRate: run.input.sampleRate,
        channels: run.input.channels,
        models: run.models,
        referenceEvaluation: referenceEvaluation
          ? {
              dataset: referenceEvaluation.dataset,
              datasetUrl: referenceEvaluation.datasetUrl,
              track: referenceEvaluation.track,
              license: referenceEvaluation.license,
              attribution: referenceEvaluation.attribution,
              referenceSha256: referenceEvaluation.referenceSha256,
            }
          : null,
      },
      inputIdentity,
      "Every paired run must use the same excerpt and pinned model checksums.",
    );
    assertQualityReport(run);
  }

  const summary = Object.fromEntries(
    modes.map((mode) => {
      const modeRuns = runs.filter((run) => run.mode === mode);
      return [
        mode,
        {
          requestedIntraOpThreads: settings[mode].intraOpThreads,
          requestedInterOpThreads: settings[mode].interOpThreads,
          repetitions: modeRuns.length,
          elapsedMs: summarize(modeRuns.map((run) => run.result.elapsedMs)),
          maxPlaybackTimerGapMs: summarize(modeRuns.map((run) => run.timings.maxPlaybackTimerGapMs)),
          inferenceStageTotalsMs: summarizeStageTotals(modeRuns),
          perModelStageMs: summarizeModelStages(modeRuns),
        },
      ];
    }),
  );

  const output = {
    schemaVersion: 1,
    benchmark: "paired four-stem sequential and bounded-parallel CPU comparison",
    measuredMachine: {
      platform: process.platform,
      osType: osType(),
      osRelease: release(),
      architecture: process.arch,
      cpuModel: cpus()[0]?.model ?? null,
      logicalCpuCount: cpus().length,
      nodeVersion: process.version,
    },
    evidenceLimit:
      process.platform === "win32"
        ? "CPU-only Windows results; they do not establish DirectML performance."
        : "Measured on this OS and CPU only; Linux results are not Windows performance evidence.",
    input: inputIdentity,
    pairedOrder: "Alternates which setting runs first on each repetition.",
    qualityComparison: {
      pairedMetricSummaries: summarizePairedQuality(runs),
      interpretation: inputIdentity.referenceEvaluation
        ? "parallelMinusSequential values are paired by repetition. These observed objective scores do not prove equivalence and do not replace listening review; no score threshold is treated as perceptual equivalence."
        : "No aligned reference stems were provided, so objective quality scores are omitted. Listening judgments are separate subjective evidence.",
    },
    summary,
    runs,
  };

  const firstPair = Object.fromEntries(
    modes.map((mode) => [mode, runs.find((run) => run.mode === mode && run.repetition === 1).auditionDirectory]),
  );
  const listeningKit = await createBlindListeningKit({
    outputDirectory: listeningDirectory,
    sourceFilesByMode: firstPair,
    metadata: {
      input: inputIdentity,
      settings,
    },
  });
  output.blindListening = {
    participantPage: listeningKit.participantPage,
    organizerAnswerKey: listeningKit.answerKey,
    pairedRepetition: 1,
    audioSha256: listeningKit.outputChecksums,
    matchedOutputEquality: listeningKit.matchedOutputEquality,
    listenerSample: listeningKit.listenerSample,
    interpretation: listeningKit.matchedOutputEquality.allMatchedOutputsByteIdentical
      ? "Each matched per-stem pair is byte-for-byte identical by SHA-256, so listeners cannot distinguish the settings in these specific clips. No listener responses were collected; this does not establish equivalence on other inputs or runtimes."
      : "The outputs differ in at least one matched stem. No listener responses were collected, so no perceptual conclusion is available.",
  };

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Paired benchmark report saved to ${reportPath}`);
  console.log(
    JSON.stringify(
      Object.fromEntries(
        modes.map((mode) => [
          mode,
          {
            elapsedMs: summary[mode].elapsedMs,
            maxPlaybackTimerGapMs: summary[mode].maxPlaybackTimerGapMs,
            inferenceStageTotalsMs: summary[mode].inferenceStageTotalsMs,
          },
        ]),
      ),
      null,
      2,
    ),
  );
} finally {
  await rm(intermediateDirectory, { recursive: true, force: true });
}
