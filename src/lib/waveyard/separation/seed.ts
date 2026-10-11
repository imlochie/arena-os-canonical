/**
 * Model seeding — first-run model acquisition for the stem machine.
 *
 * Vision §V1 distribution decision ("hybrid"): the app does NOT bundle model
 * weights by default (license is verify-before-bundling); it downloads the
 * registry-pinned file on first use, checksum-verifies it, and installs it
 * atomically into the models dir. After the first run everything is offline.
 *
 * Safety properties (tested):
 *  - The URL is ALWAYS the registry's own sourceUrl — user input never
 *    influences what is fetched (no SSRF surface).
 *  - The download lands at a temp path and is sha256-verified against the
 *    registry BEFORE the atomic rename — a truncated or corrupted download
 *    can never become the model file inference reads.
 *  - A wrong-length response is rejected before the bytes are written.
 *  - Concurrent seeds of the same model share one download (in-process lock).
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";

import { checksumFile } from "../audio";
import type { MdxModelSpec } from "./mdx";
import { resolveModelsDir } from "./session";

export class ModelSeedError extends Error {
  readonly errorCode = "MODEL_SEED_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "ModelSeedError";
  }
}

export type ModelFileStatus = {
  present: boolean;
  /** present AND sha256-verified — the only state inference may use. */
  verified: boolean;
  sizeBytes: number | null;
};

/** Is the model installed and byte-exact? (Never throws — status, not I/O.) */
export async function getModelFileStatus(spec: MdxModelSpec, dir = resolveModelsDir()): Promise<ModelFileStatus> {
  const path = resolve(dir, spec.file);
  try {
    const details = await stat(path);
    if (!details.isFile()) return { present: false, verified: false, sizeBytes: null };
    const sha = await checksumFile(path);
    return { present: true, verified: sha === spec.sha256, sizeBytes: details.size };
  } catch {
    return { present: false, verified: false, sizeBytes: null };
  }
}

export type SeedProgress = { bytes: number; totalBytes: number | null };

export type SeedResult =
  | { outcome: "already-present"; status: ModelFileStatus }
  | { outcome: "installed"; bytes: number };

type FetchLike = (url: string) => Promise<Response>;

/** In-process per-model download lock: concurrent seeds share one download. */
const inFlight = new Map<string, Promise<SeedResult>>();

export async function seedModelFile(
  spec: MdxModelSpec,
  opts: { dir?: string; fetchImpl?: FetchLike; onProgress?: (p: SeedProgress) => void } = {},
): Promise<SeedResult> {
  const existing = inFlight.get(spec.id);
  if (existing) return existing;
  const operation = seedModelFileUncached(spec, opts).finally(() => inFlight.delete(spec.id));
  inFlight.set(spec.id, operation);
  return operation;
}

async function seedModelFileUncached(
  spec: MdxModelSpec,
  opts: { dir?: string; fetchImpl?: FetchLike; onProgress?: (p: SeedProgress) => void } = {},
): Promise<SeedResult> {
  const dir = resolve(opts.dir ?? resolveModelsDir());
  const fetchImpl = opts.fetchImpl ?? ((url: string) => fetch(url));

  const current = await getModelFileStatus(spec, dir);
  if (current.verified) return { outcome: "already-present", status: current };

  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, spec.file);
  const tempPath = join(dir, `.download-${spec.file}.tmp`);

  let response: Response;
  try {
    response = await fetchImpl(spec.sourceUrl);
  } catch (error) {
    throw new ModelSeedError(
      `The stem engine model could not be downloaded: ${error instanceof Error ? error.message : String(error)}. ` +
        "Check your connection and try again.",
    );
  }
  if (!response.ok || response.body === null) {
    throw new ModelSeedError(
      `The model download was refused (HTTP ${response.status}). The source may be unreachable — try again later.`,
    );
  }

  // Length sanity BEFORE writing: catches HTML error pages and moved files.
  const declaredLength = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declaredLength)) {
    const expected = spec.sizeBytes;
    if (declaredLength < expected * 0.5 || declaredLength > expected * 1.5) {
      throw new ModelSeedError(
        `The download is ${declaredLength} bytes but the pinned model is ~${expected} — refusing to install ` +
          "something that is not the registered model.",
      );
    }
  }

  let bytes = 0;
  const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  source.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    opts.onProgress?.({ bytes, totalBytes: Number.isFinite(declaredLength) ? declaredLength : null });
  });
  try {
    await pipeline(source, createWriteStream(tempPath));
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ModelSeedError(
      `The model download was interrupted: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  const sha = await checksumFile(tempPath);
  if (sha !== spec.sha256) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ModelSeedError(
      `The downloaded model failed its integrity check (sha256 ${sha.slice(0, 12)}…, expected ` +
        `${spec.sha256.slice(0, 12)}…). Nothing was installed — try again.`,
    );
  }

  // Same-directory rename: atomic on POSIX and Windows.
  await rename(tempPath, finalPath);
  return { outcome: "installed", bytes };
}

/** Human-facing model labels are product vocabulary, never file names. */
export function modelLabel(spec: MdxModelSpec): string {
  return spec.label ?? spec.file.replace(/\.onnx$/i, "").replace(/_/g, " ");
}

export function modelsDirParent(dir: string): string {
  return dirname(dir);
}
