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
const tracksManifestPath = process.env.WAVEYARD_REAL_AUDIO_TRACKS_MANIFEST?.trim();
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

assert.ok(
  tracksManifestPath || inputPath,
  "Set WAVEYARD_REAL_AUDIO_INPUT or WAVEYARD_REAL_AUDIO_TRACKS_MANIFEST for the paired benchmark.",
);
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

async function loadTracks() {
  const manifestDirectory = tracksManifestPath ? dirname(resolve(tracksManifestPath)) : process.cwd();
  const tracksManifest = tracksManifestPath
    ? JSON.parse(await readFile(resolve(tracksManifestPath), "utf8"))
    : null;
  if (tracksManifest) {
    assert.equal(tracksManifest.schemaVersion, 1, "The tracks manifest schemaVersion must be 1.");
  }
  const trackEntries = tracksManifest
    ? tracksManifest.tracks
    : [{ id: "track-1", inputPath, referenceManifestPath }];
  assert.ok(Array.isArray(trackEntries), "The tracks manifest must contain a tracks array.");
  assert.ok(trackEntries.length >= (tracksManifestPath ? 2 : 1), "Multi-track manifests need at least two tracks.");
  assert.ok(trackEntries.length <= 10, "A benchmark may include at most ten tracks.");
  const ids = new Set();
  const tracks = [];
  for (const entry of trackEntries) {
    assert.ok(
      typeof entry.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(entry.id),
      "Every track needs a unique, filesystem-safe id.",
    );
    assert.ok(!ids.has(entry.id), `Duplicate track id: ${entry.id}.`);
    ids.add(entry.id);
    const entryBase = tracksManifestPath ? manifestDirectory : process.cwd();
    assert.ok(typeof entry.inputPath === "string" && entry.inputPath.length > 0, `Track ${entry.id} needs inputPath.`);
    const sourcePath = resolve(entryBase, entry.inputPath);
    const referencePath = entry.referenceManifestPath
      ? resolve(entryBase, entry.referenceManifestPath)
      : undefined;
    assert.ok(!tracksManifestPath || referencePath, `Track ${entry.id} must have aligned reference stems.`);
    const referenceManifest = referencePath
      ? JSON.parse(await readFile(referencePath, "utf8"))
      : null;
    if (entry.startSeconds !== undefined) {
      assert.ok(
        Number.isInteger(entry.startSeconds) && entry.startSeconds >= 0 && entry.startSeconds <= 899,
        `Track ${entry.id} startSeconds must be an integer from 0 to 899.`,
      );
    }
    if (entry.maxSeconds !== undefined) {
      assert.ok(
        Number.isInteger(entry.maxSeconds) && entry.maxSeconds >= 2 && entry.maxSeconds <= 20,
        `Track ${entry.id} maxSeconds must be an integer from 2 to 20.`,
      );
    }
    if (referenceManifest) {
      assert.ok(
        ["dataset", "datasetUrl", "track", "license", "attribution"].every(
          (field) => typeof referenceManifest[field] === "string" && referenceManifest[field].trim(),
        ),
        `Track ${entry.id} reference manifest must identify its dataset, track, license, and attribution.`,
      );
      assert.ok(
        ["vocals", "drums", "bass", "other"].every(
          (stem) => typeof referenceManifest.referenceStems?.[stem] === "string",
        ),
        `Track ${entry.id} reference manifest must provide all four aligned stems.`,
      );
      referenceManifest.referenceStems = Object.fromEntries(
        Object.entries(referenceManifest.referenceStems).map(([stem, path]) => [
          stem,
          resolve(dirname(referencePath), path),
        ]),
      );
    }
    const normalizedReferenceManifestPath = referenceManifest
      ? join(intermediateDirectory, `${entry.id}-references.json`)
      : undefined;
    if (normalizedReferenceManifestPath) {
      await writeFile(normalizedReferenceManifestPath, `${JSON.stringify(referenceManifest, null, 2)}\n`);
    }
    tracks.push({
      id: entry.id,
      label: entry.label ?? referenceManifest?.track ?? entry.id,
      inputPath: sourcePath,
      referenceManifestPath: normalizedReferenceManifestPath,
      startSeconds: entry.startSeconds,
      maxSeconds: entry.maxSeconds,
    });
  }
  return tracks;
}

const tracks = await loadTracks();

async function measure(track, mode, repetition, order) {
  const reportFile = join(intermediateDirectory, `${track.id}-${repetition}-${mode}.json`);
  const configuration = settings[mode];
  const auditionDirectory =
    repetition === 1
      ? join(intermediateDirectory, "blind-listening-source", track.id, mode)
      : undefined;
  const env = {
    ...process.env,
    WAVEYARD_REAL_AUDIO_INPUT: track.inputPath,
    ...(track.referenceManifestPath
      ? { WAVEYARD_REAL_AUDIO_REFERENCE_MANIFEST: track.referenceManifestPath }
      : {}),
    ...(tracksManifestPath
      ? {
          WAVEYARD_REAL_AUDIO_START_SECONDS: String(track.startSeconds ?? 0),
          WAVEYARD_REAL_AUDIO_MAX_SECONDS: String(track.maxSeconds ?? 20),
        }
      : {
          ...(track.startSeconds === undefined
            ? {}
            : { WAVEYARD_REAL_AUDIO_START_SECONDS: String(track.startSeconds) }),
          ...(track.maxSeconds === undefined
            ? {}
            : { WAVEYARD_REAL_AUDIO_MAX_SECONDS: String(track.maxSeconds) }),
        }),
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
    `${track.id}: benchmark repetition ${repetition}/${repetitions}, order ${order}: ${mode} ` +
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
  assert.equal(child.status, 0, `${track.id} ${mode} repetition ${repetition} failed.`);

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
    trackId: track.id,
    trackLabel: track.label,
    mode,
    repetition,
    order,
    ...(auditionDirectory ? { auditionDirectory } : {}),
    ...report,
  };
}

try {
  const trackResults = [];
  for (const track of tracks) {
    const trackRuns = [];
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const order = repetition % 2 === 1 ? modes : [...modes].reverse();
      for (const mode of order) {
        const run = await measure(track, mode, repetition, order.join(" then "));
        runs.push(run);
        trackRuns.push(run);
      }
    }
    validatePairedRuns(trackRuns, modes, repetitions);

    const firstRun = trackRuns[0];
    const reference = firstRun.result.referenceEvaluation;
    assertQualityReport(firstRun);
    assert.ok(
      Array.isArray(firstRun.models) &&
        firstRun.models.length === 4 &&
        firstRun.models.every(
          (model) => typeof model.id === "string" && /^[a-f0-9]{64}$/i.test(model.sha256),
        ),
      `Track ${track.id} must record checksums for all four pinned models.`,
    );
    if (tracksManifestPath) {
      assert.ok(reference, `Track ${track.id} needs an aligned reference evaluation.`);
    }
    const inputIdentity = {
      filename: basename(firstRun.input.filename),
      sha256: firstRun.input.sha256,
      processedExcerptSha256: firstRun.input.processedExcerptSha256,
      processedStartSeconds: firstRun.input.processedStartSeconds,
      processedDurationSeconds: firstRun.input.processedDurationSeconds,
      sampleRate: firstRun.input.sampleRate,
      channels: firstRun.input.channels,
      models: firstRun.models,
      referenceEvaluation: reference
        ? {
            dataset: reference.dataset,
            datasetUrl: reference.datasetUrl,
            track: reference.track,
            license: reference.license,
            attribution: reference.attribution,
            referenceSha256: reference.referenceSha256,
          }
        : null,
    };
    assert.match(inputIdentity.sha256, /^[a-f0-9]{64}$/i, `${track.id} source input needs a SHA-256.`);
    assert.match(
      inputIdentity.processedExcerptSha256,
      /^[a-f0-9]{64}$/i,
      `${track.id} processed excerpt needs a SHA-256.`,
    );
    for (const run of trackRuns) {
      const evaluation = run.result.referenceEvaluation;
      assertQualityReport(run);
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
          referenceEvaluation: evaluation
            ? {
                dataset: evaluation.dataset,
                datasetUrl: evaluation.datasetUrl,
                track: evaluation.track,
                license: evaluation.license,
                attribution: evaluation.attribution,
                referenceSha256: evaluation.referenceSha256,
              }
            : null,
        },
        inputIdentity,
        `Every paired run for ${track.id} must use the same checksummed excerpt, references, and models.`,
      );
    }

    const trackSummary = Object.fromEntries(
      modes.map((mode) => {
        const modeRuns = trackRuns.filter((run) => run.mode === mode);
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
    const pairedMetrics = summarizePairedQuality(
      trackRuns.map(({ trackId: _trackId, trackLabel: _trackLabel, ...run }) => run),
    );
    const firstPair = Object.fromEntries(
      modes.map((mode) => [
        mode,
        trackRuns.find((run) => run.mode === mode && run.repetition === 1).auditionDirectory,
      ]),
    );
    const listeningKit = await createBlindListeningKit({
      outputDirectory: join(listeningDirectory, track.id),
      sourceFilesByMode: firstPair,
      metadata: { trackId: track.id, input: inputIdentity, settings },
    });
    trackResults.push({
      id: track.id,
      label: track.label,
      input: inputIdentity,
      summary: trackSummary,
      qualityComparison: {
        pairedMetricSummaries: pairedMetrics,
        interpretation:
          "parallelMinusSequential values are paired by repetition. Objective scores are not proof of equivalence and do not replace listening review.",
      },
      blindListening: {
        participantPage: listeningKit.participantPage,
        organizerAnswerKey: listeningKit.answerKey,
        pairedRepetition: 1,
        audioSha256: listeningKit.outputChecksums,
        matchedOutputEquality: listeningKit.matchedOutputEquality,
        listenerSample: listeningKit.listenerSample,
        interpretation: listeningKit.matchedOutputEquality.allMatchedOutputsByteIdentical
          ? "Matched per-stem files are byte-for-byte identical for this track and repetition; no listener responses were collected."
          : "At least one matched stem differs; no listener responses were collected.",
      },
    });
  }

  const aggregateSummary = Object.fromEntries(
    modes.map((mode) => {
      const modeRuns = runs.filter((run) => run.mode === mode);
      return [
        mode,
        {
          requestedIntraOpThreads: settings[mode].intraOpThreads,
          requestedInterOpThreads: settings[mode].interOpThreads,
          tracks: tracks.length,
          repetitionsPerTrack: repetitions,
          elapsedMs: summarize(modeRuns.map((run) => run.result.elapsedMs)),
          maxPlaybackTimerGapMs: summarize(modeRuns.map((run) => run.timings.maxPlaybackTimerGapMs)),
          inferenceStageTotalsMs: summarizeStageTotals(modeRuns),
          perModelStageMs: summarizeModelStages(modeRuns),
        },
      ];
    }),
  );
  const output = {
    schemaVersion: 3,
    benchmark: "paired multi-track four-stem sequential and bounded-parallel CPU comparison",
    timingEvidence: {
      completePerModelTimings:
        "Each run's timings.modelInferenceStages comes from the authoritative inference callback and is validated against every pinned model.",
      sampledProgressTimings:
        "Each run's timings.sampledProgressModelPasses is approximate polling data; a pass shorter than the sampling interval may be absent and does not invalidate a run.",
      progressSamplingIntervalMs: 500,
    },
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
    pairedOrder: "Alternates which setting runs first for each repetition within each track.",
    trackCount: tracks.length,
    tracks: trackResults,
    qualityComparison: {
      pairedMetricSummaries: summarizePairedQuality(runs),
      interpretation:
        "Per-track summaries remain visible beside the across-track summary. The pooled summary can conceal track-specific behavior; inspect every track.",
    },
    summary: aggregateSummary,
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
            elapsedMs: aggregateSummary[mode].elapsedMs,
            maxPlaybackTimerGapMs: aggregateSummary[mode].maxPlaybackTimerGapMs,
            inferenceStageTotalsMs: aggregateSummary[mode].inferenceStageTotalsMs,
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
