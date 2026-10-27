/**
 * Shared separation e2e harness — used by BOTH the deterministic fake-session
 * pipeline test (separation.test.ts) and the real-onnxruntime smoke test
 * (separation-real-ort.test.ts). PGlite + canonical desktop migrations +
 * the real local storage provider + a real WAV source asset + a durable
 * separation job row. No test registrations live here (importing this file
 * never runs tests).
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { applyMigrations } from "../../../../desktop/runtime/migrate";
import { checksumFile } from "@/lib/waveyard/audio";
import { encodeWav16 } from "@/lib/waveyard/mixer/synth";
import { getStorage, privateObjectKey } from "@/lib/waveyard/storage";
import { projects, processingJobs, sourceAssets } from "@/db/waveyardSchema";
import type { MdxInfer, MdxModelSpec } from "@/lib/waveyard/separation/mdx";
import type { OpenedEngine } from "./separation";

export const SAMPLES = 44_100; // 1.0 s — exactly one model chunk end to end

/** Band-limited stereo noise: partials at exact FFT bins ≥ 20 (no sub-bin-3
 *  content — the engine deliberately zeroes those bins), peak ≤ 0.5 so the
 *  normalizer's gain is exactly 1 and stem arithmetic is clean. */
export function stemMachineSource(n: number): Float32Array {
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let s = 0x2f31ed;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
  for (let p = 0; p < 40; p += 1) {
    const bin = 20 + Math.floor(rand() * 2700); // exact FFT bins, strictly above the zeroed bins 0-2
    const amp = rand() * 0.5;
    const phase = rand() * 2 * Math.PI;
    for (let i = 0; i < n; i += 1) {
      const t = (2 * Math.PI * bin * i) / 7680 + phase;
      left[i] += amp * Math.sin(t);
      right[i] += amp * Math.cos(t);
    }
  }
  const out = new Float32Array(n * 2);
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    out[i * 2] = left[i];
    out[i * 2 + 1] = right[i];
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  if (peak > 0.5) for (let i = 0; i < out.length; i += 1) out[i] *= 0.5 / peak;
  return out;
}

export function snrDb(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let err = 0;
  let ref = 0;
  for (let i = from; i < to; i += 1) {
    const d = a[i] - b[i];
    err += d * d;
    ref += b[i] * b[i];
  }
  return 10 * Math.log10(ref / Math.max(err, 1e-30));
}

export type SeparationFixture = Awaited<ReturnType<typeof fixture>>;

export async function fixture(options: { model?: string } = {}) {
  const model = options.model ?? "kim_vocal_2";
  const storageDir = await mkdtemp(join(tmpdir(), "wy-sep-storage-"));
  process.env.WAVEYARD_STORAGE_DIR = storageDir;
  const modelsDir = await mkdtemp(join(tmpdir(), "wy-sep-models-"));
  process.env.WAVEYARD_MODELS_DIR = modelsDir;
  const client = new PGlite();
  // The canonical desktop migration path — the same runner the packaged app
  // uses, all ordered files (0000 snapshot + deltas), on an in-memory PGlite.
  const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const outcome = await applyMigrations({
    client: client as unknown as import("pg").Client,
    migrationsDir: join(repoRoot, "desktop-migrations"),
  });
  if (outcome.applied.length < 2) throw new Error("canonical migrations must apply");
  const database = drizzle(client) as unknown as NonNullable<import("./separation").SeparationHandlerDeps["db"]>;

  const [project] = await database
    .insert(projects)
    .values({ ownerId: randomUUID(), title: "Stem Machine E2E" })
    .returning();

  // 1.0 s of 44.1 kHz stereo — exactly one model chunk end to end.
  const wav = encodeWav16(stemMachineSource(SAMPLES), 44_100);
  const sourceDir = await mkdtemp(join(tmpdir(), "wy-sep-source-"));
  const sourcePath = join(sourceDir, "source.wav");
  await writeFile(sourcePath, wav);
  const storageKey = privateObjectKey(project.id, "source", "wav");
  await getStorage().putFile(storageKey, sourcePath, "audio/wav");
  const checksum = await checksumFile(sourcePath);

  const [source] = await database
    .insert(sourceAssets)
    .values({
      projectId: project.id,
      originalFilename: "source.wav",
      mimeType: "audio/wav",
      storageKey,
      checksumSha256: checksum,
      durationSeconds: 1,
      sampleRate: 44_100,
      channels: 2,
      codec: "pcm_s16le",
      fileSizeBytes: wav.length,
    })
    .returning();

  const [job] = await database
    .insert(processingJobs)
    .values({
      projectId: project.id,
      sourceAssetId: source.id,
      type: "separation",
      model,
      requestedDevice: "auto",
      idempotencyKey: `separation:${source.id}:${model}`,
    })
    .returning();

  return {
    client,
    database,
    project,
    source,
    job,
    storageDir,
    modelsDir,
    sourcePath,
    async close() {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
      await rm(modelsDir, { recursive: true, force: true });
      await client.close();
      delete process.env.WAVEYARD_STORAGE_DIR;
      delete process.env.WAVEYARD_MODELS_DIR;
    },
  };
}

export function payloadOf(f: SeparationFixture, overrides: Record<string, unknown> = {}) {
  return {
    processingJobId: f.job.id,
    projectId: f.project.id,
    sourceAssetId: f.source.id,
    model: f.job.model,
    requestedDevice: "auto" as const,
    ...overrides,
  };
}

/** The deterministic fake: identity inference (no model weights). */
export function identityEngine(seen: { spec?: MdxModelSpec } = {}): (spec: MdxModelSpec) => Promise<OpenedEngine> {
  return async (spec) => {
    seen.spec = spec;
    return {
      infer: (async (spek: Float32Array) => spek) as MdxInfer,
      release: async () => {},
      resolvedDevice: "cpu",
    };
  };
}
