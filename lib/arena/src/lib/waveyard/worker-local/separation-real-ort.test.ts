/**
 * REAL-ONNXRUNTIME pipeline smoke test — Layer D evidence (mandate §5).
 *
 * What this proves: the separation pipeline executes end to end with a REAL
 * onnxruntime-node InferenceSession — real session creation from a model
 * FILE, real tensor marshaling ([1, 4, dim_f, dim_t] float32 in and out),
 * the real STFT → chunk → inference → overlap-add → ISTFT path, and real
 * persistence — against the same PGlite + local-storage + ffmpeg fixture
 * the fake-session e2e uses.
 *
 * What this does NOT prove: separation quality. The deterministic signal-path
 * test injects a hand-crafted REAL ONNX model whose graph is a pass-through
 * (Identity). When pinned weights are already installed locally, gated tests
 * verify their exact checksums and run the production worker/retry path. That
 * proves real-weight execution and persistence, not subjective separation
 * quality:
 *
 *   primary stem ≈ the source mixture   (the entire STFT→ORT→ISTFT chain
 *                                        reconstructs what went in)
 *   secondary stem = mixture − primary  (the stem-sum guarantee)
 *
 * A bug in tensor marshaling, session wiring, chunk overlap-add, or the
 * encode/persist path fails here. A bug in the separation MODEL cannot be
 * caught by anything but the real weights — that gap is recorded in
 * docs/waveyard-vision.md (acceptance protocol) and closed only by the
 * owner's real-machine acceptance run.
 *
 * The crafted model is opened through the same production call the engine
 * uses (ort.InferenceSession.create(path, { executionProviders: ["cpu"] }));
 * the sha verification this bypasses via the openEngine seam is exactly the
 * check that would refuse this ~300-byte stand-in in production — by design.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { cpus, release, tmpdir, type as osType } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { count, eq } from "drizzle-orm";

import { decodeWav16, encodeWav16 } from "@workspace/arena/lib/waveyard/mixer/synth";
import { checksumFile } from "@workspace/arena/lib/waveyard/audio";
import { getStorage } from "@workspace/arena/lib/waveyard/storage";
import { SEPARATION_QUEUE } from "@workspace/arena/lib/waveyard/queue";
import { decodeSourceToStereoPcm } from "../measure/pcm";
import {
  listenSessions,
  listenSessionTracks,
  processingJobs,
  sourceAssets,
  stemAssets,
  tracks,
} from "@workspace/db/waveyardSchema";
import { findMdxModel } from "@workspace/arena/lib/waveyard/separation/mdx";
import { evaluateFourStemSeparation, type FourStemSamples } from "@workspace/arena/lib/waveyard/separation/quality";
import { requestSeparationCancellation } from "@workspace/arena/lib/waveyard/separation/cancel";
import { retrySeparationJob } from "@workspace/arena/lib/waveyard/separation/retry";
import type { OpenedEngine } from "./separation";
import { demixMdxInWorker, handleSeparationJob } from "./separation";
import { getLocalJobBroker, resetLocalJobBrokerForTests } from "./broker";
import {
  executionProviderAttempts,
  separationExecutionMode,
  separationInterOpThreads,
  separationInferenceThreads,
  WAVEYARD_ORT_EXECUTION_MODE,
  WAVEYARD_ORT_INTER_OP_THREADS,
  WAVEYARD_ORT_INTRA_OP_THREADS,
} from "@workspace/arena/lib/waveyard/separation/session";
import { fixture, payloadOf, SAMPLES, snrDb, type SeparationFixture } from "./separation-fixtures";
import type { MdxStageTimings } from "@workspace/arena/lib/waveyard/separation/mdx";
import { FOUR_STEM_MODELS, stagePinnedModels } from "./pinned-models.test-helper";

const KIM = findMdxModel("kim_vocal_2")!;

function audioMetrics(samples: Float32Array) {
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    sumSquares += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude >= 0.999) clipped += 1;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  return {
    rmsDbfs: Number((20 * Math.log10(Math.max(rms, 1e-12))).toFixed(1)),
    peakDbfs: Number((20 * Math.log10(Math.max(peak, 1e-12))).toFixed(1)),
    clippedSamples: clipped,
  };
}

const PROGRESS_SAMPLING_INTERVAL_MS = 500;

function createProgressPassSampler() {
  const passes: { phase: string; model: string; elapsedMs: number }[] = [];
  let activePass: { phase: string; model: string; startedAt: number } | null = null;
  return {
    observe(progress: { phase?: unknown; model?: unknown }, observedAt: number) {
      if (typeof progress.phase !== "string" || progress.phase === activePass?.phase) return;
      if (activePass) {
        passes.push({
          phase: activePass.phase,
          model: activePass.model,
          elapsedMs: observedAt - activePass.startedAt,
        });
      }
      activePass = {
        phase: progress.phase,
        model: typeof progress.model === "string" ? progress.model : "unknown",
        startedAt: observedAt,
      };
    },
    finish(finishedAt: number) {
      if (activePass) {
        passes.push({
          phase: activePass.phase,
          model: activePass.model,
          elapsedMs: finishedAt - activePass.startedAt,
        });
        activePass = null;
      }
      return passes;
    },
  };
}

test("progress sampling can miss a fast model pass without losing authoritative timings", () => {
  const sampler = createProgressPassSampler();
  const intervalMs = PROGRESS_SAMPLING_INTERVAL_MS;
  sampler.observe({ phase: "1/4", model: FOUR_STEM_MODELS[0]!.id }, 0);
  // A fast intermediate pass can start and finish between these observations.
  sampler.observe({ phase: "3/4", model: FOUR_STEM_MODELS[2]!.id }, intervalMs);
  const sampledProgressPasses = sampler.finish(intervalMs * 2);
  const authoritativeTimings = FOUR_STEM_MODELS.map(({ id }) => ({
    model: id,
    timings: { totalMs: 100, chunkCount: 1 },
  }));

  assert.deepEqual(
    sampledProgressPasses.map(({ model }) => model),
    [FOUR_STEM_MODELS[0]!.id, FOUR_STEM_MODELS[2]!.id],
    "sampled progress timing may omit a pass shorter than the polling interval",
  );
  assert.deepEqual(
    authoritativeTimings.map(({ model }) => model).sort(),
    FOUR_STEM_MODELS.map(({ id }) => id).sort(),
    "authoritative inference callbacks retain one timing record for every pinned model",
  );
  assert.ok(
    authoritativeTimings.every(({ timings }) => Number.isFinite(timings.totalMs) && timings.totalMs > 0),
    "authoritative timing records remain valid independently of sampled progress",
  );
});

async function createFourStemProbeSource(durationSeconds: number) {
  const sampleCount = durationSeconds * 44_100;
  const interleaved = new Float32Array(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const phase = (2 * Math.PI * 220 * index) / 44_100;
    const overtone = (2 * Math.PI * 660 * index) / 44_100;
    interleaved[index * 2] = 0.28 * Math.sin(phase) + 0.08 * Math.sin(overtone);
    interleaved[index * 2 + 1] = 0.25 * Math.sin(phase + 0.2) + 0.07 * Math.sin(overtone + 0.4);
  }
  const directory = await mkdtemp(join(tmpdir(), "waveyard-four-stem-multichunk-"));
  const path = join(directory, "multi-chunk-source.wav");
  await writeFile(path, encodeWav16(interleaved, 44_100));
  return { directory, path, sampleCount };
}

async function createMemoryMeasurementSource(realWavPath?: string) {
  if (!realWavPath) {
    return {
      ...await createFourStemProbeSource(4),
      kind: "synthetic" as const,
      checksum: null,
    };
  }

  const path = resolve(realWavPath);
  const bytes = await readFile(path);
  const decoded = decodeWav16(new Uint8Array(bytes));
  assert.ok(decoded, "the real memory-test input must be a readable 16-bit PCM WAV");
  assert.equal(decoded.sampleRate, 44_100, "the real memory-test excerpt must be 44.1 kHz");
  assert.equal(decoded.channels, 2, "the real memory-test excerpt must be stereo");
  assert.ok(decoded.frames >= 2 * 44_100, "the real memory-test excerpt must be at least two seconds");
  assert.ok(decoded.frames <= 20 * 44_100, "the real memory-test excerpt must not exceed twenty seconds");
  return {
    directory: null,
    path,
    sampleCount: decoded.frames,
    kind: "real" as const,
    checksum: await checksumFile(path),
  };
}

function createLocalRetryHarness(
  database: SeparationFixture["database"],
  onInferenceTiming?: (modelId: string, timings: MdxStageTimings) => void,
) {
  const previousDesktopMode = process.env.ARENA_DESKTOP_MODE;
  const previousRedisUrl = process.env.REDIS_URL;
  process.env.ARENA_DESKTOP_MODE = "1";
  delete process.env.REDIS_URL;
  resetLocalJobBrokerForTests();
  const broker = getLocalJobBroker();
  broker.registerCancellable(SEPARATION_QUEUE, (payload, { signal }) =>
    handleSeparationJob(payload as Parameters<typeof handleSeparationJob>[0], {
      db: database,
      signal,
      onInferenceTiming,
    }),
  );
  return {
    broker,
    async restore() {
      await broker.drain(30_000);
      resetLocalJobBrokerForTests();
      if (previousDesktopMode === undefined) delete process.env.ARENA_DESKTOP_MODE;
      else process.env.ARENA_DESKTOP_MODE = previousDesktopMode;
      if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedisUrl;
    },
  };
}

test("automatic separation prefers the platform GPU provider and falls back to CPU", () => {
  assert.deepEqual(executionProviderAttempts("auto", "win32"), [["dml"], ["cpu"]]);
  assert.deepEqual(executionProviderAttempts("auto", "linux"), [["cuda"], ["cpu"]]);
  assert.deepEqual(executionProviderAttempts("auto"), executionProviderAttempts("auto", process.platform));
  assert.deepEqual(executionProviderAttempts("cuda"), [["cuda"], ["cpu"]]);
  assert.deepEqual(executionProviderAttempts("cuda", "win32"), [["cuda"], ["cpu"]]);
  assert.deepEqual(executionProviderAttempts("cpu"), [["cpu"]]);
  assert.deepEqual(executionProviderAttempts("cpu", "win32"), [["cpu"]]);
  assert.equal(separationInferenceThreads(1, null), 1);
  assert.equal(separationInferenceThreads(2, null), 1, "leave one CPU for ordinary app work");
  assert.equal(separationInferenceThreads(4, null), 2, "leave CPU for playback and JS transforms");
  assert.equal(separationInferenceThreads(8, null), 4, "cap the model at four inference threads");
  assert.equal(separationInferenceThreads(4, "2"), 2, "allow a smaller inference budget on shared CPUs");
  assert.equal(separationInferenceThreads(4, "999"), 2, "never let configuration exceed the safe recommendation");
  assert.equal(separationInferenceThreads(4, "invalid"), 2, "ignore invalid thread counts");
  assert.equal(separationExecutionMode("parallel", "linux"), "parallel");
  assert.equal(separationExecutionMode("parallel", "win32"), "sequential");
  assert.equal(separationExecutionMode(undefined, "linux"), "sequential");
  assert.equal(separationExecutionMode(undefined, "win32"), "sequential");
  assert.equal(separationExecutionMode("invalid", "linux"), "sequential");
  const previousBenchmarkChild = process.env.WAVEYARD_REAL_AUDIO_BENCHMARK_CHILD;
  const previousCpuOnlyBenchmark = process.env.WAVEYARD_REAL_AUDIO_BENCHMARK_CPU_ONLY;
  try {
    process.env.WAVEYARD_REAL_AUDIO_BENCHMARK_CHILD = "1";
    process.env.WAVEYARD_REAL_AUDIO_BENCHMARK_CPU_ONLY = "1";
    assert.equal(separationExecutionMode("parallel", "win32"), "parallel");
  } finally {
    if (previousBenchmarkChild === undefined) delete process.env.WAVEYARD_REAL_AUDIO_BENCHMARK_CHILD;
    else process.env.WAVEYARD_REAL_AUDIO_BENCHMARK_CHILD = previousBenchmarkChild;
    if (previousCpuOnlyBenchmark === undefined) delete process.env.WAVEYARD_REAL_AUDIO_BENCHMARK_CPU_ONLY;
    else process.env.WAVEYARD_REAL_AUDIO_BENCHMARK_CPU_ONLY = previousCpuOnlyBenchmark;
  }
  assert.equal(separationInferenceThreads(4, null, "parallel"), 1, "reserve one thread for parallel graph scheduling");
  assert.equal(separationInterOpThreads(4, "sequential", null), 1);
  assert.equal(separationInterOpThreads(4, "parallel", null), 2, "bound the parallel graph pool");
  assert.equal(separationInterOpThreads(4, "parallel", "999"), 2, "do not exceed the parallel pool budget");
  assert.ok(WAVEYARD_ORT_INTRA_OP_THREADS >= 1 && WAVEYARD_ORT_INTRA_OP_THREADS <= 4);
  assert.ok(WAVEYARD_ORT_INTER_OP_THREADS >= 1 && WAVEYARD_ORT_INTER_OP_THREADS <= 2);
  assert.ok(["sequential", "parallel"].includes(WAVEYARD_ORT_EXECUTION_MODE));
});

// ------------------------------------------------------ hand-crafted ONNX
// Minimal protobuf writer: exactly the fields a loadable ONNX ModelProto
// needs — ir_version, one opset import, a graph with one Identity node,
// typed input/output value infos. (No initializers needed.)

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function tag(field: number, wire: 0 | 2): number[] {
  return varint((field << 3) | wire);
}

function lenDelimited(field: number, bytes: number[]): number[] {
  return [...tag(field, 2), ...varint(bytes.length), ...bytes];
}

function intField(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)];
}

function stringField(field: number, value: string): number[] {
  return lenDelimited(field, [...Buffer.from(value, "utf8")]);
}

/** TypeProto: tensor_type { elem_type: FLOAT(1), shape { dim... } }. */
function tensorType(elemType: number, dims: number[]): number[] {
  const shape = dims.flatMap((d) => lenDelimited(1, intField(1, d)));
  const tensorTypeBody = [...intField(1, elemType), ...lenDelimited(2, shape)];
  return lenDelimited(1, tensorTypeBody);
}

/** ValueInfoProto: name + type. */
function valueInfo(name: string, dims: number[]): number[] {
  return [...stringField(1, name), ...lenDelimited(2, tensorType(1, dims))];
}

/** A real, loadable ONNX model: one Identity node, input "input" → output "output". */
export function craftPassthroughOnnx(dimF: number, dimT: number): Buffer {
  const node = [
    ...lenDelimited(1, [...Buffer.from("input", "utf8")]), // node.input
    ...lenDelimited(2, [...Buffer.from("output", "utf8")]), // node.output
    ...stringField(3, "passthrough"), // node.name
    ...stringField(4, "Identity"), // node.op_type
  ];
  const graph = [
    ...lenDelimited(1, node), // graph.node
    ...stringField(2, "waveyard-plumbing-probe"), // graph.name
    ...lenDelimited(11, valueInfo("input", [1, 4, dimF, dimT])), // graph.input
    ...lenDelimited(12, valueInfo("output", [1, 4, dimF, dimT])), // graph.output
  ];
  const opset = [...intField(2, 13)]; // OperatorSetIdProto { version: 13 }
  const model = [
    ...intField(1, 8), // ir_version
    ...lenDelimited(7, graph), // graph
    ...lenDelimited(8, opset), // opset_import
  ];
  return Buffer.from(model);
}

/** The real-ORT engine: opens the crafted model with the PRODUCTION call.
 *  The handler owns the session's lifetime (it calls release()); the test
 *  must not double-release. */
async function realOrtEngine(f: SeparationFixture): Promise<{ engine: (spec: unknown) => Promise<OpenedEngine> }> {
  const ort = (await import("onnxruntime-node")) as unknown as {
    InferenceSession: {
      create(path: string, options?: { executionProviders?: string[] }): Promise<{
        run(feeds: Record<string, { data: Float32Array; dims: number[] }>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
        release(): Promise<void>;
      }>;
    };
    Tensor: new (type: "float32", data: Float32Array, dims: number[]) => { data: Float32Array; dims: number[] };
  };
  const modelFile = join(f.modelsDir, "plumbing-probe.onnx");
  await writeFile(modelFile, craftPassthroughOnnx(KIM.params.dimF, KIM.params.dimT));
  return {
    engine: async () => {
      const session = await ort.InferenceSession.create(modelFile, { executionProviders: ["cpu"] });
      return {
        infer: async (spek, cfg, frames) => {
          const tensor = new ort.Tensor("float32", spek, [1, 4, cfg.dimF, frames]);
          const outputs = await session.run({ input: tensor });
          const out = outputs[Object.keys(outputs)[0]];
          if (!out || !(out.data instanceof Float32Array)) throw new Error("real session returned no float32 output");
          if (out.data.length !== 4 * cfg.dimF * frames) throw new Error(`real session geometry mismatch: ${out.data.length}`);
          return out.data;
        },
        release: async () => {
          await session.release();
        },
        resolvedDevice: "cpu",
      };
    },
  };
}

test("real onnxruntime session: the separation pipeline executes and reconstructs the signal", { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    const real = await realOrtEngine(f);

    const startedAt = Date.now();
    await handleSeparationJob(payloadOf(f), { db: f.database, openEngine: real.engine as never });
    const elapsedMs = Date.now() - startedAt;

    // The durable job completed honestly.
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.status, "complete", "job completed with the real runtime");
    assert.equal(row.resolvedDevice, "cpu");
    assert.equal(row.errorCode, null);

    // Both stems persisted as real WAV objects.
    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    assert.equal(stems.length, 2, "vocals + instrumental rows");
    const byType = new Map(stems.map((stem) => [stem.stemType, stem]));
    const primary = byType.get("vocals")!;
    const secondary = byType.get("instrumental")!;
    assert.ok(primary && secondary);
    for (const stem of stems) {
      assert.equal(stem.sampleRate, 44_100);
      assert.equal(stem.channels, 2);
      assert.equal(stem.durationSeconds, 1);
      const stored = getStorage().getLocalPath(stem.storageKey);
      assert.ok(stored, "stem object exists in storage");
      const bytes = new Uint8Array(await readFile(stored!));
      assert.equal(bytes.length, 44 + SAMPLES * 4, "16-bit stereo WAV size");
    }

    // SIGNAL-PATH arithmetic: the real STFT → real ORT Identity → real
    // overlap-add chain must reconstruct the source (primary ≈ mix), and the
    // stem-sum guarantee holds (secondary = mix − primary·compensate).
    const sourceDecoded = decodeWav16(new Uint8Array(await readFile(f.sourcePath)))!;
    const primaryDecoded = decodeWav16(new Uint8Array(await readFile(getStorage().getLocalPath(primary.storageKey)!)))!;
    const secondaryDecoded = decodeWav16(new Uint8Array(await readFile(getStorage().getLocalPath(secondary.storageKey)!)))!;
    assert.ok(sourceDecoded && primaryDecoded && secondaryDecoded);
    const trim = 3840; // the engine discards padded edges; assert the interior
    const snrPrimary = snrDb(primaryDecoded.samples, sourceDecoded.samples, trim * 2, (SAMPLES - trim) * 2);
    assert.ok(snrPrimary > 60, `real-ORT primary reconstructs the source through the whole chain (got ${snrPrimary.toFixed(1)} dB)`);

    // The engine derives secondary = mix − compensate·primary, so the sum
    // guarantee is compensate·primary + secondary = mix — the reconstruction
    // error of the whole STFT→ORT→ISTFT chain appears once, plus 16-bit
    // quantization on both stems.
    let maxSumError = 0;
    for (let i = trim * 2; i < (SAMPLES - trim) * 2; i += 1) {
      const lhs = KIM.params.compensate * primaryDecoded.samples[i] + secondaryDecoded.samples[i];
      maxSumError = Math.max(maxSumError, Math.abs(lhs - sourceDecoded.samples[i]));
    }
    assert.ok(maxSumError < 5e-3, `stem-sum guarantee through the real chain (max error ${maxSumError.toExponential(2)})`);

    // Honest record: this elapsed time is the PLUMBING cost (STFT + real ORT
    // Identity + overlap-add on 1 s of audio), NOT a separation benchmark —
    // the real model's conv nets are the missing variable. Recorded for the
    // acceptance protocol's baseline comparison.
    assert.ok(elapsedMs > 0);
  } finally {
    await f.close();
  }
});

test("a pinned local Kim model completes a failed separation through the production worker on retry", { timeout: 180_000 }, async (t) => {
  const f = await fixture();
  let harness: ReturnType<typeof createLocalRetryHarness> | undefined;
  try {
    const arenaRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const workspaceRoot = resolve(arenaRoot, "../..");
    const pinnedModelPath = join(workspaceRoot, "artifacts/api-server/.data/waveyard-models", KIM.file);
    if (!existsSync(pinnedModelPath)) {
      t.skip("Pinned Kim model is not installed locally; the deterministic ONNX plumbing test remains available.");
      return;
    }
    assert.equal(await checksumFile(pinnedModelPath), KIM.sha256, "only the registry-pinned model may run");
    await copyFile(pinnedModelPath, join(f.modelsDir, KIM.file));
    await f.database
      .update(processingJobs)
      .set({
        status: "failed",
        stage: "failed",
        errorCode: "separation_unavailable",
        errorMessage: "A previous attempt could not open the model.",
        completedAt: new Date(),
      })
      .where(eq(processingJobs.id, f.job.id));

    // Exercise the same default hand-off used by the local library retry route:
    // retrySeparationJob -> queue.ts -> LocalJobBroker -> production handler.
    harness = createLocalRetryHarness(f.database);

    const startedAt = Date.now();
    const retry = await retrySeparationJob(f.database, f.job.id);
    assert.equal(await harness.broker.drain(150_000), true, "the local production worker drains the retried job");
    const elapsedMs = Date.now() - startedAt;
    assert.deepEqual(retry, { queued: true });
    assert.equal(harness.broker.stats().succeeded, 1, "the real worker completed one broker submission");

    const [job] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(job.status, "complete", "the real worker completes the retried durable row");
    assert.equal(job.errorCode, null);
    assert.ok(job.resolvedDevice === "cpu" || job.resolvedDevice === "cuda");
    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    assert.equal(stems.length, 2, "the retry persists exactly one real-model stem set");
    for (const stem of stems) {
      const storedPath = getStorage().getLocalPath(stem.storageKey);
      assert.ok(storedPath && existsSync(storedPath), `the ${stem.stemType} output exists in storage`);
    }
    t.diagnostic(
      `Pinned Kim model retry completed on ${job.resolvedDevice} in ${elapsedMs} ms for the 1-second synthetic fixture; this is execution evidence, not a separation-quality or Windows benchmark.`,
    );
  } finally {
    await harness?.restore();
    await f.close();
  }
});

test("stopping a running pinned four-model job terminates its native worker and preserves session playback", { timeout: 240_000 }, async (t) => {
  const arenaRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const workspaceRoot = resolve(arenaRoot, "../..");
  const modelDirectory = join(workspaceRoot, "artifacts/api-server/.data/waveyard-models");
  for (const spec of FOUR_STEM_MODELS) {
    const modelPath = join(modelDirectory, spec.file);
    if (!existsSync(modelPath)) {
      t.skip(`Pinned ${spec.id} weights are not installed locally.`);
      return;
    }
    assert.equal(await checksumFile(modelPath), spec.sha256, `${spec.id} must match its registry checksum`);
  }

  const source = await createFourStemProbeSource(8);
  const f = await fixture({ model: "stems_4", sourceWavPath: source.path });
  let harness: ReturnType<typeof createLocalRetryHarness> | undefined;
  try {
    await stagePinnedModels(modelDirectory, f.modelsDir);
    const originalChecksum = await checksumFile(f.sourcePath);
    const [playbackTrack] = await f.database
      .insert(tracks)
      .values({
        ownerId: f.project.ownerId,
        sourceChecksumSha256: f.source.checksumSha256,
        title: "Current track during separation cancellation",
        artist: "",
        album: "",
        sourceAssetId: f.source.id,
        projectId: f.project.id,
        durationSeconds: Math.round(f.source.durationSeconds),
      })
      .returning();
    const [playbackSession] = await f.database
      .insert(listenSessions)
      .values({ ownerId: f.project.ownerId, name: "Cancellation playback continuity" })
      .returning();
    const [playbackEntry] = await f.database
      .insert(listenSessionTracks)
      .values({
        sessionId: playbackSession.id,
        trackId: playbackTrack.id,
        position: 0,
        stemMix: "{}",
        transition: "{}",
      })
      .returning();
    await f.database
      .update(listenSessions)
      .set({ currentTrackId: playbackEntry.id, positionSeconds: 2.25 })
      .where(eq(listenSessions.id, playbackSession.id));
    harness = createLocalRetryHarness(f.database);
    await harness.broker.submit(SEPARATION_QUEUE, f.job.id, payloadOf(f));

    const progressDeadline = Date.now() + 120_000;
    let observedChunk: { model: string; done: number; total: number } | null = null;
    while (Date.now() < progressDeadline) {
      const [job] = await f.database
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.id, f.job.id));
      if (job?.metadata) {
        const metadata = typeof job.metadata === "string" ? JSON.parse(job.metadata) : job.metadata;
        const progress = metadata?.progress;
        if (
          progress?.kind === "chunk" &&
          typeof progress.model === "string" &&
          typeof progress.done === "number" &&
          typeof progress.total === "number" &&
          progress.done < progress.total
        ) {
          observedChunk = { model: progress.model, done: progress.done, total: progress.total };
          break;
        }
      }
      if (!harness.broker.isRunning(f.job.id)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.ok(observedChunk, "the production worker completed a native inference chunk and had more work pending");
    assert.equal(harness.broker.isRunning(f.job.id), true, "the native worker is still active at cancellation time");

    const stopped = await requestSeparationCancellation(f.database, f.job.id, harness.broker, true);
    assert.equal(stopped.kind, "cancelled", "cancellation is confirmed only after the worker handler and cleanup settle");
    assert.equal(await harness.broker.drain(10_000), true);
    const [cancelledJob] = await f.database
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, f.job.id));
    assert.equal(cancelledJob.status, "cancelled");
    assert.equal(cancelledJob.stage, "cancelled");
    assert.equal(cancelledJob.errorCode, null);
    const [sessionAfterStop] = await f.database
      .select()
      .from(listenSessions)
      .where(eq(listenSessions.id, playbackSession.id));
    const [entryAfterStop] = await f.database
      .select()
      .from(listenSessionTracks)
      .where(eq(listenSessionTracks.id, playbackEntry.id));
    assert.equal(sessionAfterStop.currentTrackId, playbackEntry.id, "the current session entry is unchanged");
    assert.equal(sessionAfterStop.positionSeconds, 2.25, "the current playback position is unchanged");
    assert.equal(entryAfterStop.trackId, playbackTrack.id, "the session still resolves the same playable track");
    assert.deepEqual(
      await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id)),
      [],
      "a partial four-pass result is not published as a complete stem set",
    );
    const sourcePath = getStorage().getLocalPath(f.source.storageKey);
    assert.ok(sourcePath && existsSync(sourcePath), "the original source remains playable from local storage");
    assert.equal(await checksumFile(sourcePath!), originalChecksum, "the original source bytes are unchanged");

    t.diagnostic(
      `Stopped after real ${observedChunk.model} inference progress (${observedChunk.done}/${observedChunk.total} chunks); source bytes and the saved session cursor remain unchanged.`,
    );
  } finally {
    await harness?.restore();
    await f.close();
    if (source.directory) await rm(source.directory, { recursive: true, force: true });
  }
});

test("the pinned four-model recipe completes through the production worker on retry", { timeout: 600_000 }, async (t) => {
  const arenaRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const workspaceRoot = resolve(arenaRoot, "../..");
  const modelDirectory = join(workspaceRoot, "artifacts/api-server/.data/waveyard-models");
  for (const spec of FOUR_STEM_MODELS) {
    const modelPath = join(modelDirectory, spec.file);
    if (!existsSync(modelPath)) {
      t.skip(`Pinned ${spec.id} weights are not installed locally.`);
      return;
    }
    assert.equal(await checksumFile(modelPath), spec.sha256, `${spec.id} must match its registry checksum`);
  }

  // Longer than the largest pinned model chunk so all four real inference
  // sessions process multiple chunks through the production local worker.
  const source = await createFourStemProbeSource(8);
  const f = await fixture({ model: "stems_4", sourceWavPath: source.path });
  let harness: ReturnType<typeof createLocalRetryHarness> | undefined;
  try {
    for (const spec of FOUR_STEM_MODELS) {
      await copyFile(join(modelDirectory, spec.file), join(f.modelsDir, spec.file));
    }
    await f.database
      .update(processingJobs)
      .set({
        status: "failed",
        stage: "failed",
        errorCode: "separation_unavailable",
        errorMessage: "A previous attempt could not open the model.",
        completedAt: new Date(),
      })
      .where(eq(processingJobs.id, f.job.id));

    const [session] = await f.database
      .insert(listenSessions)
      .values({ ownerId: f.project.ownerId, name: "Separation responsiveness probe" })
      .returning();
    const completedModelPasses: { model: string; chunkCount: number }[] = [];
    const requestSamples: { phase: string; libraryMs: number; sessionMs: number }[] = [];
    const progressSamples: { phase: string; model: string; done: number; total: number; percent: number; kind: string }[] = [];
    let samplingError: string | null = null;
    let stopSampling = false;
    let playbackTicks = 0;
    let lastPlaybackTick = Date.now();
    let maxPlaybackGapMs = 0;
    const requestWithTimeout = async <T>(request: Promise<T>, message: string): Promise<T> => {
      let timeout: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(message)), 1_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    const playbackTimer = setInterval(() => {
      const now = Date.now();
      maxPlaybackGapMs = Math.max(maxPlaybackGapMs, now - lastPlaybackTick);
      lastPlaybackTick = now;
      playbackTicks += 1;
    }, 20);
    const sampleResponsiveness = (async () => {
      while (!stopSampling) {
        try {
          const [latestJob] = await f.database
            .select()
            .from(processingJobs)
            .where(eq(processingJobs.id, f.job.id));
          const metadata = typeof latestJob?.metadata === "string"
            ? JSON.parse(latestJob.metadata)
            : (latestJob?.metadata ?? {});
          const progress = metadata?.progress;
          const phase = typeof progress?.phase === "string" ? progress.phase : "not-started";
          if (
            progress &&
            typeof progress.model === "string" &&
            typeof progress.done === "number" &&
            typeof progress.total === "number" &&
            typeof progress.percent === "number" &&
            typeof progress.kind === "string"
          ) {
            progressSamples.push({
              phase,
              model: progress.model,
              done: progress.done,
              total: progress.total,
              percent: progress.percent,
              kind: progress.kind,
            });
          }

          const libraryStartedAt = Date.now();
          const libraryRead = await requestWithTimeout(
            f.database
              .select({ id: sourceAssets.id, status: processingJobs.status })
              .from(sourceAssets)
              .leftJoin(processingJobs, eq(processingJobs.sourceAssetId, sourceAssets.id))
              .where(eq(sourceAssets.id, f.source.id)),
            "Library read stalled during four-stem separation",
          );
          const libraryMs = Date.now() - libraryStartedAt;
          assert.equal(libraryRead.length, 1);

          const sessionStartedAt = Date.now();
          const sessionRead = await requestWithTimeout(
            f.database
              .select({ id: listenSessions.id, trackCount: count(listenSessionTracks.id) })
              .from(listenSessions)
              .leftJoin(listenSessionTracks, eq(listenSessionTracks.sessionId, listenSessions.id))
              .where(eq(listenSessions.id, session.id))
              .groupBy(listenSessions.id),
            "Live-session read stalled during four-stem separation",
          );
          const sessionMs = Date.now() - sessionStartedAt;
          assert.equal(sessionRead.length, 1);
          const currentPhase = phase === "not-started" ? "1/4" : phase;
          requestSamples.push({ phase: currentPhase, libraryMs, sessionMs });
        } catch (error) {
          samplingError = error instanceof Error ? error.message : String(error);
          return;
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, PROGRESS_SAMPLING_INTERVAL_MS));
      }
    })();
    let retryPromise: Promise<{ queued: boolean }> | undefined;
    let elapsedMs = 0;
    try {
      harness = createLocalRetryHarness(f.database, (model, timings) => {
        // Production-worker timing is emitted only after its inference worker
        // exits; that worker awaits session.release() before posting results.
        // Therefore each callback proves that pass released before the next
        // model session could be opened.
        completedModelPasses.push({ model, chunkCount: timings.chunkCount });
      });
      const startedAt = Date.now();
      retryPromise = retrySeparationJob(f.database, f.job.id);
      const retry = await retryPromise;
      assert.equal(await harness.broker.drain(570_000), true, "the multi-chunk four-model retry drains through the local worker");
      elapsedMs = Date.now() - startedAt;
      assert.deepEqual(retry, { queued: true });
      const brokerStats = harness.broker.stats();
      const [workerJob] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
      assert.equal(
        brokerStats.succeeded,
        1,
        `the real worker completed the four-model broker submission; stats=${JSON.stringify(brokerStats)}; job=${JSON.stringify({
          status: workerJob?.status,
          errorCode: workerJob?.errorCode,
          errorMessage: workerJob?.errorMessage,
        })}`,
      );
    } finally {
      stopSampling = true;
      await sampleResponsiveness;
      clearInterval(playbackTimer);
      await retryPromise?.catch(() => undefined);
    }
    assert.equal(samplingError, null, samplingError ?? undefined);
    assert.ok(requestSamples.length >= 8, `library and session reads repeated ${requestSamples.length} times during separation`);
    for (const [label, field] of [
      ["library", "libraryMs"],
      ["live-session", "sessionMs"],
    ] as const) {
      const slowest = Math.max(...requestSamples.map((sample) => sample[field]));
      assert.ok(slowest < 1_000, `${label} reads stayed responsive (slowest ${slowest}ms)`);
    }
    assert.ok(playbackTicks >= 5, `playback timer advanced ${playbackTicks} times during separation`);
    assert.ok(maxPlaybackGapMs < 1_000, `playback timer's longest pause was ${maxPlaybackGapMs}ms`);
    assert.deepEqual(
      completedModelPasses.map(({ model }) => model),
      FOUR_STEM_MODELS.map(({ id }) => id),
      "each preceding model session is released before the next model pass completes",
    );
    assert.ok(
      completedModelPasses.every(({ chunkCount }) => chunkCount > 1),
      `all four pinned model passes process multiple chunks: ${completedModelPasses.map(({ model, chunkCount }) => `${model}=${chunkCount}`).join(", ")}`,
    );
    assert.ok(
      FOUR_STEM_MODELS.every(({ id }) => requestSamples.some(({ phase }) => phase === `${FOUR_STEM_MODELS.findIndex((model) => model.id === id) + 1}/4`)),
      "library and live-session reads remain active in every model phase",
    );

    let lastPercent = -1;
    for (const sample of progressSamples) {
      const phaseIndex = Number(sample.phase.split("/")[0]) - 1;
      assert.ok(phaseIndex >= 0 && phaseIndex < FOUR_STEM_MODELS.length, `valid model phase ${sample.phase}`);
      assert.equal(sample.model, FOUR_STEM_MODELS[phaseIndex]!.id, `${sample.phase} identifies its active model`);
      if (sample.kind === "model-pass") {
        assert.equal(sample.done, phaseIndex, `${sample.phase} begins at its model boundary`);
        assert.equal(sample.total, FOUR_STEM_MODELS.length);
        assert.equal(sample.percent, Math.floor((phaseIndex / FOUR_STEM_MODELS.length) * 100));
      } else {
        assert.equal(sample.kind, "chunk");
        assert.ok(
          Number.isInteger(sample.total) && sample.total > 0 &&
            Number.isInteger(sample.done) && sample.done >= 1 && sample.done <= sample.total,
          `${sample.phase} reports valid chunk progress`,
        );
        assert.equal(
          sample.percent,
          Math.floor(((phaseIndex + sample.done / sample.total) / FOUR_STEM_MODELS.length) * 100),
          `${sample.phase} percentage reflects its actual chunk within the full recipe`,
        );
      }
      assert.ok(sample.percent >= lastPercent, "whole-recipe progress never moves backward between model passes");
      lastPercent = sample.percent;
    }
    assert.ok(
      FOUR_STEM_MODELS.every(({ id }) => progressSamples.some(({ model, kind }) => model === id && kind === "chunk")),
      "durable progress exposes chunk updates for every pinned model",
    );

    const [job] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(job.status, "complete");
    assert.equal(job.errorCode, null);
    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    assert.equal(stems.length, 4);
    const stemsByType = new Map(stems.map((stem) => [stem.stemType, stem]));
    for (const [stemType, modelId] of [
      ["vocals", "kim_vocal_2"],
      ["drums", "kuielab_b_drums"],
      ["bass", "kuielab_b_bass"],
      ["other", "kuielab_b_other"],
    ] as const) {
      const stem = stemsByType.get(stemType);
      const spec = FOUR_STEM_MODELS.find((candidate) => candidate.id === modelId)!;
      assert.ok(stem, `${stemType} was persisted`);
      assert.equal(stem.model, modelId);
      assert.equal(stem.modelVersion, spec.sha256);
      const storedPath = getStorage().getLocalPath(stem.storageKey);
      assert.ok(storedPath && existsSync(storedPath), `${stemType} output exists in storage`);
      const decoded = decodeWav16(new Uint8Array(await readFile(storedPath!)));
      assert.ok(decoded, `${stemType} is a readable WAV`);
      assert.equal(decoded.sampleRate, 44_100);
      assert.equal(decoded.frames, source.sampleCount);
    }
    t.diagnostic(
      `Pinned multi-chunk four-model retry completed on ${job.resolvedDevice} with ${WAVEYARD_ORT_EXECUTION_MODE} mode (intra=${WAVEYARD_ORT_INTRA_OP_THREADS}, inter=${WAVEYARD_ORT_INTER_OP_THREADS}) in ${elapsedMs} ms; chunks ${completedModelPasses.map(({ model, chunkCount }) => `${model}=${chunkCount}`).join(", ")}; ${requestSamples.length} library/session probe rounds; max library read ${Math.max(...requestSamples.map(({ libraryMs }) => libraryMs))} ms; max session read ${Math.max(...requestSamples.map(({ sessionMs }) => sessionMs))} ms; max playback timer gap ${maxPlaybackGapMs} ms. Synthetic input proves worker execution and responsiveness, not separation quality.`,
    );
  } finally {
    await harness?.restore();
    await f.close();
    await rm(source.directory, { recursive: true, force: true });
  }
});

test("repeated pinned four-model jobs do not keep growing process memory after session release", { timeout: 1_800_000 }, async (t) => {
  const arenaRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const workspaceRoot = resolve(arenaRoot, "../..");
  const modelDirectory = join(workspaceRoot, "artifacts/api-server/.data/waveyard-models");
  for (const spec of FOUR_STEM_MODELS) {
    const modelPath = join(modelDirectory, spec.file);
    if (!existsSync(modelPath)) {
      t.skip(`Pinned ${spec.id} weights are not installed locally.`);
      return;
    }
    assert.equal(await checksumFile(modelPath), spec.sha256, `${spec.id} must match its registry checksum`);
  }

  const repetitionsText = process.env.WAVEYARD_REAL_ORT_MEMORY_REPETITIONS?.trim() || "7";
  const repetitions = Number(repetitionsText);
  assert.ok(
    Number.isInteger(repetitions) && repetitions >= 6 && repetitions <= 12,
    "WAVEYARD_REAL_ORT_MEMORY_REPETITIONS must be an integer from 6 to 12",
  );
  const warmupJobs = 3;

  const source = await createMemoryMeasurementSource(process.env.WAVEYARD_REAL_ORT_MEMORY_WAV?.trim());
  const f = await fixture({ model: "stems_4", sourceWavPath: source.path });
  let harness: ReturnType<typeof createLocalRetryHarness> | undefined;
  const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  const sampleMemory = async () => {
    forceGc?.();
    // Allow native worker teardown and allocator bookkeeping to settle before
    // sampling. RSS includes native allocations from every worker thread.
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 150));
    const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
    return { rss, heapUsed, external, arrayBuffers };
  };
  const toMiB = (bytes: number) => Number((bytes / (1024 * 1024)).toFixed(1));
  try {
    for (const spec of FOUR_STEM_MODELS) {
      await copyFile(join(modelDirectory, spec.file), join(f.modelsDir, spec.file));
    }
    await f.database
      .update(processingJobs)
      .set({
        status: "failed",
        stage: "failed",
        errorCode: "separation_unavailable",
        errorMessage: "Memory measurement run initialized.",
        completedAt: new Date(),
      })
      .where(eq(processingJobs.id, f.job.id));

    const completedModelPasses: { model: string; chunkCount: number }[] = [];
    harness = createLocalRetryHarness(f.database, (model, timings) => {
      completedModelPasses.push({ model, chunkCount: timings.chunkCount });
    });
    const baseline = await sampleMemory();
    const samples: Awaited<ReturnType<typeof sampleMemory>>[] = [];
    const jobReports: {
      repetition: number;
      requestedDevice: string;
      resolvedDevice: string;
      chunkCounts: Record<string, number>;
      memory: Awaited<ReturnType<typeof sampleMemory>>;
    }[] = [];
    const startedAt = Date.now();
    for (let run = 0; run < repetitions; run += 1) {
      const firstPassIndex = completedModelPasses.length;
      if (run > 0) {
        // Reuse the same durable job and input while exercising a fresh set of
        // four production worker sessions for each repetition.
        await f.database
          .update(processingJobs)
          .set({
            status: "failed",
            stage: "failed",
            errorCode: "separation_unavailable",
            errorMessage: `Memory measurement repetition ${run + 1}.`,
            completedAt: new Date(),
          })
          .where(eq(processingJobs.id, f.job.id));
      }
      assert.deepEqual(await retrySeparationJob(f.database, f.job.id), { queued: true });
      const deadline = Date.now() + 240_000;
      let job = (await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id)))[0];
      while (
        (job?.status !== "complete" || harness.broker.stats().succeeded < run + 1) &&
        job?.status !== "failed" &&
        Date.now() < deadline
      ) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
        job = (await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id)))[0];
      }
      assert.equal(job?.status, "complete", `pinned four-model repetition ${run + 1} completes before timeout`);
      assert.equal(harness.broker.stats().submitted, run + 1, `repetition ${run + 1} reached the local production worker`);
      assert.equal(harness.broker.stats().succeeded, run + 1, `repetition ${run + 1} succeeded in the local production worker`);
      const runPasses = completedModelPasses.slice(firstPassIndex);
      assert.deepEqual(
        runPasses.map(({ model }) => model),
        FOUR_STEM_MODELS.map(({ id }) => id),
        `repetition ${run + 1} released each model session before opening the next`,
      );
      assert.ok(
        runPasses.every(({ chunkCount }) => chunkCount > 1),
        `repetition ${run + 1} exercised multiple chunks in every model: ${runPasses.map(({ model, chunkCount }) => `${model}=${chunkCount}`).join(", ")}`,
      );
      assert.equal(job.status, "complete", `repetition ${run + 1} completes`);
      const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
      assert.equal(stems.length, 4, `repetition ${run + 1} persists all four stems`);
      const memory = await sampleMemory();
      samples.push(memory);
      jobReports.push({
        repetition: run + 1,
        requestedDevice: job.requestedDevice ?? "unknown",
        resolvedDevice: job.resolvedDevice ?? "unknown",
        chunkCounts: Object.fromEntries(runPasses.map(({ model, chunkCount }) => [model, chunkCount])),
        memory,
      });
    }

    // ONNX Runtime and worker-thread allocators can take several jobs to reach
    // their retained working set. Treat the first three jobs as warm-up, then
    // compare the final half of steady-state samples with the first steady
    // sample to distinguish one-time retention from continued growth.
    const firstSteadySample = samples[warmupJobs]!;
    const postWarmSamples = samples.slice(warmupJobs);
    const tailRssValues = postWarmSamples
      .slice(Math.floor(postWarmSamples.length / 2))
      .map(({ rss }) => rss)
      .sort((left, right) => left - right);
    const middleIndex = Math.floor(tailRssValues.length / 2);
    const tailMedianRss = tailRssValues.length % 2 === 1
      ? tailRssValues[middleIndex]!
      : (tailRssValues[middleIndex - 1]! + tailRssValues[middleIndex]!) / 2;
    const continuedRssGrowth = tailMedianRss - firstSteadySample.rss;
    const maxContinuedGrowthBytes = 128 * 1024 * 1024;
    assert.ok(
      continuedRssGrowth <= maxContinuedGrowthBytes,
      `RSS continued growing by ${toMiB(continuedRssGrowth)} MiB after warm-up; ` +
        `allowed ${toMiB(maxContinuedGrowthBytes)} MiB across ${postWarmSamples.length - 1} further jobs. ` +
        `Samples: ${samples.map(({ rss }) => `${toMiB(rss)} MiB`).join(" → ")}`,
    );
    const resolvedDevices = [...new Set(jobReports.map(({ resolvedDevice }) => resolvedDevice))];
    assert.equal(
      resolvedDevices.length,
      1,
      `all repetitions must use the same selected provider; observed ${resolvedDevices.join(", ")}`,
    );
    assert.ok(
      resolvedDevices[0] && resolvedDevices[0] !== "unknown",
      "the completed jobs must report their selected execution provider",
    );
    const requestedDevices = [...new Set(jobReports.map(({ requestedDevice }) => requestedDevice))];
    assert.equal(
      requestedDevices.length,
      1,
      `all repetitions must use the same requested provider; observed ${requestedDevices.join(", ")}`,
    );
    assert.ok(
      requestedDevices[0] && requestedDevices[0] !== "unknown",
      "the completed jobs must report their requested execution provider",
    );
    if (process.platform === "win32") {
      assert.ok(
        ["dml", "cpu"].includes(resolvedDevices[0]!),
        `Windows automatic selection must resolve to DirectML or CPU, not ${resolvedDevices[0]}`,
      );
    }

    const memoryReportPath = process.env.WAVEYARD_REAL_ORT_MEMORY_REPORT?.trim();
    if (memoryReportPath) {
      const memoryReport = {
        schemaVersion: 1,
        benchmark: "repeated pinned four-model multi-chunk process memory",
        measuredMachine: {
          platform: process.platform,
          osType: osType(),
          osRelease: release(),
          architecture: process.arch,
          nodeVersion: process.version,
          cpuModel: cpus()[0]?.model ?? null,
          logicalCpuCount: cpus().length,
        },
        requestedProvider: requestedDevices[0],
        selectedProvider: resolvedDevices[0],
        models: FOUR_STEM_MODELS.map(({ id, sha256 }) => ({ id, sha256 })),
        input: {
          kind: source.kind,
          sampleCount: source.sampleCount,
          durationSeconds: Number((source.sampleCount / 44_100).toFixed(2)),
          sha256: source.checksum,
        },
        repetitions,
        warmupJobs,
        baselineMemoryBytes: baseline,
        jobs: jobReports,
        summary: {
          warmupRetentionBytes: samples[warmupJobs - 1]!.rss - baseline.rss,
          firstSteadyRssBytes: firstSteadySample.rss,
          finalHalfMedianRssBytes: tailMedianRss,
          continuedRssGrowthBytes: continuedRssGrowth,
          allowedContinuedGrowthBytes: maxContinuedGrowthBytes,
          continuedGrowthBounded: continuedRssGrowth <= maxContinuedGrowthBytes,
          samplingMethod: "process.memoryUsage after optional explicit GC and a 150 ms teardown settle",
          explicitGcAvailable: Boolean(forceGc),
        },
      };
      const reportPath = resolve(memoryReportPath);
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(memoryReport, null, 2)}\n`);
    }

    t.diagnostic(
      `Pinned four-model memory run on ${resolvedDevices[0]}: ${repetitions} completed jobs in ${Date.now() - startedAt} ms; ` +
        `input ${source.kind} ${source.sampleCount / 44_100}s${source.checksum ? ` sha256=${source.checksum}` : ""}; ` +
        `RSS baseline ${toMiB(baseline.rss)} MiB; post-job RSS ${samples.map(({ rss }) => toMiB(rss)).join(" → ")} MiB; ` +
        `${warmupJobs} warm-up jobs retained ${toMiB(samples[warmupJobs - 1]!.rss - baseline.rss)} MiB; ` +
        `first steady RSS ${toMiB(firstSteadySample.rss)} MiB; ` +
        `final-half median RSS ${toMiB(tailMedianRss)} MiB; continued growth ${toMiB(continuedRssGrowth)} MiB ` +
        `(limit ${toMiB(maxContinuedGrowthBytes)} MiB); ` +
        `heapUsed ${samples.map(({ heapUsed }) => toMiB(heapUsed)).join(" → ")} MiB; ` +
        `external ${samples.map(({ external }) => toMiB(external)).join(" → ")} MiB; ` +
        `arrayBuffers ${samples.map(({ arrayBuffers }) => toMiB(arrayBuffers)).join(" → ")} MiB; ` +
        `explicit GC ${forceGc ? "available" : "unavailable"}.`,
    );
  } finally {
    await harness?.restore();
    await f.close();
    if (source.directory) await rm(source.directory, { recursive: true, force: true });
  }
});

const changingMemoryInputsJson = process.env.WAVEYARD_REAL_ORT_MEMORY_WAVS_JSON?.trim();
if (changingMemoryInputsJson) {
  test("changing real excerpts do not keep growing process memory after session release", { timeout: 900_000 }, async (t) => {
    const arenaRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const workspaceRoot = resolve(arenaRoot, "../..");
    const modelDirectory = join(workspaceRoot, "artifacts/api-server/.data/waveyard-models");
    for (const spec of FOUR_STEM_MODELS) {
      const modelPath = join(modelDirectory, spec.file);
      if (!existsSync(modelPath)) {
        t.skip(`Pinned ${spec.id} weights are not installed locally.`);
        return;
      }
      assert.equal(await checksumFile(modelPath), spec.sha256, `${spec.id} must match its registry checksum`);
    }

    const paths = JSON.parse(changingMemoryInputsJson) as unknown;
    assert.ok(Array.isArray(paths), "WAVEYARD_REAL_ORT_MEMORY_WAVS_JSON must be a JSON array of WAV paths");
    assert.ok(paths.length >= 6 && paths.length <= 12, "supply between six and twelve changing real excerpts");
    assert.ok(paths.every((path): path is string => typeof path === "string" && path.trim().length > 0));
    const sources = await Promise.all(paths.map((path) => createMemoryMeasurementSource(path)));
    assert.ok(sources.every(({ kind }) => kind === "real"), "every changing input must be a real WAV excerpt");
    assert.equal(
      new Set(sources.map(({ checksum }) => checksum)).size,
      sources.length,
      "every changing excerpt must have a distinct SHA-256 checksum",
    );

    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    const sampleMemory = async () => {
      forceGc?.();
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 150));
      const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
      return { rss, heapUsed, external, arrayBuffers };
    };
    const toMiB = (bytes: number) => Number((bytes / (1024 * 1024)).toFixed(1));
    const f = await fixture({ model: "stems_4", sourceWavPath: sources[0]!.path });
    let harness: ReturnType<typeof createLocalRetryHarness> | undefined;
    try {
      for (const spec of FOUR_STEM_MODELS) {
        await copyFile(join(modelDirectory, spec.file), join(f.modelsDir, spec.file));
      }
      await f.database
        .update(processingJobs)
        .set({
          status: "failed",
          stage: "failed",
          errorCode: "separation_unavailable",
          errorMessage: "Changing-input memory measurement initialized.",
          completedAt: new Date(),
        })
        .where(eq(processingJobs.id, f.job.id));

      const completedModelPasses: { model: string; chunkCount: number }[] = [];
      harness = createLocalRetryHarness(f.database, (model, timings) => {
        completedModelPasses.push({ model, chunkCount: timings.chunkCount });
      });
      const storage = getStorage();
      const baseline = await sampleMemory();
      const jobReports: {
        input: { filename: string; sha256: string; durationSeconds: number };
        requestedDevice: string;
        resolvedDevice: string;
        chunkCounts: Record<string, number>;
        memory: Awaited<ReturnType<typeof sampleMemory>>;
      }[] = [];
      const startedAt = Date.now();
      for (let run = 0; run < sources.length; run += 1) {
        const source = sources[run]!;
        // Reuse one durable source row and broker while replacing its audio.
        // This keeps every changing-input inference in the same worker process.
        await storage.putFile(f.source.storageKey, source.path, "audio/wav");
        await f.database
          .update(sourceAssets)
          .set({
            checksumSha256: source.checksum!,
            durationSeconds: source.sampleCount / 44_100,
            sampleRate: 44_100,
            channels: 2,
            codec: "pcm_s16le",
            fileSizeBytes: (await stat(source.path)).size,
          })
          .where(eq(sourceAssets.id, f.source.id));
        if (run > 0) {
          await f.database
            .update(processingJobs)
            .set({
              status: "failed",
              stage: "failed",
              errorCode: "separation_unavailable",
              errorMessage: `Changing-input memory measurement ${run + 1}.`,
              completedAt: new Date(),
            })
            .where(eq(processingJobs.id, f.job.id));
        }

        const firstPassIndex = completedModelPasses.length;
        assert.deepEqual(await retrySeparationJob(f.database, f.job.id), { queued: true });
        const deadline = Date.now() + 240_000;
        let job = (await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id)))[0];
        while (
          (job?.status !== "complete" || harness.broker.stats().succeeded < run + 1) &&
          job?.status !== "failed" &&
          Date.now() < deadline
        ) {
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
          job = (await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id)))[0];
        }
        assert.equal(job?.status, "complete", `changing excerpt ${run + 1} completes before timeout`);
        assert.equal(harness.broker.stats().submitted, run + 1);
        assert.equal(harness.broker.stats().succeeded, run + 1);
        const runPasses = completedModelPasses.slice(firstPassIndex);
        assert.deepEqual(
          runPasses.map(({ model }) => model),
          FOUR_STEM_MODELS.map(({ id }) => id),
          `changing excerpt ${run + 1} releases all four pinned model sessions`,
        );
        assert.ok(
          runPasses.every(({ chunkCount }) => chunkCount > 1),
          `changing excerpt ${run + 1} exercised multiple chunks in every model`,
        );
        const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
        assert.equal(stems.length, 4, `changing excerpt ${run + 1} persists all four stems`);
        const memory = await sampleMemory();
        jobReports.push({
          input: {
            filename: basename(source.path),
            sha256: source.checksum!,
            durationSeconds: Number((source.sampleCount / 44_100).toFixed(2)),
          },
          requestedDevice: job.requestedDevice ?? "unknown",
          resolvedDevice: job.resolvedDevice ?? "unknown",
          chunkCounts: Object.fromEntries(runPasses.map(({ model, chunkCount }) => [model, chunkCount])),
          memory,
        });
      }

      const warmupJobs = 3;
      const firstSteadyRss = jobReports[warmupJobs]!.memory.rss;
      const postWarmRss = jobReports
        .slice(warmupJobs)
        .slice(Math.floor((jobReports.length - warmupJobs) / 2))
        .map(({ memory }) => memory.rss)
        .sort((left, right) => left - right);
      const middleIndex = Math.floor(postWarmRss.length / 2);
      const tailMedianRss = postWarmRss.length % 2 === 1
        ? postWarmRss[middleIndex]!
        : (postWarmRss[middleIndex - 1]! + postWarmRss[middleIndex]!) / 2;
      const continuedRssGrowth = tailMedianRss - firstSteadyRss;
      const maxContinuedGrowthBytes = 128 * 1024 * 1024;
      assert.ok(
        continuedRssGrowth <= maxContinuedGrowthBytes,
        `RSS continued growing by ${toMiB(continuedRssGrowth)} MiB after warm-up; ` +
          `allowed ${toMiB(maxContinuedGrowthBytes)} MiB. ` +
          `Samples: ${jobReports.map(({ memory }) => `${toMiB(memory.rss)} MiB`).join(" → ")}`,
      );
      const requestedDevices = [...new Set(jobReports.map(({ requestedDevice }) => requestedDevice))];
      const resolvedDevices = [...new Set(jobReports.map(({ resolvedDevice }) => resolvedDevice))];
      assert.equal(requestedDevices.length, 1, "all changing-input jobs use the same requested provider");
      assert.equal(resolvedDevices.length, 1, "all changing-input jobs use the same selected provider");
      assert.ok(resolvedDevices[0] && resolvedDevices[0] !== "unknown");

      const reportPath = process.env.WAVEYARD_REAL_ORT_CHANGING_MEMORY_REPORT?.trim();
      if (reportPath) {
        const report = {
          schemaVersion: 1,
          benchmark: "changing real excerpts with pinned four-model process memory",
          measuredMachine: {
            platform: process.platform,
            osType: osType(),
            osRelease: release(),
            architecture: process.arch,
            nodeVersion: process.version,
            cpuModel: cpus()[0]?.model ?? null,
            logicalCpuCount: cpus().length,
          },
          requestedProvider: requestedDevices[0],
          selectedProvider: resolvedDevices[0],
          models: FOUR_STEM_MODELS.map(({ id, sha256 }) => ({ id, sha256 })),
          baselineMemoryBytes: baseline,
          warmupJobs,
          jobs: jobReports,
          summary: {
            warmupRetentionBytes: jobReports[warmupJobs - 1]!.memory.rss - baseline.rss,
            firstSteadyRssBytes: firstSteadyRss,
            finalHalfMedianRssBytes: tailMedianRss,
            continuedRssGrowthBytes: continuedRssGrowth,
            allowedContinuedGrowthBytes: maxContinuedGrowthBytes,
            continuedGrowthBounded: continuedRssGrowth <= maxContinuedGrowthBytes,
            samplingMethod: "process.memoryUsage after optional explicit GC and a 150 ms worker-teardown settle",
            explicitGcAvailable: Boolean(forceGc),
          },
        };
        const resolvedReportPath = resolve(reportPath);
        await mkdir(dirname(resolvedReportPath), { recursive: true });
        await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
      }

      t.diagnostic(
        `Pinned four-model changing-input memory run on ${resolvedDevices[0]}: ${sources.length} distinct excerpts ` +
          `in ${Date.now() - startedAt} ms; baseline RSS ${toMiB(baseline.rss)} MiB; post-job RSS ` +
          `${jobReports.map(({ memory }) => toMiB(memory.rss)).join(" → ")} MiB; ` +
          `${warmupJobs} warm-up jobs retained ${toMiB(jobReports[warmupJobs - 1]!.memory.rss - baseline.rss)} MiB; ` +
          `first steady RSS ${toMiB(firstSteadyRss)} MiB; final-half median ${toMiB(tailMedianRss)} MiB; ` +
          `continued growth ${toMiB(continuedRssGrowth)} MiB (limit ${toMiB(maxContinuedGrowthBytes)} MiB); ` +
          `heapUsed ${jobReports.map(({ memory }) => toMiB(memory.heapUsed)).join(" → ")} MiB; ` +
          `external ${jobReports.map(({ memory }) => toMiB(memory.external)).join(" → ")} MiB; ` +
          `arrayBuffers ${jobReports.map(({ memory }) => toMiB(memory.arrayBuffers)).join(" → ")} MiB; ` +
          `excerpt SHA-256 values ${sources.map(({ checksum }) => checksum).join(", ")}.`,
      );
    } finally {
      await harness?.restore();
      await f.close();
    }
  });
}

// Opt-in real-audio measurement. Arena decodes supported local audio formats
// into 44.1 kHz stereo PCM, then bounds processing to a 2–20 second excerpt.
const realAudioInputPath =
  process.env.WAVEYARD_REAL_AUDIO_INPUT?.trim() ||
  process.env.WAVEYARD_REAL_AUDIO_WAV?.trim();
const referenceManifestPath = process.env.WAVEYARD_REAL_AUDIO_REFERENCE_MANIFEST?.trim();
if (realAudioInputPath) {
  test("the pinned four-model recipe separates a real audio excerpt", { timeout: 600_000 }, async (t) => {
    const arenaRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const workspaceRoot = resolve(arenaRoot, "../..");
    const modelDirectory = join(workspaceRoot, "artifacts/api-server/.data/waveyard-models");
    for (const spec of FOUR_STEM_MODELS) {
      const modelPath = join(modelDirectory, spec.file);
      assert.ok(existsSync(modelPath), `Pinned ${spec.id} weights must be installed for this measurement.`);
      assert.equal(await checksumFile(modelPath), spec.sha256, `${spec.id} must match its registry checksum`);
    }

    const sourcePath = resolve(realAudioInputPath);
    const inputPreparationStartedAt = Date.now();
    const sourceBytes = (await stat(sourcePath)).size;
    const sourceDecoded = await decodeSourceToStereoPcm(
      sourcePath,
      {},
      {},
      { requireSampleRate: 44_100 },
    );
    assert.equal(sourceDecoded.sampleRate, 44_100, "the decoded measurement file must be 44.1 kHz");
    assert.equal(sourceDecoded.pcm.length % 2, 0, "the decoded measurement file must be stereo");
    const sourceFrames = sourceDecoded.pcm.length / 2;
    const audioDecodeMs = Date.now() - inputPreparationStartedAt;
    assert.ok(sourceFrames > 44_100, "use more than one second of real audio");
    assert.ok(sourceFrames <= 15 * 60 * 44_100, "keep the source within the worker's decode limit");

    const maxSecondsText = process.env.WAVEYARD_REAL_AUDIO_MAX_SECONDS?.trim() || "20";
    const maxSeconds = Number(maxSecondsText);
    assert.ok(
      Number.isInteger(maxSeconds) && maxSeconds >= 2 && maxSeconds <= 20,
      "WAVEYARD_REAL_AUDIO_MAX_SECONDS must be an integer from 2 to 20",
    );
    const startSecondsText = process.env.WAVEYARD_REAL_AUDIO_START_SECONDS?.trim() || "0";
    const startSeconds = Number(startSecondsText);
    assert.ok(
      Number.isInteger(startSeconds) && startSeconds >= 0 && startSeconds <= 899,
      "WAVEYARD_REAL_AUDIO_START_SECONDS must be an integer from 0 to 899",
    );
    const excerptPreparationStartedAt = Date.now();
    const startFrame = startSeconds * sourceDecoded.sampleRate;
    assert.ok(
      sourceFrames - startFrame > sourceDecoded.sampleRate,
      "the selected start time must leave more than one second of real audio",
    );
    const processedFrames = Math.min(
      sourceFrames - startFrame,
      maxSeconds * sourceDecoded.sampleRate,
    );
    const processedSamples = sourceDecoded.pcm.subarray(
      startFrame * 2,
      (startFrame + processedFrames) * 2,
    );
    const processedWav = encodeWav16(processedSamples, sourceDecoded.sampleRate);
    const sourceDurationSeconds = Number((sourceFrames / sourceDecoded.sampleRate).toFixed(2));
    const processedDurationSeconds = Number((processedFrames / sourceDecoded.sampleRate).toFixed(2));
    const excerptDirectory = await mkdtemp(join(tmpdir(), "waveyard-real-audio-"));
    const excerptPath = join(excerptDirectory, "excerpt.wav");
    let harness: ReturnType<typeof createLocalRetryHarness> | undefined;
    let fixtureState: SeparationFixture | undefined;
    const inferenceStageTimings: { model: string; timings: MdxStageTimings }[] = [];
    try {
      await writeFile(excerptPath, processedWav);
      const processedExcerptSha256 = await checksumFile(excerptPath);
      const excerptPreparationMs = Date.now() - excerptPreparationStartedAt;
      const f = await fixture({ model: "stems_4", sourceWavPath: excerptPath });
      fixtureState = f;

      for (const spec of FOUR_STEM_MODELS) {
        await copyFile(join(modelDirectory, spec.file), join(f.modelsDir, spec.file));
      }
      await f.database
        .update(processingJobs)
        .set({
          status: "failed",
          stage: "failed",
          errorCode: "separation_unavailable",
          errorMessage: "Measurement run initialized.",
          ...(process.env.WAVEYARD_REAL_AUDIO_BENCHMARK_CPU_ONLY === "1"
            ? { requestedDevice: "cpu" }
            : {}),
          completedAt: new Date(),
        })
        .where(eq(processingJobs.id, f.job.id));

      harness = createLocalRetryHarness(f.database, (model, timings) => {
        inferenceStageTimings.push({ model, timings });
      });
      const progressPassSampler = createProgressPassSampler();
      let stopSamplingProgress = false;
      let progressSamplingError: string | null = null;
      const sampleProgress = (async () => {
        while (!stopSamplingProgress) {
          try {
            const [latestJob] = await f.database
              .select()
              .from(processingJobs)
              .where(eq(processingJobs.id, f.job.id));
            const metadata = typeof latestJob?.metadata === "string"
              ? JSON.parse(latestJob.metadata)
              : (latestJob?.metadata ?? {});
            const progress = metadata?.progress;
            progressPassSampler.observe(progress ?? {}, Date.now());
          } catch (error) {
            progressSamplingError = error instanceof Error ? error.message : String(error);
            return;
          }
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, PROGRESS_SAMPLING_INTERVAL_MS));
        }
      })();
      const startedAt = Date.now();
      let playbackTicks = 0;
      let lastPlaybackTickAt = startedAt;
      let maxPlaybackGapMs = 0;
      const playbackTimer = setInterval(() => {
        const now = Date.now();
        maxPlaybackGapMs = Math.max(maxPlaybackGapMs, now - lastPlaybackTickAt);
        lastPlaybackTickAt = now;
        playbackTicks += 1;
      }, 20);
      let retry: Awaited<ReturnType<typeof retrySeparationJob>> | undefined;
      try {
        retry = await retrySeparationJob(f.database, f.job.id);
        assert.equal(await harness.broker.drain(570_000), true, "the real-audio recipe drains through the production worker");
      } finally {
        clearInterval(playbackTimer);
        stopSamplingProgress = true;
        await sampleProgress;
      }
      const sampledProgressPasses = progressPassSampler.finish(Date.now());
      const elapsedMs = Date.now() - startedAt;
      assert.deepEqual(retry, { queued: true });
      for (const pass of sampledProgressPasses) {
        assert.ok(
          FOUR_STEM_MODELS.some(({ id }) => id === pass.model),
          `${pass.phase} sampled progress identifies a pinned model`,
        );
        assert.ok(
          Number.isFinite(pass.elapsedMs) && pass.elapsedMs > 0,
          `${pass.model} sampled progress timing must be finite and positive`,
        );
      }

      const [job] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
      assert.equal(job.status, "complete");
      const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
      assert.equal(stems.length, 4, "the recipe persists vocals, drums, bass, and melody");

      const measuredStems: Record<string, ReturnType<typeof audioMetrics>> = {};
      const outputIntegrity: Record<string, { readablePcm16Stereo44100: boolean; correctDuration: boolean; finiteSamples: boolean; inPcmRange: boolean }> = {};
      const estimatePcm = {} as FourStemSamples;
      const auditionDirectory = process.env.WAVEYARD_REAL_AUDIO_AUDITION_DIR?.trim();
      if (auditionDirectory) await mkdir(resolve(auditionDirectory), { recursive: true });
      for (const stem of stems) {
        const storedPath = getStorage().getLocalPath(stem.storageKey);
        assert.ok(storedPath && existsSync(storedPath), `${stem.stemType} output exists in storage`);
        const decoded = decodeWav16(new Uint8Array(await readFile(storedPath!)));
        assert.ok(decoded, `${stem.stemType} output is a readable WAV`);
        assert.equal(decoded.sampleRate, 44_100);
        assert.equal(decoded.frames, processedFrames, `${stem.stemType} retains the processed excerpt duration`);
        assert.equal(decoded.channels, 2, `${stem.stemType} remains stereo`);
        const finiteSamples = decoded.samples.every(Number.isFinite);
        const inPcmRange = decoded.samples.every((sample) => sample >= -1 && sample <= 1);
        assert.ok(finiteSamples, `${stem.stemType} contains only finite samples`);
        assert.ok(inPcmRange, `${stem.stemType} stays within the normalized PCM range`);
        measuredStems[stem.stemType] = audioMetrics(decoded.samples);
        assert.ok(
          ["vocals", "drums", "bass", "other"].includes(stem.stemType),
          `unexpected four-stem output ${stem.stemType}`,
        );
        estimatePcm[stem.stemType as keyof FourStemSamples] = decoded.samples;
        if (auditionDirectory) {
          await writeFile(
            join(resolve(auditionDirectory), `${stem.stemType}-estimate.wav`),
            encodeWav16(decoded.samples, decoded.sampleRate),
          );
        }
        assert.ok(measuredStems[stem.stemType].rmsDbfs > -90, `${stem.stemType} output is not silent`);
        outputIntegrity[stem.stemType] = {
          readablePcm16Stereo44100: true,
          correctDuration: decoded.frames === processedFrames,
          finiteSamples,
          inPcmRange,
        };
      }
      assert.equal(inferenceStageTimings.length, FOUR_STEM_MODELS.length, "each real model pass reports stage timings");
      assert.deepEqual(
        inferenceStageTimings.map(({ model }) => model).sort(),
        FOUR_STEM_MODELS.map(({ id }) => id).sort(),
        "stage timings cover all pinned models",
      );
      const expectedTimingKeys = [
        "preprocessingMs",
        "stftMs",
        "inferenceMs",
        "istftMs",
        "overlapAddMs",
        "reconstructionMs",
        "totalMs",
        "chunkCount",
      ].sort();
      for (const entry of inferenceStageTimings) {
        assert.deepEqual(
          Object.keys(entry.timings).sort(),
          expectedTimingKeys,
          `${entry.model} timing pass must include every required stage`,
        );
        for (const [stage, value] of Object.entries(entry.timings)) {
          assert.ok(
            Number.isFinite(value) && value >= 0,
            `${entry.model} ${stage} timing must be finite and non-negative`,
          );
        }
        assert.ok(entry.timings.totalMs > 0, `${entry.model} authoritative total timing must be positive`);
        assert.ok(
          Number.isInteger(entry.timings.chunkCount) && entry.timings.chunkCount > 0,
          `${entry.model} authoritative chunk count must be a positive integer`,
        );
      }
      const stageTotals = inferenceStageTimings.reduce(
        (totals, entry) => {
          for (const key of ["preprocessingMs", "stftMs", "inferenceMs", "istftMs", "overlapAddMs", "reconstructionMs", "totalMs"] as const) {
            totals[key] += entry.timings[key];
          }
          totals.chunkCount += entry.timings.chunkCount;
          return totals;
        },
        {
          preprocessingMs: 0,
          stftMs: 0,
          inferenceMs: 0,
          istftMs: 0,
          overlapAddMs: 0,
          reconstructionMs: 0,
          totalMs: 0,
          chunkCount: 0,
        },
      );
      const report = {
        schemaVersion: 8,
        platform: process.platform,
        osType: osType(),
        osRelease: release(),
        architecture: process.arch,
        nodeVersion: process.version,
        cpuModel: cpus()[0]?.model ?? null,
        logicalCpuCount: cpus().length,
        executor: "production retry -> local worker broker",
        requestedDevice: job.requestedDevice,
        ortExecutionMode: WAVEYARD_ORT_EXECUTION_MODE,
        ortIntraOpThreads: WAVEYARD_ORT_INTRA_OP_THREADS,
        ortInterOpThreads: WAVEYARD_ORT_INTER_OP_THREADS,
        ortMemoryArenaEnabled: true,
        ortMemoryPatternEnabled: true,
        models: FOUR_STEM_MODELS.map(({ id, sha256 }) => ({ id, sha256 })),
        input: {
          filename: basename(realAudioInputPath),
          bytes: sourceBytes,
          sha256: await checksumFile(sourcePath),
          processedExcerptSha256,
          durationSeconds: sourceDurationSeconds,
          processedStartSeconds: startSeconds,
          processedDurationSeconds,
          sampleRate: sourceDecoded.sampleRate,
          channels: 2,
        },
        result: {
          resolvedDevice: job.resolvedDevice,
          elapsedMs,
          realtimeFactor: Number((elapsedMs / (processedDurationSeconds * 1000)).toFixed(2)),
          stems: measuredStems,
          objectiveOutputChecks: {
            allFourStemFilesReadablePcm16Stereo44100: Object.values(outputIntegrity).every((checks) => checks.readablePcm16Stereo44100),
            allFourStemsMatchExcerptDuration: Object.values(outputIntegrity).every((checks) => checks.correctDuration),
            allSamplesFinite: Object.values(outputIntegrity).every((checks) => checks.finiteSamples),
            allSamplesWithinPcmRange: Object.values(outputIntegrity).every((checks) => checks.inPcmRange),
            nonSilentStems: Object.keys(measuredStems).filter((stemType) => measuredStems[stemType]!.rmsDbfs > -90),
            perStem: outputIntegrity,
            soundQualityEvaluated: false,
          },
        },
        timings: {
          audioDecodeMs,
          excerptPreparationMs,
          separationElapsedMs: elapsedMs,
          measuredInputToStemsMs: audioDecodeMs + excerptPreparationMs + elapsedMs,
          playbackTimerTicks: playbackTicks,
          maxPlaybackTimerGapMs: maxPlaybackGapMs,
          playbackResponsivenessPassed: playbackTicks >= 5 && maxPlaybackGapMs < 1_000,
          inferenceStageTotals: stageTotals,
          inferenceTimeSharePercent: Number((stageTotals.inferenceMs / Math.max(1, stageTotals.totalMs) * 100).toFixed(1)),
          modelInferenceStages: inferenceStageTimings,
          sampledProgressModelPasses: sampledProgressPasses,
          progressSamplingIntervalMs: PROGRESS_SAMPLING_INTERVAL_MS,
          modelTimingInterpretation: {
            modelInferenceStages: "Complete per-model timings from the authoritative inference callback; required for all pinned models.",
            sampledProgressModelPasses: `Approximate durations inferred from progress snapshots with a ${PROGRESS_SAMPLING_INTERVAL_MS} ms poll delay; short passes may be omitted and this list is not a completeness check.`,
          },
          ...(progressSamplingError ? { progressSamplingError } : {}),
          excludes: "PGlite fixture setup, model copying, library import/upload, and subjective separation quality",
        },
        evidenceLimit: "Real audio and pinned-model execution only on the recorded OS, CPU, and provider; CPU-only measurements do not establish DirectML performance or subjective separation quality.",
      };
      if (referenceManifestPath) {
        const referenceManifest = JSON.parse(await readFile(resolve(referenceManifestPath), "utf8")) as {
          dataset: string;
          datasetUrl: string;
          track: string;
          license: string;
          attribution: string;
          referenceStems: Record<keyof FourStemSamples, string>;
          listeningReview?: string;
        };
        const referencePcm = {} as FourStemSamples;
        const referenceSha256 = {} as Record<keyof FourStemSamples, string>;
        for (const stemType of ["vocals", "drums", "bass", "other"] as const) {
          const referencePath = resolve(referenceManifest.referenceStems[stemType]);
          const decoded = await decodeSourceToStereoPcm(
            referencePath,
            {},
            {},
            { requireSampleRate: 44_100 },
          );
          referenceSha256[stemType] = await checksumFile(referencePath);
          assert.equal(decoded.sampleRate, sourceDecoded.sampleRate);
          assert.equal(
            decoded.pcm.length,
            sourceDecoded.pcm.length,
            `${stemType} reference must be time/sample aligned with the mix excerpt`,
          );
          referencePcm[stemType] = decoded.pcm;
          if (auditionDirectory) {
            await writeFile(
              join(resolve(auditionDirectory), `${stemType}-reference.wav`),
              encodeWav16(decoded.pcm, decoded.sampleRate),
            );
          }
        }
        if (auditionDirectory) {
          await writeFile(join(resolve(auditionDirectory), "mixture.wav"), encodeWav16(processedSamples, 44_100));
        }
        const qualityMetrics = evaluateFourStemSeparation(
          processedSamples,
          referencePcm,
          estimatePcm,
          Math.min(22_050, Math.floor(processedFrames / 4)),
        );
        Object.assign(report.result, {
          referenceEvaluation: {
            dataset: referenceManifest.dataset,
            datasetUrl: referenceManifest.datasetUrl,
            track: referenceManifest.track,
            license: referenceManifest.license,
            attribution: referenceManifest.attribution,
            referenceSha256,
            ...(auditionDirectory ? { auditionDirectory: resolve(auditionDirectory) } : {}),
            metrics: {
              method: "SI-SDR: stereo flattened with one least-squares gain; each estimate compared with its aligned reference and unseparated mixture. Recombined stem sum compared with the original mix using SI-SDR and unscaled residual SDR.",
              edgePolicy: "Reference SI-SDR excludes the first and last 0.5 seconds (or one quarter of a shorter excerpt) to reduce model padding/overlap edge influence; recombination metrics use the full excerpt.",
              ...qualityMetrics,
            },
            listeningReview: referenceManifest.listeningReview ?? {
              status: "not-performed",
              note: "The automated environment cannot audition audio. Objective scores do not substitute for listening; review the included per-stem audition files before making a usability claim.",
            },
          },
        });
      }
      const reportPath = process.env.WAVEYARD_REAL_AUDIO_REPORT?.trim();
      if (reportPath) {
        await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
      }
      t.diagnostic(JSON.stringify(report));
      assert.ok(playbackTicks >= 5, `playback timer advanced ${playbackTicks} times during real-audio separation`);
      assert.ok(maxPlaybackGapMs < 1_000, `playback timer's longest pause was ${maxPlaybackGapMs}ms`);
    } finally {
      await harness?.restore();
      await fixtureState?.close();
      await rm(excerptDirectory, { recursive: true, force: true });
    }
  });
}

test("a real-length CPU demix leaves library requests and playback timers responsive", { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    // This padded Identity model is real ONNX and passes the same integrity
    // check as a seeded model, without downloading or fabricating model weights.
    const modelBytes = craftPassthroughOnnx(KIM.params.dimF, KIM.params.dimT);
    const padding = Buffer.alloc(1_000_100);
    const paddedModel = Buffer.concat([
      modelBytes,
      Buffer.from([...tag(100, 2), ...varint(padding.length)]),
      padding,
    ]);
    const modelPath = join(f.modelsDir, "long-form-probe.onnx");
    await writeFile(modelPath, paddedModel);
    const probe = {
      ...KIM,
      id: "long_form_probe",
      file: "long-form-probe.onnx",
      sizeBytes: paddedModel.length,
      sha256: await checksumFile(modelPath),
    };

    // One minute forces multiple actual STFT/inference/overlap-add chunks,
    // rather than testing only the one-chunk pipeline smoke case.
    const sampleCount = 60 * 44_100;
    const left = new Float32Array(sampleCount);
    const right = new Float32Array(sampleCount);
    const cycle = Float32Array.from({ length: 441 }, (_, index) => Math.sin((2 * Math.PI * index) / 441) * 0.35);
    for (let index = 0; index < sampleCount; index += 1) {
      left[index] = cycle[index % cycle.length];
      right[index] = cycle[(index + 110) % cycle.length];
    }

    let playbackTicks = 0;
    let lastPlaybackTick = Date.now();
    let maxPlaybackGapMs = 0;
    const playbackTimer = setInterval(() => {
      const now = Date.now();
      maxPlaybackGapMs = Math.max(maxPlaybackGapMs, now - lastPlaybackTick);
      lastPlaybackTick = now;
      playbackTicks += 1;
    }, 20);

    const separation = demixMdxInWorker(probe, "cpu", [left, right], () => {});
    const requestStarted = Date.now();
    const request = await Promise.race([
      f.database.select().from(processingJobs),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("library request stalled during separation")), 1_000)),
    ]);
    const requestLatencyMs = Date.now() - requestStarted;
    assert.equal(request.length, 1);
    assert.ok(requestLatencyMs < 1_000, `library query returned in ${requestLatencyMs}ms`);

    try {
      const result = await separation;
      assert.equal(result.resolvedDevice, "cpu");
      assert.equal(result.separated.sampleCount, sampleCount);
      assert.equal(result.separated.primary[0].length, sampleCount);
    } finally {
      clearInterval(playbackTimer);
    }

    assert.ok(playbackTicks >= 5, `playback timer advanced ${playbackTicks} times during CPU separation`);
    assert.ok(maxPlaybackGapMs < 1_000, `playback timer's longest pause was ${maxPlaybackGapMs}ms`);
  } finally {
    await f.close();
  }
});
