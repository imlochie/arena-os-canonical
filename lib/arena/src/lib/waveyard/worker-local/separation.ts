/**
 * Local separation job handler — the V1 stem machine (docs/waveyard-vision
 * §V1). The cloud pipeline shells out to a Python Demucs worker; this
 * handler runs the same durable job lifecycle entirely in-process with the
 * app's own MDX-Net engine (separation/mdx.ts, a faithful port of the
 * reference demix) over onnxruntime-node. Zero setup, zero infrastructure:
 * if you can play the app, you can separate.
 *
 * Lifecycle parity with the cloud worker (waveyard-worker separation.ts):
 * preparing → separating → validating → complete; payload/target identity
 * checks; stem rows replaced atomically on retry; one waveform job per
 * stem enqueued after commit (each records its own failure boundary);
 * uploaded stem objects cleaned up if the job fails.
 *
 * Documented local differences:
 *  - engine "mdx" (registry-verified model file) instead of "demucs";
 *    stems are the model's primary + secondary (vocals + instrumental for
 *    Kim Vocal 2), not Demucs' four.
 *  - modelVersion records the model file's sha256 — the exact bits that
 *    produced the stems.
 *  - The isolated-vocal analysis provisioning is NOT mirrored: the desktop
 *    has no vocal-analysis executor, and provisioning a job that can never
 *    run would not be honest (see worker-local/index.ts).
 *  - Real progress: chunk-level progress is written into the durable job's
 *    metadata while separating, so the UI polls one honest number.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { and, eq, ne } from "drizzle-orm";

import type { drizzle } from "drizzle-orm/node-postgres";

import { processingJobs, sourceAssets, stemAssets, waveformJobs } from "@workspace/db/waveyardSchema";
import { checksumFile } from "@workspace/arena/lib/waveyard/audio";
import { decodeWav16, encodeWav16 } from "@workspace/arena/lib/waveyard/mixer/synth";
import { getStorage, privateObjectKey } from "@workspace/arena/lib/waveyard/storage";
import { enqueueWaveform } from "@workspace/arena/lib/waveyard/queue";
import { decodeSourceToStereoPcm } from "@workspace/arena/lib/waveyard/measure/pcm";
import type { SeparationJobPayload } from "@workspace/arena/lib/waveyard/types";
import {
  demixMdx,
  findMdxModel,
  findSeparationRecipe,
  type MdxStageTimings,
  type MdxInfer,
  type MdxModelSpec,
  type SeparatedStems,
} from "@workspace/arena/lib/waveyard/separation/mdx";
import { runDeepSeparation } from "@workspace/arena/lib/waveyard/separation/deep";
import { DEEP_MODEL_ID, isDeepSeparationMode } from "@workspace/arena/lib/waveyard/separation/modes";
import {
  createSessionWithProviderFallback,
  loadOrtModule,
  sessionInfer,
  SeparationUnavailableError,
  WAVEYARD_ORT_EXECUTION_MODE,
  WAVEYARD_ORT_INTER_OP_THREADS,
  WAVEYARD_ORT_INTRA_OP_THREADS,
  verifyModelFile,
} from "@workspace/arena/lib/waveyard/separation/session";
import { DependencyMissingError } from "@workspace/arena/lib/waveyard/measure/pcm";

/** Everything the handler needs from the outside world, injectable so the
 *  e2e test runs the FULL pipeline (decode → demix → encode → persist)
 *  with a fake inference session and a PGlite database. */
export type SeparationHandlerDeps = {
  db?: ReturnType<typeof drizzle>;
  /** The local broker aborts this when the owner stops a running job. */
  signal?: AbortSignal;
  /** Opens the verified model and returns the inference seam. */
  openEngine?: (spec: MdxModelSpec, requestedDevice: "auto" | "cpu" | "cuda") => Promise<OpenedEngine>;
  decode?: typeof decodeSourceToStereoPcm;
  enqueueWaveform?: typeof enqueueWaveform;
  /** The deep pass (owner-prepared Demucs, separation/deep.ts). Injectable
   *  so the e2e test drives the FULL pipeline with a stub engine. */
  runDeep?: typeof runDeepSeparation;
  /** Measurement seam for worker-side inference stage timings. */
  onInferenceTiming?: (modelId: string, timings: MdxStageTimings) => void;
};

export type OpenedEngine = {
  infer: MdxInfer;
  release(): Promise<void>;
  resolvedDevice: string;
};

/** Production engine opener: verify the model file's checksum, then create
 *  an onnxruntime session using the requested device policy. */
async function defaultOpenEngine(spec: MdxModelSpec, requestedDevice: "auto" | "cpu" | "cuda"): Promise<OpenedEngine> {
  // Throws the honest unavailable error before anything else when the model
  // is missing/corrupt (seeding is the model manager's job, not inference's).
  const modelPath = await verifyModelFile(spec);
  const ort = await loadOrtModule();
  if (!ort) {
    throw new SeparationUnavailableError(
      "onnxruntime-node is not available in this installation — the separation engine cannot run. " +
        "Reinstall the app; if it persists, this build is missing its inference runtime.",
    );
  }
  try {
    const { session, resolvedDevice } = await createSessionWithProviderFallback(
      (executionProviders) => ort.InferenceSession.create(modelPath, {
        executionProviders,
        // Leave one CPU available on larger machines for playback and app work.
        intraOpNumThreads: WAVEYARD_ORT_INTRA_OP_THREADS,
        interOpNumThreads: WAVEYARD_ORT_INTER_OP_THREADS,
        executionMode: WAVEYARD_ORT_EXECUTION_MODE,
        enableCpuMemArena: true,
        enableMemPattern: true,
      }),
      requestedDevice,
    );
    return {
      infer: sessionInfer(session, (type, data, dims) => new ort.Tensor(type, data, dims)),
      release: async () => {
        await session.release();
      },
      resolvedDevice,
    };
  } catch (error) {
    throw new SeparationUnavailableError(
      `Could not open separation model "${spec.id}" for inference: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

type WorkerDemixResult = {
  separated: SeparatedStems;
  resolvedDevice: string;
  timings: MdxStageTimings;
};

export class SeparationCancelledError extends Error {
  constructor() {
    super("Separation was cancelled.");
    this.name = "SeparationCancelledError";
  }
}

function separationWorkerLocation(): { filename: string } {
  const currentFile = fileURLToPath(import.meta.url);
  const candidates = [
    join(dirname(currentFile), "waveyard-separation-worker.mjs"),
    resolve(process.cwd(), "artifacts/api-server/dist/waveyard-separation-worker.mjs"),
    resolve(process.cwd(), "../artifacts/api-server/dist/waveyard-separation-worker.mjs"),
    resolve(process.cwd(), "../../artifacts/api-server/dist/waveyard-separation-worker.mjs"),
  ];
  const bundledWorker = candidates.find((candidate) => existsSync(candidate));
  if (bundledWorker !== undefined) return { filename: bundledWorker };
  throw new SeparationUnavailableError(
    "The isolated separation worker is not installed in this API build. Rebuild the API server and retry separation.",
  );
}

export function demixMdxInWorker(
  spec: MdxModelSpec,
  requestedDevice: "auto" | "cpu" | "cuda",
  mix: Float32Array[],
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<WorkerDemixResult> {
  if (signal?.aborted) return Promise.reject(new SeparationCancelledError());
  const target = separationWorkerLocation();
  // Keep the decoded mix available for every model in a multi-stem recipe.
  const left = mix[0].slice();
  const right = mix[1].slice();

  return new Promise((resolveResult, rejectResult) => {
    const worker = new Worker(target.filename, {
      workerData: { spec, requestedDevice, left: left.buffer, right: right.buffer },
      transferList: [left.buffer, right.buffer],
    });
    let settled = false;
    let result: WorkerDemixResult | undefined;
    let workerError: Error | undefined;
    let termination: Promise<number> | undefined;
    const onAbort = () => {
      if (settled || termination !== undefined) return;
      // Await the actual worker exit before allowing the job to become
      // terminal; this is what releases its ONNX session and native resources.
      termination = worker.terminate();
      void termination.then(
        () => settle(() => rejectResult(new SeparationCancelledError())),
        // A failed terminate request is not evidence of exit. Keep the handler
        // pending until the worker emits exit; the broker then reports a
        // timeout instead of freeing the target for a duplicate run.
        () => undefined,
      );
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    worker.on("message", (message: Record<string, unknown>) => {
      if (settled || signal?.aborted) return;
      if (message.type === "progress") {
        onProgress(Number(message.done), Number(message.total));
        return;
      }
      if (message.type === "error") {
        workerError =
          message.errorCode === "SEPARATION_UNAVAILABLE"
            ? new SeparationUnavailableError(String(message.message))
            : new Error(String(message.message));
        return;
      }
      if (message.type === "result") {
        result = {
          separated: message.separated as SeparatedStems,
          resolvedDevice: String(message.resolvedDevice),
          timings: message.timings as MdxStageTimings,
        };
      }
    });
    worker.once("error", (error) => {
      if (!signal?.aborted) workerError = error instanceof Error ? error : new Error(String(error));
    });
    worker.once("exit", (code) => {
      if (signal?.aborted) {
        settle(() => rejectResult(new SeparationCancelledError()));
      } else if (code !== 0) {
        settle(() => rejectResult(workerError ?? new Error(`Separation inference worker exited with code ${code}.`)));
      } else if (workerError) {
        settle(() => rejectResult(workerError!));
      } else if (result) {
        settle(() => resolveResult(result!));
      } else {
        settle(() => rejectResult(new Error("Separation inference worker exited before returning a result (code 0).")));
      }
    });
  });
}

async function updateJob(
  database: NonNullable<SeparationHandlerDeps["db"]>,
  id: string,
  patch: Partial<typeof processingJobs.$inferInsert>,
) {
  await database
    .update(processingJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(
      eq(processingJobs.id, id),
      ne(processingJobs.status, "complete"),
      ne(processingJobs.status, "cancelled"),
      ne(processingJobs.stage, "cancelling"),
    ));
}

async function updateJobUnlessComplete(
  database: NonNullable<SeparationHandlerDeps["db"]>,
  id: string,
  patch: Partial<typeof processingJobs.$inferInsert>,
) {
  await database
    .update(processingJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(processingJobs.id, id), ne(processingJobs.status, "complete")));
}

async function markJobCancelled(
  database: NonNullable<SeparationHandlerDeps["db"]>,
  id: string,
) {
  await database
    .update(processingJobs)
    .set({
      status: "cancelled",
      stage: "cancelled",
      errorCode: null,
      errorMessage: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(processingJobs.id, id),
      ne(processingJobs.status, "complete"),
      ne(processingJobs.status, "failed"),
      ne(processingJobs.status, "cancelled"),
    ));
}

async function assertSeparationNotCancelled(
  database: NonNullable<SeparationHandlerDeps["db"]>,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new SeparationCancelledError();
  const [current] = await database
    .select({ status: processingJobs.status, stage: processingJobs.stage })
    .from(processingJobs)
    .where(eq(processingJobs.id, id))
    .limit(1);
  if (!current) throw new Error("Processing job no longer exists.");
  if (current.status === "cancelled" || current.stage === "cancelling") {
    throw new SeparationCancelledError();
  }
}

async function readSeparationPublication(
  database: NonNullable<SeparationHandlerDeps["db"]>,
  id: string,
) {
  try {
    const [job] = await database
      .select({ status: processingJobs.status })
      .from(processingJobs)
      .where(eq(processingJobs.id, id));
    const rows = await database
      .select({ storageKey: stemAssets.storageKey })
      .from(stemAssets)
      .where(eq(stemAssets.separationJobId, id));
    return {
      status: job?.status ?? null,
      referencedKeys: new Set(rows.map((row) => row.storageKey)),
    };
  } catch {
    // Unknown publication state is not permission to delete output files.
    return null;
  }
}

async function rememberUncertainCleanup(
  database: NonNullable<SeparationHandlerDeps["db"]>,
  id: string,
  keys: string[],
  message: string,
  fallbackMetadata?: string | null,
) {
  if (keys.length === 0) return;
  let metadata = fallbackMetadata;
  try {
    const [job] = await database
      .select({ status: processingJobs.status, metadata: processingJobs.metadata })
      .from(processingJobs)
      .where(eq(processingJobs.id, id));
    if (!job || job.status === "complete") return;
    metadata = job.metadata;
  } catch {
    // The status guard below prevents overwriting a completed job if this read
    // is unavailable. Retain the original metadata plus cleanup keys.
  }
  try {
    await updateJobUnlessComplete(database, id, {
      errorMessage: message,
      metadata: JSON.stringify({
        ...jobMetadata(metadata),
        cleanupFailedKeys: [
          ...new Set([
            ...(Array.isArray(jobMetadata(metadata).cleanupFailedKeys)
              ? (jobMetadata(metadata).cleanupFailedKeys as string[])
              : []),
            ...keys,
          ]),
        ],
      }),
    });
  } catch {
    // Preserve the objects even when the database cannot record reconciliation
    // metadata. Startup's age-bounded orphan cleanup can reclaim them later.
  }
}

async function cleanupUnpublishedOutputs(
  database: NonNullable<SeparationHandlerDeps["db"]>,
  id: string,
  keys: string[],
  storage: ReturnType<typeof getStorage>,
  fallbackMetadata?: string | null,
) {
  if (keys.length === 0) return;
  const publication = await readSeparationPublication(database, id);
  if (!publication) {
    await rememberUncertainCleanup(
      database,
      id,
      keys,
      "Separation output was retained because publication status could not be verified. Cleanup keys are recorded for reconciliation.",
      fallbackMetadata,
    );
    return;
  }
  if (publication.status === "complete") {
    const unreferenced = keys.filter((key) => !publication.referencedKeys.has(key));
    if (unreferenced.length > 0) {
      await rememberUncertainCleanup(
        database,
        id,
        unreferenced,
        "Separation is complete; unreferenced output was retained because the published stem set did not match the worker output.",
        fallbackMetadata,
      );
    }
    return;
  }

  const unreferenced = keys.filter((key) => !publication.referencedKeys.has(key));
  const results = await Promise.allSettled(unreferenced.map((key) => storage.delete(key)));
  const failedKeys = unreferenced.filter((_, index) => results[index]?.status === "rejected");
  if (failedKeys.length > 0) {
    await rememberUncertainCleanup(
      database,
      id,
      failedKeys,
      "Separation stopped without publishing these output objects. Cleanup keys are recorded for reconciliation.",
      fallbackMetadata,
    );
  }
}

function interleavePlanar(channels: Float32Array[]): Float32Array {
  const frames = channels[0].length;
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    out[i * 2] = channels[0][i];
    out[i * 2 + 1] = channels[1][i];
  }
  return out;
}

/** Local separation execution — same lifecycle the BullMQ worker drives. */
export async function handleSeparationJob(payloadInput: Record<string, unknown>, deps: SeparationHandlerDeps = {}): Promise<void> {
  const payload = payloadInput as unknown as SeparationJobPayload;
  type WaveyardDb = NonNullable<SeparationHandlerDeps["db"]>;
  const database: WaveyardDb = deps.db
    ? deps.db
    : ((await import("@workspace/db")) as unknown as { db: WaveyardDb }).db;
  const decode = deps.decode ?? decodeSourceToStereoPcm;
  const openEngine = deps.openEngine ?? defaultOpenEngine;
  const runDeep = deps.runDeep ?? runDeepSeparation;

  const [job] = await database.select().from(processingJobs).where(eq(processingJobs.id, payload.processingJobId)).limit(1);
  if (!job) throw new Error("Processing job no longer exists.");
  if (job.status === "complete" || job.status === "cancelled") return;
  if (
    job.projectId !== payload.projectId ||
    job.sourceAssetId !== payload.sourceAssetId ||
    job.model !== payload.model ||
    job.requestedDevice !== payload.requestedDevice
  ) {
    await updateJob(database, job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "invalid_payload",
      errorMessage: "Separation queue payload does not match its durable job target.",
      completedAt: new Date(),
    });
    throw new Error("Separation payload does not match its durable job target.");
  }

  // A job targets one registry model (its two stems), a RECIPE (one run per
  // stem — e.g. stems_4: Kim vocals + one Kuielab model each for
  // drums/bass/other, every run on the full mix, primary-only), or the DEEP
  // mode — the owner-prepared Demucs bridge (six sources). The deep branch
  // hooks in BEFORE the registry lookup, so `deep_6s` is never mistaken for
  // an unknown model.
  type SeparationRun = { spec: MdxModelSpec; stemType: string; take: "primary" | "secondary" };
  const runs: SeparationRun[] = [];
  const deepPass = isDeepSeparationMode(payload.model);
  const recipe = deepPass ? undefined : findSeparationRecipe(payload.model);
  if (deepPass) {
    // No MDX runs: the deep engine produces all six sources itself.
  } else if (recipe !== undefined) {
    for (const run of recipe.runs) {
      const runSpec = findMdxModel(run.model);
      if (runSpec === undefined) throw new Error(`Recipe ${recipe.id} references unknown model ${run.model}.`);
      runs.push({ spec: runSpec, stemType: run.stemType, take: run.take });
    }
  } else {
    const spec = findMdxModel(payload.model);
    if (!spec) {
      await updateJob(database, job.id, {
        status: "failed",
        stage: "failed",
        errorCode: "unknown_model",
        errorMessage:
          `The separation model "${payload.model}" is not known to this machine's engine. ` +
          "Separation runs the model this app ships with — no configuration is needed.",
        completedAt: new Date(),
      });
      throw new Error(`Unknown separation model: ${payload.model}`);
    }
    runs.push(
      { spec, stemType: spec.primaryStem, take: "primary" },
      { spec, stemType: spec.secondaryStem, take: "secondary" },
    );
  }

  const [source] = await database
    .select()
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, payload.sourceAssetId), eq(sourceAssets.projectId, payload.projectId)))
    .limit(1);
  if (!source) {
    await updateJob(database, job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "source_missing",
      errorMessage: "Authorized source asset is missing.",
      completedAt: new Date(),
    });
    throw new Error("Authorized source asset is missing.");
  }

  // RECURSIVE SEPARATION (stem layers): the input is a STEM, not the
  // source — outputs are named "<parent>/<child>" (e.g. "other/vocals" =
  // backing vocals pulled out of the melody stem).
  let parentStem: typeof stemAssets.$inferSelect | null = null;
  if (payload.parentStemAssetId !== undefined) {
    const [stem] = await database
      .select()
      .from(stemAssets)
      .where(and(eq(stemAssets.id, payload.parentStemAssetId), eq(stemAssets.projectId, payload.projectId)))
      .limit(1);
    if (!stem) {
      await updateJob(database, job.id, {
        status: "failed",
        stage: "failed",
        errorCode: "source_missing",
        errorMessage: "The parent stem this layer job targets is missing.",
        completedAt: new Date(),
      });
      throw new Error("Parent stem asset is missing.");
    }
    parentStem = stem;
    for (const run of runs) run.stemType = `${stem.stemType}/${run.stemType}`;
  }
  /** Layer naming: deep stems get the same "<parent>/<child>" treatment. */
  const nameStem = (child: string) => (parentStem === null ? child : `${parentStem.stemType}/${child}`);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), `arena-separation-${process.pid}-`));
  const inputPath = join(temporaryDirectory, "source-upload");
  const storage = getStorage();
  const uploadedKeys: string[] = [];
  let completed = false;
  let progressWrite = Promise.resolve();
  const persistProgress = (progress: Record<string, unknown>) => {
    const metadata = JSON.stringify({ ...jobMetadata(job.metadata), progress });
    progressWrite = progressWrite
      .catch(() => undefined)
      .then(() => updateJob(database, job.id, { metadata }))
      .catch(() => undefined);
  };
  const flushProgress = () => progressWrite;

  try {
    await assertSeparationNotCancelled(database, job.id, deps.signal);
    await updateJob(database, job.id, {
      status: "preparing",
      stage: "preparing",
      startedAt: new Date(),
      errorCode: null,
      errorMessage: null,
      metadata: JSON.stringify({ ...jobMetadata(job.metadata), progress: null }),
    });
    await assertSeparationNotCancelled(database, job.id, deps.signal);
    await storage.getToFile((parentStem ?? source).storageKey, inputPath);
    await assertSeparationNotCancelled(database, job.id, deps.signal);

    await updateJob(database, job.id, {
      status: "processing",
      stage: "separating",
      attempts: (job.attempts ?? 0) + 1,
    });
    // The engine is trained at 44.1 kHz — decode demands exactly that
    // (native WAV at other rates falls through to ffmpeg resampling).
    const decoded = await decode(inputPath, {}, {}, { requireSampleRate: 44_100 });
    await assertSeparationNotCancelled(database, job.id, deps.signal);
    if (decoded.sampleRate !== 44_100) {
      throw new Error(`Decoder returned ${decoded.sampleRate} Hz — the engine requires 44100 Hz.`);
    }
    const frames = decoded.pcm.length >> 1;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      left[i] = decoded.pcm[i * 2];
      right[i] = decoded.pcm[i * 2 + 1];
    }

    // One inference pass per DISTINCT model. Each MDX pass produces both
    // primary and secondary stems, so separate output rows that use the same
    // model must share that result instead of rerunning the expensive model.
    // The deep pass opens no MDX engine at all — its engine is the
    // owner-prepared bridge, and its outputs land as six WAV files.
    type OpenedEngines = Awaited<ReturnType<typeof openEngine>>;
    type StemOutput = { stemType: string; channels: Float32Array[]; model: string; modelVersion: string; sampleCount: number };
    const stemOutputs: StemOutput[] = [];
    let resolvedDevice: string | null = null;
    let engineKind: "mdx" | "demucs" = "mdx";
    let runModels: string[] = [];

    if (deepPass) {
      engineKind = "demucs";
      runModels = [DEEP_MODEL_ID];
      // Demucs reads a FILE, so hand it the exact PCM this handler already
      // decoded (44.1 kHz stereo) — never the raw stored container, whose
      // decode-ability would otherwise be the owner's engine's problem.
      const deepInputPath = join(temporaryDirectory, "deep-input.wav");
      await writeFile(deepInputPath, encodeWav16(decoded.pcm, 44_100));
      // The engine's own percent into the durable row's metadata (same
      // contract as the MDX path): the deep pass reports real progress.
      let lastDeepPercent = -1;
      const deep = await runDeep({
        inputPath: deepInputPath,
        outputDirectory: join(temporaryDirectory, "deep-output"),
        requestedDevice: payload.requestedDevice,
        onProgress: (percent) => {
          if (percent === lastDeepPercent) return;
          lastDeepPercent = percent;
          persistProgress({ done: percent, total: 100, percent, phase: "deep", model: DEEP_MODEL_ID });
        },
      });
      resolvedDevice = deep.resolvedDevice;
      for (const stem of deep.stems) {
        // The bridge guarantees six WAV files; the handler still verifies
        // each one is exactly what persistence will claim (16-bit stereo
        // 44.1 kHz) — a corrupt output must never become a stem row.
        const decodedStem = decodeWav16(new Uint8Array(await readFile(stem.path)));
        if (decodedStem === null) {
          throw new Error(`The deep engine's ${stem.stemType} stem is not a readable 16-bit PCM WAV.`);
        }
        if (decodedStem.sampleRate !== 44_100) {
          throw new Error(`The deep engine's ${stem.stemType} stem is ${decodedStem.sampleRate} Hz — the pipeline stores 44100 Hz.`);
        }
        if (decodedStem.channels !== 2) {
          throw new Error(`The deep engine's ${stem.stemType} stem has ${decodedStem.channels} channels — the pipeline stores stereo.`);
        }
        const stemFrames = decodedStem.frames;
        const stemLeft = new Float32Array(stemFrames);
        const stemRight = new Float32Array(stemFrames);
        for (let i = 0; i < stemFrames; i += 1) {
          stemLeft[i] = decodedStem.samples[i * 2];
          stemRight[i] = decodedStem.samples[i * 2 + 1];
        }
        stemOutputs.push({
          stemType: nameStem(stem.stemType),
          channels: [stemLeft, stemRight],
          model: DEEP_MODEL_ID,
          modelVersion: deep.modelVersion,
          sampleCount: stemFrames,
        });
      }
    } else {
      const groups = new Map<string, { spec: MdxModelSpec; outputs: typeof runs }>();
      for (const run of runs) {
        const existing = groups.get(run.spec.id);
        if (existing) {
          existing.outputs.push(run);
        } else {
          groups.set(run.spec.id, { spec: run.spec, outputs: [run] });
        }
      }
      const modelRuns = [...groups.values()];
      const orderByRun = new Map(runs.map((run, index) => [run, index] as const));
      const orderedOutputs: { order: number; output: StemOutput }[] = [];
      {
        // Real progress across ALL distinct model passes:
        // chunk-level updates into the durable row's metadata, throttled to
        // whole GLOBAL percents + the first and last chunk of each run.
        let lastReportedPercent = -1;
        for (let runIndex = 0; runIndex < modelRuns.length; runIndex += 1) {
          await assertSeparationNotCancelled(database, job.id, deps.signal);
          const modelRun = modelRuns[runIndex]!;
          const passPercent = Math.floor((runIndex / modelRuns.length) * 100);
          persistProgress({
            done: runIndex,
            total: modelRuns.length,
            percent: passPercent,
            phase: `${runIndex + 1}/${modelRuns.length}`,
            model: modelRun.spec.id,
            kind: "model-pass",
          });
          await flushProgress();

          if (deps.openEngine === undefined) {
            const separated = await demixMdxInWorker(modelRun.spec, payload.requestedDevice, [left, right], (done, total) => {
              const runFraction = total > 0 ? done / total : 1;
              const percent = Math.floor(((runIndex + runFraction) / modelRuns.length) * 100);
              if (done !== 1 && done !== total && percent === lastReportedPercent) return;
              lastReportedPercent = percent;
              persistProgress({
                done,
                total,
                percent,
                phase: `${runIndex + 1}/${modelRuns.length}`,
                model: modelRun.spec.id,
                kind: "chunk",
              });
            }, deps.signal);
            await assertSeparationNotCancelled(database, job.id, deps.signal);
            deps.onInferenceTiming?.(modelRun.spec.id, separated.timings);
            resolvedDevice = separated.resolvedDevice;
            for (const run of modelRun.outputs) {
              orderedOutputs.push({
                order: orderByRun.get(run)!,
                output: {
                  stemType: run.stemType,
                  channels: run.take === "primary" ? separated.separated.primary : separated.separated.secondary,
                  model: modelRun.spec.id,
                  modelVersion: modelRun.spec.sha256,
                  sampleCount: separated.separated.sampleCount,
                },
              });
            }
            continue;
          }

          const engine = await openEngine(modelRun.spec, payload.requestedDevice);
          try {
            resolvedDevice = engine.resolvedDevice;
            let timings: MdxStageTimings | undefined;
            const separated = await demixMdx([left, right], modelRun.spec, engine.infer, (done, total) => {
              const runFraction = total > 0 ? done / total : 1;
              const percent = Math.floor(((runIndex + runFraction) / modelRuns.length) * 100);
              if (done !== 1 && done !== total && percent === lastReportedPercent) return;
              lastReportedPercent = percent;
              persistProgress({
                done,
                total,
                percent,
                phase: `${runIndex + 1}/${modelRuns.length}`,
                model: modelRun.spec.id,
                kind: "chunk",
              });
            }, (measured) => {
              timings = measured;
            });
            if (timings) deps.onInferenceTiming?.(modelRun.spec.id, timings);
            for (const run of modelRun.outputs) {
              orderedOutputs.push({
                order: orderByRun.get(run)!,
                output: {
                  stemType: run.stemType,
                  channels: run.take === "primary" ? separated.primary : separated.secondary,
                  model: modelRun.spec.id,
                  modelVersion: modelRun.spec.sha256,
                  sampleCount: separated.sampleCount,
                },
              });
            }
          } finally {
            // Release BEFORE opening the next model, including failed runs.
            await engine.release().catch(() => undefined);
          }
        }
      }
      orderedOutputs.sort((leftOutput, rightOutput) => leftOutput.order - rightOutput.order);
      stemOutputs.push(...orderedOutputs.map(({ output }) => output));
      runModels = [...new Set(runs.map((run) => run.spec.id))];
    }

    await flushProgress().catch(() => undefined);
    await assertSeparationNotCancelled(database, job.id, deps.signal);
    await updateJob(database, job.id, {
      status: "finalizing",
      stage: "validating",
      resolvedDevice,
    });
    const values: (typeof stemAssets.$inferInsert)[] = [];
    for (const stem of stemOutputs) {
      await assertSeparationNotCancelled(database, job.id, deps.signal);
      const wav = encodeWav16(interleavePlanar(stem.channels), 44_100);
      // Layered stem types ("other/vocals") must become safe filenames.
      const stemPath = join(temporaryDirectory, `${stem.stemType.replace(/[^a-zA-Z0-9_-]+/g, "-")}.wav`);
      await writeFile(stemPath, wav);
      const checksum = await checksumFile(stemPath);
      const storageKey = privateObjectKey(job.projectId, "stem", "wav");
      // A storage provider may write the object and then lose its acknowledgement.
      uploadedKeys.push(storageKey);
      await storage.putFile(storageKey, stemPath, "audio/wav");
      await assertSeparationNotCancelled(database, job.id, deps.signal);
      values.push({
        projectId: job.projectId,
        sourceAssetId: source.id,
        separationJobId: job.id,
        stemType: stem.stemType,
        engine: engineKind,
        model: stem.model,
        modelVersion: stem.modelVersion,
        storageKey,
        checksumSha256: checksum,
        durationSeconds: Math.round(stem.sampleCount / 44_100),
        sampleRate: 44_100,
        channels: 2,
        codec: "pcm_s16le",
        format: "wav",
        fileSizeBytes: wav.length,
      });
    }

    const durableWork = await database.transaction(async (tx) => {
      const [claimed] = await tx
        .update(processingJobs)
        .set({
          status: "complete",
          stage: "complete",
          completedAt: new Date(),
          updatedAt: new Date(),
          metadata: JSON.stringify({
            engine: engineKind,
            model: job.model,
            models: runModels,
            resolvedDevice,
            outputCount: values.length,
            stems: stemOutputs.map((stem) => stem.stemType),
          }),
        })
        .where(and(
          eq(processingJobs.id, job.id),
          ne(processingJobs.status, "complete"),
          ne(processingJobs.status, "cancelled"),
          ne(processingJobs.stage, "cancelling"),
        ))
        .returning({ id: processingJobs.id });
      if (!claimed) throw new SeparationCancelledError();
      // Retry idempotency: a re-run replaces its stems atomically.
      await tx.delete(stemAssets).where(eq(stemAssets.separationJobId, job.id));
      const storedStems = await tx
        .insert(stemAssets)
        .values(values)
        .returning({ id: stemAssets.id });
      const waveformWork = await tx
        .insert(waveformJobs)
        .values(
          storedStems.map((stem) => ({
            projectId: job.projectId,
            stemAssetId: stem.id,
            status: "queued",
            stage: "queued",
            idempotencyKey: `waveform:stem:${stem.id}`,
          })),
        )
        .returning({ id: waveformJobs.id, stemAssetId: waveformJobs.stemAssetId });
      return waveformWork;
    });
    // Separation is complete even if a later derived-artifact queue needs
    // a retry. Each durable job records its own failure boundary.
    for (const waveformJob of durableWork) {
      try {
        await (deps.enqueueWaveform ?? enqueueWaveform)({
          waveformJobId: waveformJob.id,
          projectId: job.projectId,
          stemAssetId: waveformJob.stemAssetId!,
        });
      } catch (queueError) {
        await database
          .update(waveformJobs)
          .set({
            status: "failed",
            stage: "queue-unavailable",
            errorCode: "queue_unavailable",
            errorMessage: queueError instanceof Error ? queueError.message.slice(0, 1000) : "Queue unavailable.",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(waveformJobs.id, waveformJob.id));
      }
    }
    completed = true;
  } catch (error) {
    await flushProgress();
    const publication = await readSeparationPublication(database, job.id);
    const commitWasConfirmed =
      publication?.status === "complete" &&
      uploadedKeys.length > 0 &&
      uploadedKeys.every((key) => publication.referencedKeys.has(key));
    if (commitWasConfirmed) {
      // The transaction committed; only its acknowledgement was lost. The
      // durable job and stem rows are the source of truth, not this promise.
      completed = true;
      return;
    }
    const [current] = await database
      .select({ status: processingJobs.status, stage: processingJobs.stage })
      .from(processingJobs)
      .where(eq(processingJobs.id, job.id))
      .limit(1);
    if (
      error instanceof SeparationCancelledError ||
      deps.signal?.aborted ||
      current?.status === "cancelled" ||
      current?.stage === "cancelling"
    ) {
      await markJobCancelled(database, job.id);
      return;
    }
    let errorCode = "separation_failed";
    if (error instanceof SeparationUnavailableError) errorCode = "separation_unavailable";
    else if (error instanceof DependencyMissingError) errorCode = "dependency_missing";
    else if (error instanceof Error && /44100/.test(error.message)) errorCode = "decode_failed";
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown separation failure.";
    await updateJob(database, job.id, {
      status: "failed",
      stage: "failed",
      errorCode,
      errorMessage: message,
      completedAt: new Date(),
    });
    throw error;
  } finally {
    if (!completed) {
      await cleanupUnpublishedOutputs(database, job.id, uploadedKeys, storage, job.metadata);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function jobMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
