/**
 * onnxruntime-node session wrapper for the separation engine.
 *
 * Design constraints:
 *  - The handler must work with the runtime ABSENT (package not installed,
 *    model not seeded) and surface an honest unavailable state — so the ort
 *    module is loaded lazily and every failure path returns a typed error,
 *    never a crash.
 *  - Tests inject a fake session (no model weights) — the seam is
 *    `MdxSessionLike`, anything with a run() over float32 tensors.
 *  - Model files live under the models dir (WAVEYARD_MODELS_DIR, default
 *    .data/waveyard-models — same convention as WAVEYARD_STORAGE_DIR) and
 *    are sha256-verified against the registry before use: a truncated or
 *    corrupted download must never reach inference.
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import { checksumFile } from "../audio";
import type { MdxInfer, MdxModelSpec } from "./mdx";
import { chunkGeometry } from "./mdx";

export class SeparationUnavailableError extends Error {
  readonly errorCode = "SEPARATION_UNAVAILABLE" as const;
  constructor(message: string) {
    super(message);
    this.name = "SeparationUnavailableError";
  }
}

/** The minimal ort surface the engine needs (both real and fake sessions). */
export interface MdxSessionLike {
  run(feeds: Record<string, { data: Float32Array; dims: number[] }>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
  release(): void | Promise<void>;
}

/** Test seam: how the onnxruntime-node module is obtained. Production uses
 *  a lazy import so this file (and everything importing it) loads fine on a
 *  machine where the package is not installed. */
let ortLoaderOverride: (() => Promise<OrtModuleLike | null>) | null = null;

async function defaultOrtLoader(): Promise<OrtModuleLike | null> {
  try {
    // The package bundles all-platform native binaries; if the import itself
    // fails (not installed / broken native binding) we report unavailable.
    const mod = (await import("onnxruntime-node")) as unknown as OrtModuleLike;
    return mod;
  } catch {
    return null;
  }
}

/** Load onnxruntime-node, or null when it is genuinely absent. */
export function loadOrtModule(): Promise<OrtModuleLike | null> {
  return ortLoaderOverride ? ortLoaderOverride() : defaultOrtLoader();
}

export function setOrtLoaderForTests(loader: (() => Promise<OrtModuleLike | null>) | null) {
  ortLoaderOverride = loader;
}

export interface OrtModuleLike {
  InferenceSession: {
    create(path: string, options?: { executionProviders?: string[] }): Promise<MdxSessionLike>;
  };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => { data: Float32Array; dims: number[] };
}

/** Where model files live (mirror of getStorage()'s env convention). */
export function resolveModelsDir(): string {
  const root = process.env.WAVEYARD_MODELS_DIR ?? ".data/waveyard-models";
  return resolve(/*turbopackIgnore: true*/ process.cwd(), root);
}

/**
 * Verify a model file on disk against the registry spec (sha256 exact).
 * Returns the absolute path; throws SeparationUnavailableError when the
 * file is missing or does not match — the caller maps that to the job's
 * honest unavailable state, never a silent degraded output.
 */
export async function verifyModelFile(spec: MdxModelSpec, dir = resolveModelsDir()): Promise<string> {
  const path = resolve(dir, spec.file);
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    throw new SeparationUnavailableError(
      `Separation model "${spec.id}" is not present on this machine (expected at ${path}). ` +
        "Use the “Prepare stem engine” action to download it once, then retry.",
    );
  }
  if (stat.size < 1_000_000) {
    throw new SeparationUnavailableError(
      `Separation model "${spec.id}" at ${path} is ${stat.size} bytes — far below the expected ` +
        `${spec.sizeBytes}. Refusing to run inference on a truncated download.`,
    );
  }
  const sha = await checksumFile(path);
  if (sha !== spec.sha256) {
    throw new SeparationUnavailableError(
      `Separation model "${spec.id}" failed its integrity check (sha256 ${sha.slice(0, 12)}…, ` +
        `expected ${spec.sha256.slice(0, 12)}…). Use "Prepare stem engine" to re-download it, then retry.`,
    );
  }
  return path;
}

/** Create a real inference session for a verified model file. */
export async function createMdxSession(
  spec: MdxModelSpec,
  opts: { dir?: string; executionProviders?: string[] } = {},
): Promise<MdxSessionLike> {
  const path = await verifyModelFile(spec, opts.dir);
  const ort = await loadOrtModule();
  if (!ort) {
    throw new SeparationUnavailableError(
      "onnxruntime-node is not available in this installation — the separation engine cannot run. " +
        "Reinstall the app; if it persists, this build is missing its inference runtime.",
    );
  }
  try {
    return await ort.InferenceSession.create(path, {
      executionProviders: opts.executionProviders ?? ["cpu"],
    });
  } catch (err) {
    throw new SeparationUnavailableError(
      `Could not open separation model "${spec.id}" for inference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Adapt an MdxSessionLike to the engine's MdxInfer seam.
 * The spek layout is [rows=ch·2][dim_f][dim_t] flat; the ONNX input tensor
 * is [1, 4, dim_f, dim_t] with input name "input" (reference: model_run =
 * session.run(None, {"input": spek})). dim_t is the model's fixed frame
 * count — the engine always feeds full-size chunks.
 */
export function sessionInfer(
  session: MdxSessionLike,
  ortTensorFactory?: (type: "float32", data: Float32Array, dims: number[]) => { data: Float32Array; dims: number[] },
): MdxInfer {
  const makeTensor =
    ortTensorFactory ??
    ((type: "float32", data: Float32Array, dims: number[]) => ({ data, dims }));
  return async (spek, cfg, frames) => {
    const tensor = makeTensor("float32", spek, [1, 4, cfg.dimF, frames]);
    const outputs = await session.run({ input: tensor });
    const out = outputs[Object.keys(outputs)[0]];
    if (!out || !(out.data instanceof Float32Array)) {
      throw new Error("separation model returned no float32 output tensor");
    }
    // Sanity: the output must match the input geometry (the reference model
    // predicts the same [1, 4, dim_f, dim_t] spectrum shape).
    if (out.data.length !== 4 * cfg.dimF * frames) {
      throw new Error(
        `separation model output has ${out.data.length} elements, expected ${4 * cfg.dimF * frames} ` +
          "(geometry mismatch — wrong model for this engine?)",
      );
    }
    return out.data;
  };
}

/** Full wiring for production: verify file, create session, return infer + release. */
export async function openMdxEngine(
  spec: MdxModelSpec,
  opts: { dir?: string; executionProviders?: string[] } = {},
): Promise<{ infer: MdxInfer; release(): Promise<void> }> {
  const session = await createMdxSession(spec, opts);
  const ort = await loadOrtModule();
  const infer = sessionInfer(
    session,
    ort ? (type, data, dims) => new ort.Tensor(type, data, dims) : undefined,
  );
  return {
    infer,
    release: async () => {
      await session.release();
    },
  };
}

/** Convenience for handlers: chunk geometry from a spec (re-export). */
export { chunkGeometry };
