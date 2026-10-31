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
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { cpus, release, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";

import { decodeWav16, encodeWav16 } from "@workspace/arena/lib/waveyard/mixer/synth";
import { checksumFile } from "@workspace/arena/lib/waveyard/audio";
import { getStorage } from "@workspace/arena/lib/waveyard/storage";
import { SEPARATION_QUEUE } from "@workspace/arena/lib/waveyard/queue";
import { decodeSourceToStereoPcm } from "../measure/pcm";
import { stemAssets, processingJobs } from "@workspace/db/waveyardSchema";
import { findMdxModel } from "@workspace/arena/lib/waveyard/separation/mdx";
import { retrySeparationJob } from "@workspace/arena/lib/waveyard/separation/retry";
import type { OpenedEngine } from "./separation";
import { demixMdxInWorker, handleSeparationJob } from "./separation";
import { getLocalJobBroker, resetLocalJobBrokerForTests } from "./broker";
import {
  executionProviderAttempts,
  separationInferenceThreads,
  WAVEYARD_ORT_INTRA_OP_THREADS,
} from "@workspace/arena/lib/waveyard/separation/session";
import { fixture, payloadOf, SAMPLES, snrDb, type SeparationFixture } from "./separation-fixtures";
import type { MdxStageTimings } from "@workspace/arena/lib/waveyard/separation/mdx";

const KIM = findMdxModel("kim_vocal_2")!;
const FOUR_STEM_MODELS = [
  "kim_vocal_2",
  "kuielab_b_drums",
  "kuielab_b_bass",
  "kuielab_b_other",
].map((id) => findMdxModel(id)!);

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
  broker.register(SEPARATION_QUEUE, (payload) =>
    handleSeparationJob(payload as Parameters<typeof handleSeparationJob>[0], {
      db: database,
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
  assert.ok(WAVEYARD_ORT_INTRA_OP_THREADS >= 1 && WAVEYARD_ORT_INTRA_OP_THREADS <= 4);
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

test("the pinned four-model recipe completes through the production worker on retry", { timeout: 300_000 }, async (t) => {
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

  const f = await fixture({ model: "stems_4" });
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

    let playbackTicks = 0;
    let lastPlaybackTick = Date.now();
    let maxPlaybackGapMs = 0;
    const playbackTimer = setInterval(() => {
      const now = Date.now();
      maxPlaybackGapMs = Math.max(maxPlaybackGapMs, now - lastPlaybackTick);
      lastPlaybackTick = now;
      playbackTicks += 1;
    }, 20);
    let retryPromise: Promise<{ queued: boolean }> | undefined;
    let elapsedMs = 0;
    let requestLatencyMs = 0;
    try {
      harness = createLocalRetryHarness(f.database);
      const startedAt = Date.now();
      retryPromise = retrySeparationJob(f.database, f.job.id);
      const requestStartedAt = Date.now();
      let requestTimeout: NodeJS.Timeout | undefined;
      const request = await Promise.race([
        f.database.select().from(processingJobs).then((rows) => ({
          rows,
          latencyMs: Date.now() - requestStartedAt,
        })),
        new Promise<never>((_, reject) => {
          requestTimeout = setTimeout(
            () => reject(new Error("Library read stalled during real four-stem separation")),
            1_000,
          );
        }),
      ]).finally(() => {
        if (requestTimeout) clearTimeout(requestTimeout);
      });
      requestLatencyMs = request.latencyMs;
      assert.equal(request.rows.length, 1);
      assert.ok(requestLatencyMs < 1_000);

      const retry = await retryPromise;
      assert.equal(await harness.broker.drain(240_000), true, "the four-model retry drains through the local worker");
      elapsedMs = Date.now() - startedAt;
      assert.deepEqual(retry, { queued: true });
      assert.equal(harness.broker.stats().succeeded, 1, "the real worker completed the four-model broker submission");
    } finally {
      clearInterval(playbackTimer);
      await retryPromise?.catch(() => undefined);
    }
    assert.ok(playbackTicks >= 5, `playback timer advanced ${playbackTicks} times during separation`);
    assert.ok(maxPlaybackGapMs < 1_000, `playback timer's longest pause was ${maxPlaybackGapMs}ms`);

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
      assert.equal(decoded.frames, SAMPLES);
    }
    t.diagnostic(
      `Pinned four-model retry completed on ${job.resolvedDevice} with ${WAVEYARD_ORT_INTRA_OP_THREADS} ORT threads in ${elapsedMs} ms; library read ${requestLatencyMs} ms; max playback timer gap ${maxPlaybackGapMs} ms. Synthetic fixture proves execution, not separation quality.`,
    );
  } finally {
    await harness?.restore();
    await f.close();
  }
});

// Opt-in real-audio measurement. Arena decodes supported local audio formats
// into 44.1 kHz stereo PCM, then bounds processing to a 2–20 second excerpt.
const realAudioInputPath =
  process.env.WAVEYARD_REAL_AUDIO_INPUT?.trim() ||
  process.env.WAVEYARD_REAL_AUDIO_WAV?.trim();
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
          completedAt: new Date(),
        })
        .where(eq(processingJobs.id, f.job.id));

      harness = createLocalRetryHarness(f.database, (model, timings) => {
        inferenceStageTimings.push({ model, timings });
      });
      const modelPassTimings: { phase: string; model: string; elapsedMs: number }[] = [];
      let activePass: { phase: string; model: string; startedAt: number } | null = null;
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
            if (typeof progress?.phase === "string" && progress.phase !== activePass?.phase) {
              const observedAt = Date.now();
              if (activePass) {
                modelPassTimings.push({
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
            }
          } catch (error) {
            progressSamplingError = error instanceof Error ? error.message : String(error);
            return;
          }
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 500));
        }
      })();
      const startedAt = Date.now();
      let retry: Awaited<ReturnType<typeof retrySeparationJob>> | undefined;
      try {
        retry = await retrySeparationJob(f.database, f.job.id);
        assert.equal(await harness.broker.drain(570_000), true, "the real-audio recipe drains through the production worker");
      } finally {
        stopSamplingProgress = true;
        await sampleProgress;
        if (activePass) {
          modelPassTimings.push({
            phase: activePass.phase,
            model: activePass.model,
            elapsedMs: Date.now() - activePass.startedAt,
          });
        }
      }
      const elapsedMs = Date.now() - startedAt;
      assert.deepEqual(retry, { queued: true });
      assert.equal(
        modelPassTimings.length,
        FOUR_STEM_MODELS.length,
        "the production worker should expose a progress interval for each real model pass",
      );

      const [job] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
      assert.equal(job.status, "complete");
      const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
      assert.equal(stems.length, 4, "the recipe persists vocals, drums, bass, and melody");

      const measuredStems: Record<string, ReturnType<typeof audioMetrics>> = {};
      const outputIntegrity: Record<string, { readablePcm16Stereo44100: boolean; correctDuration: boolean; finiteSamples: boolean; inPcmRange: boolean }> = {};
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
        schemaVersion: 2,
        platform: process.platform,
        osRelease: release(),
        architecture: process.arch,
        nodeVersion: process.version,
        cpuModel: cpus()[0]?.model ?? null,
        logicalCpuCount: cpus().length,
        executor: "production retry -> local worker broker",
        ortThreads: WAVEYARD_ORT_INTRA_OP_THREADS,
        ortMemoryArenaEnabled: true,
        ortMemoryPatternEnabled: true,
        models: FOUR_STEM_MODELS.map(({ id, sha256 }) => ({ id, sha256 })),
        input: {
          filename: basename(realAudioInputPath),
          bytes: sourceBytes,
          sha256: await checksumFile(sourcePath),
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
          inferenceStageTotals: stageTotals,
          inferenceTimeSharePercent: Number((stageTotals.inferenceMs / Math.max(1, stageTotals.totalMs) * 100).toFixed(1)),
          modelInferenceStages: inferenceStageTimings,
          progressObservedModelPasses: modelPassTimings,
          progressSamplingIntervalMs: 500,
          ...(progressSamplingError ? { progressSamplingError } : {}),
          excludes: "PGlite fixture setup, model copying, library import/upload, and subjective separation quality",
        },
        evidenceLimit: "Real audio and pinned-model execution on the recorded platform; this does not establish Windows performance unless platform is win32, or subjective separation quality.",
      };
      const reportPath = process.env.WAVEYARD_REAL_AUDIO_REPORT?.trim();
      if (reportPath) {
        await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
      }
      t.diagnostic(JSON.stringify(report));
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
