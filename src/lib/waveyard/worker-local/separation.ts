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
 * checks; immutable bank publication on successful retry; one waveform job per
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

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, notInArray, inArray, sql } from "drizzle-orm";

import type { drizzle } from "drizzle-orm/node-postgres";

import { processingJobs, sourceAssets, stemAssets, waveformJobs } from "@/db/waveyardSchema";
import { checksumFile } from "@/lib/waveyard/audio";
import { decodeWav16, encodeWav16 } from "@/lib/waveyard/mixer/synth";
import { getStorage, privateObjectKey } from "@/lib/waveyard/storage";
import { enqueueWaveform } from "@/lib/waveyard/queue";
import { decodeSourceToStereoPcm } from "@/lib/waveyard/measure/pcm";
import type { SeparationJobPayload } from "@/lib/waveyard/types";
import { demixMdx, findMdxModel, findSeparationRecipe, type MdxInfer, type MdxModelSpec } from "@/lib/waveyard/separation/mdx";
import { runDeepSeparation } from "@/lib/waveyard/separation/deep";
import { executionHistory, newExecution, ownerIdentity, saveExecution, publishBank, validateExecutionOutputs, metadata as recoveryMetadata } from "../separation/recovery";
import { deepModelSpec } from "../separation/modes";
import { isDeepSeparationMode } from "@/lib/waveyard/separation/modes";
import {
  loadOrtModule,
  sessionInfer,
  SeparationUnavailableError,
  verifyModelFile,
  type MdxSessionLike,
} from "@/lib/waveyard/separation/session";
import { DependencyMissingError } from "@/lib/waveyard/measure/pcm";

/** Everything the handler needs from the outside world, injectable so the
 *  e2e test runs the FULL pipeline (decode → demix → encode → persist)
 *  with a fake inference session and a PGlite database. */
export type SeparationHandlerDeps = {
  db?: ReturnType<typeof drizzle>;
  /** Trusted crash-test seam; never selectable through a product request. */
  boundary?: (phase: string) => Promise<void>;
  /** Opens the verified model and returns the inference seam. */
  openEngine?: (spec: MdxModelSpec, requestedDevice: "auto" | "cpu" | "cuda") => Promise<OpenedEngine>;
  decode?: typeof decodeSourceToStereoPcm;
  /** The deep pass (owner-prepared Demucs, separation/deep.ts). Injectable
   *  so the e2e test drives the FULL pipeline with a stub engine. */
  runDeep?: typeof runDeepSeparation;
};

export type OpenedEngine = {
  infer: MdxInfer;
  release(): Promise<void>;
  resolvedDevice: string;
};

/** Production engine opener: verify the model file's checksum, then create
 *  an onnxruntime session. V1 executes on the CPU provider — a requested
 *  CUDA device honestly falls back (resolvedDevice records what actually
 *  ran, never silently pretending). */
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
  const attempts: string[][] = requestedDevice === "cuda" ? [["cuda"], ["cpu"]] : [["cpu"]];
  let lastError: unknown = null;
  for (const executionProviders of attempts) {
    try {
      const session: MdxSessionLike = await ort.InferenceSession.create(modelPath, { executionProviders });
      return {
        infer: sessionInfer(session, (type, data, dims) => new ort.Tensor(type, data, dims)),
        release: async () => {
          await session.release();
        },
        resolvedDevice: executionProviders[0],
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new SeparationUnavailableError(
    `Could not open separation model "${spec.id}" for inference: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function updateJob(
  database: NonNullable<SeparationHandlerDeps["db"]>,
  id: string,
  patch: Partial<typeof processingJobs.$inferInsert>,
) {
  await database
    .update(processingJobs)
    .set({ ...patch, ...(patch.metadata ? { metadata: sql`(${processingJobs.metadata}::jsonb || ${JSON.stringify(Object.fromEntries(Object.entries(recoveryMetadata(patch.metadata)).filter(([key]) => !["execution", "executionHistory", "recoveryHistory"].includes(key))))}::jsonb)::text` } : {}), updatedAt: new Date() })
    .where(and(eq(processingJobs.id, id), notInArray(processingJobs.status, ["complete", "failed", "cancelling", "cancelled"])));
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
    : ((await import("@/db")) as unknown as { db: WaveyardDb }).db;
  const decode = deps.decode ?? decodeSourceToStereoPcm;
  const openEngine = deps.openEngine ?? defaultOpenEngine;
  const runDeep = deps.runDeep ?? runDeepSeparation;

  const [job] = await database.select().from(processingJobs).where(eq(processingJobs.id, payload.processingJobId)).limit(1);
  if (!job) throw new Error("Processing job no longer exists.");
  if (job.status !== "queued") return;
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

  const execution = await newExecution(deepPass ? deepModelSpec(payload.model).stems.length : runs.length);
  execution.input = { key: (parentStem ?? source).storageKey, checksum: (parentStem ?? source).checksumSha256, sourceChecksum: source.checksumSha256 };
  const phase = async (name: string) => { execution.phase = name; await saveExecution(database, job.id, execution); await deps.boundary?.(name); };
  const temporaryDirectory = join(tmpdir(), `arena-separation-${execution.id}-work`);
  execution.workDirectory = temporaryDirectory;
  execution.cleanupPending = true;
  const inputPath = join(temporaryDirectory, "source-upload");
  const storage = getStorage();
  const uploadedKeys: string[] = [];
  let completed = false;
  let ownsAttempt = false;
  const controller = new AbortController();
  const checkCancellation = async () => {
    const [current] = await database.select({ status: processingJobs.status }).from(processingJobs).where(eq(processingJobs.id, job.id)).limit(1);
    if (!current || ["cancelling", "cancelled"].includes(current.status)) controller.abort(new DOMException("Separation cancelled", "AbortError"));
    controller.signal.throwIfAborted();
  };
  // Serial polling, never overlapping DB reads. Durable status is the authority,
  // not an in-memory controller lost on page reload.
  let stopped = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const pollCancellation = async () => {
    try { await checkCancellation(); } catch (error) { controller.abort(error); }
    if (!stopped && !controller.signal.aborted) poll = setTimeout(() => { polling = pollCancellation(); }, 250);
  };
  let polling = pollCancellation();

  try {
    await checkCancellation();
    await deps.boundary?.("before-claim");
    const [claimed] = await database.update(processingJobs).set({ status: "preparing", stage: "preparing", startedAt: new Date(), updatedAt: new Date(), errorCode: null, errorMessage: null, metadata: sql`(${processingJobs.metadata}::jsonb || ${JSON.stringify({ executionHistory: executionHistory(job), execution })}::jsonb)::text` })
      .where(and(eq(processingJobs.id, job.id), eq(processingJobs.status, "queued"))).returning({ id: processingJobs.id });
    if (!claimed) return;
    ownsAttempt = true;
    await deps.boundary?.("claimed");
    await mkdir(temporaryDirectory, { mode: 0o700 });
    await storage.getToFile((parentStem ?? source).storageKey, inputPath);
    await checkCancellation();
    if (await checksumFile(inputPath) !== (parentStem ?? source).checksumSha256) {
      throw new Error("Stored separation input no longer matches its verified source checksum; re-import the recording.");
    }

    await updateJob(database, job.id, {
      status: "processing",
      stage: "separating",
      attempts: (job.attempts ?? 0) + 1,
    });
    // The engine is trained at 44.1 kHz — decode demands exactly that
    // (native WAV at other rates falls through to ffmpeg resampling).
    const decoded = await decode(inputPath, {}, {}, { requireSampleRate: 44_100, signal: controller.signal, onSpawn: async pid => {
      await deps.boundary?.("decoder-unregistered");
      execution.child = await ownerIdentity(pid);
      await phase("decoder-registered");
    } });
    if (decoded.sampleRate !== 44_100) {
      throw new Error(`Decoder returned ${decoded.sampleRate} Hz — the engine requires 44100 Hz.`);
    }
    await checkCancellation();
    const frames = decoded.pcm.length >> 1;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      left[i] = decoded.pcm[i * 2];
      right[i] = decoded.pcm[i * 2 + 1];
    }

    // One engine per DISTINCT model (recipes may repeat a model; open once).
    // The deep pass opens no MDX engine at all — its engine is the
    // owner-prepared bridge, and its outputs land as six WAV files.
    type OpenedEngines = Awaited<ReturnType<typeof openEngine>>;
    type StemOutput = { stemType: string; channels: Float32Array[]; model: string; modelVersion: string; sampleCount: number };
    const stemOutputs: StemOutput[] = [];
    let resolvedDevice: string | null = null;
    let engineKind: "mdx" | "demucs" = "mdx";
    let runModels: string[] = [];
    let checkpointSha256: string | null = null;

    execution.frames = frames;
    await phase("inference-starting");
    if (deepPass) {
      engineKind = "demucs";
      runModels = [payload.model];
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
        modelId: payload.model,
        outputDirectory: join(temporaryDirectory, "deep-output"),
        requestedDevice: payload.requestedDevice,
        signal: controller.signal,
        onSpawn: async pid => {
          await deps.boundary?.("native-unregistered");
          execution.child = await ownerIdentity(pid);
          await phase("native-registered");
        },
        onProgress: (percent) => {
          if (percent === lastDeepPercent) return;
          lastDeepPercent = percent;
          const base = jobMetadata(job.metadata);
          void updateJob(database, job.id, {
            metadata: JSON.stringify({
              ...base,
              progress: { done: percent, total: 100, percent, phase: "deep", model: payload.model },
            }),
          }).catch(() => undefined);
        },
      });
      resolvedDevice = deep.resolvedDevice;
      checkpointSha256 = deep.checkpointSha256 ?? null;
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
        if (stemFrames !== frames || frames === 0) {
          throw new Error(`The deep engine’s ${stem.stemType} stem has ${stemFrames} frames; expected exactly ${frames} source frames. No bank was published.`);
        }
        const stemLeft = new Float32Array(stemFrames);
        const stemRight = new Float32Array(stemFrames);
        for (let i = 0; i < stemFrames; i += 1) {
          stemLeft[i] = decodedStem.samples[i * 2];
          stemRight[i] = decodedStem.samples[i * 2 + 1];
        }
        stemOutputs.push({
          stemType: nameStem(stem.stemType),
          channels: [stemLeft, stemRight],
          model: payload.model,
          modelVersion: deep.modelVersion,
          sampleCount: stemFrames,
        });
      }
    } else {
      const enginesById = new Map<string, OpenedEngines>();
      const openedEngines: OpenedEngines[] = [];
      try {
        const getEngine = async (modelSpec: MdxModelSpec): Promise<OpenedEngines> => {
          const existing = enginesById.get(modelSpec.id);
          if (existing !== undefined) return existing;
          const engine = await openEngine(modelSpec, payload.requestedDevice);
          enginesById.set(modelSpec.id, engine);
          openedEngines.push(engine);
          return engine;
        };

        // Real progress across ALL runs (a recipe runs one model per stem):
        // chunk-level updates into the durable row's metadata, throttled to
        // whole GLOBAL percents + the first and last chunk of each run.
        let lastReportedPercent = -1;
        for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
          const run = runs[runIndex];
          const engine = await getEngine(run.spec);
          resolvedDevice = engine.resolvedDevice;
          const separated = await demixMdx([left, right], run.spec, async (...args) => {
            await checkCancellation();
            const result = await engine.infer(...args);
            await checkCancellation();
            return result;
          }, (done, total) => {
            const runFraction = total > 0 ? done / total : 1;
            const percent = Math.floor(((runIndex + runFraction) / runs.length) * 100);
            if (done !== 1 && done !== total && percent === lastReportedPercent) return;
            lastReportedPercent = percent;
            const base = jobMetadata(job.metadata);
            void updateJob(database, job.id, {
              metadata: JSON.stringify({
                ...base,
                progress: { done, total, percent, phase: `${runIndex + 1}/${runs.length}`, model: run.spec.id },
              }),
            }).catch(() => undefined);
          });
          stemOutputs.push({
            stemType: run.stemType,
            channels: run.take === "primary" ? separated.primary : separated.secondary,
            model: run.spec.id,
            modelVersion: run.spec.sha256,
            sampleCount: separated.sampleCount,
          });
        }
      } finally {
        // Engines are released the moment their runs are done — the deep
        // branch below must never hold an inference session open.
        for (const engine of openedEngines) await engine.release().catch(() => undefined);
      }
      runModels = [...new Set(runs.map((run) => run.spec.id))];
    }

    await phase("outputs-written");
    await checkCancellation();
    await updateJob(database, job.id, {
      status: "finalizing",
      stage: "validating",
      resolvedDevice,
    });
    execution.provenance = { engine: engineKind, model: job.model, models: runModels, checkpointSha256, resolvedDevice, outputCount: stemOutputs.length, stems: stemOutputs.map(stem => stem.stemType) };
    const values: (typeof stemAssets.$inferInsert)[] = [];
    for (const stem of stemOutputs) {
      await checkCancellation();
      const wav = encodeWav16(interleavePlanar(stem.channels), 44_100);
      // Layered stem types ("other/vocals") must become safe filenames.
      const stemPath = join(temporaryDirectory, `${stem.stemType.replace(/[^a-zA-Z0-9_-]+/g, "-")}.wav`);
      await writeFile(stemPath, wav);
      const checksum = await checksumFile(stemPath);
      const storageKey = privateObjectKey(job.projectId, "stem", "wav");
      // Track before writing: a provider can partially write and then reject.
      uploadedKeys.push(storageKey);
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
        durationSeconds: stem.sampleCount / 44_100,
        sampleRate: 44_100,
        channels: 2,
        codec: "pcm_s16le",
        format: "wav",
        fileSizeBytes: wav.length,
      });
      execution.outputs = values;
      await phase("staging");
      await storage.putFile(storageKey, stemPath, "audio/wav");
      await deps.boundary?.("object-written");
      await deps.boundary?.(`object-written:${values.length}`);
    }
    if (!await validateExecutionOutputs(job, execution)) throw new Error("Stored separation output failed checksum/frame validation; bank was not published.");
    await phase("validated");

    const durableWork = await database.transaction(async (tx) => {
      // Serialize completion against the cancellation UPDATE. Cancellation wins
      // before this lock => no stem rows; publication wins => cancel sees complete.
      const [current] = await tx.select({ status: processingJobs.status }).from(processingJobs).where(eq(processingJobs.id, job.id)).for("update");
      if (!current || ["cancelling", "cancelled"].includes(current.status)) throw new DOMException("Separation cancelled", "AbortError");
      await deps.boundary?.("publication-locked");
      const [locked] = await tx.select().from(processingJobs).where(eq(processingJobs.id, job.id));
      if (recoveryMetadata(locked.metadata).execution && (recoveryMetadata(locked.metadata).execution as { id: string }).id !== execution.id) throw new Error("Execution ownership changed before publication.");
      return publishBank(tx, locked, values, execution.provenance);
    });
    await deps.boundary?.("committed");
    completed = true; // The committed bank is immutable, even if derived-job reporting fails.
    // Separation is complete even if a later derived-artifact queue needs
    // a retry. Each durable job records its own failure boundary.
    for (const waveformJob of durableWork) {
      try {
        await enqueueWaveform({
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
  } catch (error) {
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
    stopped = true;
    if (poll) clearTimeout(poll);
    await polling;
    let cleanupWarning = false;
    if (!completed) {
      let unpublishedKeys: string[] = [];
      let uncertainKeys: string[] = [];
      if (uploadedKeys.length) {
        try {
          // COMMIT may have succeeded even when its acknowledgement was lost.
          // Durable asset references, not a local boolean, decide deletion.
          const published = await database.select({ storageKey: stemAssets.storageKey }).from(stemAssets).where(inArray(stemAssets.storageKey, uploadedKeys));
          const referenced = new Set(published.map(row => row.storageKey));
          unpublishedKeys = uploadedKeys.filter(key => !referenced.has(key));
        } catch {
          // Unknown publication outcome: retain output rather than destroy a
          // potentially committed bank. Keep keys for explicit reconciliation.
          uncertainKeys = uploadedKeys;
        }
      }
      const cleanup = await Promise.allSettled(unpublishedKeys.map((key) => storage.delete(key)));
      const failedKeys = [...uncertainKeys, ...unpublishedKeys.filter((_, index) => cleanup[index].status === "rejected")];
      if (failedKeys.length) {
        cleanupWarning = true;
        await database.update(processingJobs).set({ errorMessage: "Separation stopped, but some output could not be removed or its publication status could not be verified. Cleanup keys are retained in this job's metadata; published audio is preserved.", metadata: sql`(${processingJobs.metadata}::jsonb || ${JSON.stringify({ cleanupFailedKeys: failedKeys })}::jsonb)::text` })
          .where(and(eq(processingJobs.id, job.id), notInArray(processingJobs.status, ["complete"])));
      }
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
    if (ownsAttempt) await database.update(processingJobs).set({ metadata: sql`jsonb_set(${processingJobs.metadata}::jsonb, '{execution,cleanupPending}', 'false'::jsonb)::text` }).where(and(eq(processingJobs.id, job.id), sql`${processingJobs.metadata}::jsonb->'execution'->>'id' = ${execution.id}`));
    if (ownsAttempt) await database.update(processingJobs).set({ status: "cancelled", stage: "cancelled", ...(cleanupWarning ? {} : { errorMessage: "Separation stopped and unpublished output removed. Source and existing stem banks were preserved." }), completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(processingJobs.id, job.id), eq(processingJobs.status, "cancelling")));
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
