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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import type { drizzle } from "drizzle-orm/node-postgres";

import { processingJobs, sourceAssets, stemAssets, waveformJobs } from "@/db/waveyardSchema";
import { checksumFile } from "@/lib/waveyard/audio";
import { encodeWav16 } from "@/lib/waveyard/mixer/synth";
import { getStorage, privateObjectKey } from "@/lib/waveyard/storage";
import { enqueueWaveform } from "@/lib/waveyard/queue";
import { decodeSourceToStereoPcm } from "@/lib/waveyard/measure/pcm";
import type { SeparationJobPayload } from "@/lib/waveyard/types";
import { demixMdx, findMdxModel, type MdxInfer, type MdxModelSpec } from "@/lib/waveyard/separation/mdx";
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
  /** Opens the verified model and returns the inference seam. */
  openEngine?: (spec: MdxModelSpec, requestedDevice: "auto" | "cpu" | "cuda") => Promise<OpenedEngine>;
  decode?: typeof decodeSourceToStereoPcm;
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
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(processingJobs.id, id));
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

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "arena-separation-"));
  const inputPath = join(temporaryDirectory, "source-upload");
  const storage = getStorage();
  const uploadedKeys: string[] = [];
  let completed = false;

  try {
    await updateJob(database, job.id, {
      status: "preparing",
      stage: "preparing",
      startedAt: new Date(),
      errorCode: null,
      errorMessage: null,
    });
    await storage.getToFile(source.storageKey, inputPath);

    await updateJob(database, job.id, {
      status: "processing",
      stage: "separating",
      attempts: (job.attempts ?? 0) + 1,
    });
    // The engine is trained at 44.1 kHz — decode demands exactly that
    // (native WAV at other rates falls through to ffmpeg resampling).
    const decoded = await decode(inputPath, {}, {}, { requireSampleRate: 44_100 });
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

    const engine = await openEngine(spec, payload.requestedDevice);
    let released = false;
    try {
      // Real progress: chunk-level updates into the durable row's metadata
      // (throttled to whole percents + the first and last chunk).
      let lastReportedPercent = -1;
      const stems = await demixMdx([left, right], spec, engine.infer, (done, total) => {
        const percent = total > 0 ? Math.floor((done / total) * 100) : 100;
        if (done !== 1 && done !== total && percent === lastReportedPercent) return;
        lastReportedPercent = percent;
        const base = jobMetadata(job.metadata);
        void updateJob(database, job.id, {
          metadata: JSON.stringify({ ...base, progress: { done, total, percent } }),
        }).catch(() => undefined);
      });
      await updateJob(database, job.id, {
        status: "finalizing",
        stage: "validating",
        resolvedDevice: engine.resolvedDevice,
      });

      const stemOutputs = [
        { stemType: spec.primaryStem, channels: stems.primary },
        { stemType: spec.secondaryStem, channels: stems.secondary },
      ];
      const values: (typeof stemAssets.$inferInsert)[] = [];
      for (const stem of stemOutputs) {
        const wav = encodeWav16(interleavePlanar(stem.channels), 44_100);
        const stemPath = join(temporaryDirectory, `${stem.stemType}.wav`);
        await writeFile(stemPath, wav);
        const checksum = await checksumFile(stemPath);
        const storageKey = privateObjectKey(job.projectId, "stem", "wav");
        await storage.putFile(storageKey, stemPath, "audio/wav");
        uploadedKeys.push(storageKey);
        values.push({
          projectId: job.projectId,
          sourceAssetId: source.id,
          separationJobId: job.id,
          stemType: stem.stemType,
          engine: "mdx",
          model: spec.id,
          modelVersion: spec.sha256,
          storageKey,
          checksumSha256: checksum,
          durationSeconds: Math.round(stems.sampleCount / 44_100),
          sampleRate: 44_100,
          channels: 2,
          codec: "pcm_s16le",
          format: "wav",
          fileSizeBytes: wav.length,
        });
      }

      const durableWork = await database.transaction(async (tx) => {
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
        await tx
          .update(processingJobs)
          .set({
            status: "complete",
            stage: "complete",
            completedAt: new Date(),
            updatedAt: new Date(),
            metadata: JSON.stringify({
              engine: "mdx",
              model: spec.id,
              resolvedDevice: engine.resolvedDevice,
              outputCount: values.length,
              primaryStem: spec.primaryStem,
              secondaryStem: spec.secondaryStem,
            }),
          })
          .where(eq(processingJobs.id, job.id));
        return waveformWork;
      });
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
      completed = true;
      await engine.release();
      released = true;
    } finally {
      if (!released) await engine.release().catch(() => undefined);
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
    if (!completed) {
      await Promise.allSettled(uploadedKeys.map((key) => storage.delete(key)));
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
