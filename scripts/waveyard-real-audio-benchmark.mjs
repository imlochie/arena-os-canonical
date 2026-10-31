import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir, type as osType } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testPath = join(
  workspaceRoot,
  "lib/arena/src/lib/waveyard/worker-local/separation-real-ort.test.ts",
);
const tsxCli = join(workspaceRoot, "scripts/node_modules/tsx/dist/cli.mjs");
const inputPath =
  process.env.WAVEYARD_REAL_AUDIO_INPUT?.trim() ||
  process.env.WAVEYARD_REAL_AUDIO_WAV?.trim();
const reportPath = resolve(
  process.env.WAVEYARD_REAL_AUDIO_REPORT?.trim() ||
    "generated-artifacts/waveyard-real-audio-benchmark.json",
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

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  const minimum = sorted[0];
  const maximum = sorted.at(-1);
  return {
    median: Number(median.toFixed(1)),
    minimum,
    maximum,
    range: Number((maximum - minimum).toFixed(1)),
  };
}

function summarizeStageTotals(modeRuns) {
  const stageNames = Object.keys(modeRuns[0].timings.inferenceStageTotals);
  return Object.fromEntries(
    stageNames.map((stage) => [
      stage,
      summarize(modeRuns.map((run) => run.timings.inferenceStageTotals[stage])),
    ]),
  );
}

function summarizeModelStages(modeRuns) {
  const modelIds = modeRuns[0].timings.modelInferenceStages.map((entry) => entry.model);
  return Object.fromEntries(
    modelIds.map((model) => {
      const keys = Object.keys(
        modeRuns[0].timings.modelInferenceStages.find((entry) => entry.model === model).timings,
      );
      return [
        model,
        Object.fromEntries(
          keys.map((stage) => [
            stage,
            summarize(
              modeRuns.map((run) =>
                run.timings.modelInferenceStages.find((entry) => entry.model === model).timings[stage],
              ),
            ),
          ]),
        ),
      ];
    }),
  );
}

async function measure(mode, repetition, order) {
  const reportFile = join(intermediateDirectory, `${repetition}-${mode}.json`);
  const configuration = settings[mode];
  const env = {
    ...process.env,
    WAVEYARD_REAL_AUDIO_BENCHMARK_CHILD: "1",
    WAVEYARD_REAL_AUDIO_BENCHMARK_CPU_ONLY: "1",
    WAVEYARD_ORT_EXECUTION_MODE: mode,
    WAVEYARD_ORT_INTRA_OP_THREADS: String(configuration.intraOpThreads),
    WAVEYARD_ORT_INTER_OP_THREADS: String(configuration.interOpThreads),
    WAVEYARD_REAL_AUDIO_REPORT: reportFile,
  };
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

  const inputIdentity = {
    filename: basename(runs[0].input.filename),
    sha256: runs[0].input.sha256,
    processedStartSeconds: runs[0].input.processedStartSeconds,
    processedDurationSeconds: runs[0].input.processedDurationSeconds,
    sampleRate: runs[0].input.sampleRate,
    channels: runs[0].input.channels,
    models: runs[0].models,
  };
  for (const run of runs) {
    assert.deepEqual(
      {
        filename: basename(run.input.filename),
        sha256: run.input.sha256,
        processedStartSeconds: run.input.processedStartSeconds,
        processedDurationSeconds: run.input.processedDurationSeconds,
        sampleRate: run.input.sampleRate,
        channels: run.input.channels,
        models: run.models,
      },
      inputIdentity,
      "Every paired run must use the same excerpt and pinned model checksums.",
    );
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
    summary,
    runs,
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
