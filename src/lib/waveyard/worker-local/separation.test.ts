/**
 * E2E tests for the local stem machine — the FULL handler pipeline runs
 * against a PGlite database and the real local storage provider with a
 * FAKE identity inference session (no model weights; the real-model
 * verification is owner-side, see docs/waveyard-vision.md). What is
 * proven here, end to end: decode → deinterleave → demix → encode →
 * store → durable stem rows → waveform-job fan-out with honest
 * per-queue failure boundaries; plus every honest-failure path (model
 * not seeded, unknown model, payload mismatch, engine failure with
 * upload cleanup) and the broker registration.
 */

import "./_separation-test-env";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { processingJobs, projects, sourceAssets, stemAssets, waveformJobs } from "@/db/waveyardSchema";
import { checksumFile } from "@/lib/waveyard/audio";
import { encodeWav16, decodeWav16 } from "@/lib/waveyard/mixer/synth";
import { getStorage, privateObjectKey } from "@/lib/waveyard/storage";
import { findMdxModel, type MdxInfer, type MdxModelSpec } from "@/lib/waveyard/separation/mdx";
import type { OpenedEngine } from "./separation";
import { handleSeparationJob } from "./separation";

const KIM = findMdxModel("kim_vocal_2")!;
const SAMPLES = 44_100; // 1.0 s — exactly one model chunk end to end

/** Band-limited stereo noise: partials at exact FFT bins ≥ 20 (no sub-bin-3
 *  content — the engine deliberately zeroes those bins), peak ≤ 0.5 so the
 *  normalizer's gain is exactly 1 and stem arithmetic is clean. */
function stemMachineSource(n: number): Float32Array {
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

function snrDb(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let err = 0;
  let ref = 0;
  for (let i = from; i < to; i += 1) {
    const d = a[i] - b[i];
    err += d * d;
    ref += b[i] * b[i];
  }
  return 10 * Math.log10(ref / Math.max(err, 1e-30));
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const storageDir = await mkdtemp(join(tmpdir(), "wy-sep-storage-"));
  process.env.WAVEYARD_STORAGE_DIR = storageDir;
  const modelsDir = await mkdtemp(join(tmpdir(), "wy-sep-models-"));
  process.env.WAVEYARD_MODELS_DIR = modelsDir;
  const client = new PGlite();
  // The canonical desktop migration path — the same runner the packaged app
  // uses, all ordered files (0000 snapshot + deltas), on an in-memory PGlite.
  const { applyMigrations } = await import("../../../../desktop/runtime/migrate");
  const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const outcome = await applyMigrations({
    client: client as unknown as import("pg").Client,
    migrationsDir: join(repoRoot, "desktop-migrations"),
  });
  assert.ok(outcome.applied.length >= 2, "canonical migrations must apply");
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
      model: "kim_vocal_2",
      requestedDevice: "auto",
      idempotencyKey: `separation:${source.id}:kim_vocal_2`,
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

function payloadOf(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    processingJobId: f.job.id,
    projectId: f.project.id,
    sourceAssetId: f.source.id,
    model: "kim_vocal_2",
    requestedDevice: "auto" as const,
    ...overrides,
  };
}

function identityEngine(seen: { spec?: MdxModelSpec } = {}): (spec: MdxModelSpec) => Promise<OpenedEngine> {
  return async (spec) => {
    seen.spec = spec;
    return {
      infer: (async (spek: Float32Array) => spek) as MdxInfer,
      release: async () => {},
      resolvedDevice: "cpu",
    };
  };
}

test("full pipeline: fake identity session → stems stored, decoded back, and arithmetically exact", async () => {
  const f = await fixture();
  try {
    const seen: { spec?: MdxModelSpec } = {};
    await handleSeparationJob(payloadOf(f), { db: f.database, openEngine: identityEngine(seen) });
    assert.equal(seen.spec?.id, "kim_vocal_2", "engine opened for the registry model");

    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.status, "complete");
    assert.equal(row.stage, "complete");
    assert.equal(row.resolvedDevice, "cpu");
    assert.equal(row.errorCode, null);
    const metadata = JSON.parse(row.metadata);
    assert.equal(metadata.engine, "mdx");
    assert.equal(metadata.model, "kim_vocal_2");
    assert.equal(metadata.outputCount, 2);
    assert.equal(metadata.primaryStem, "vocals");
    assert.equal(metadata.secondaryStem, "instrumental");

    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    assert.equal(stems.length, 2);
    const byType = new Map(stems.map((s) => [s.stemType, s]));
    const vocals = byType.get("vocals")!;
    const instrumental = byType.get("instrumental")!;
    assert.ok(vocals && instrumental, "vocals + instrumental stem rows");
    for (const stem of stems) {
      assert.equal(stem.engine, "mdx");
      assert.equal(stem.model, "kim_vocal_2");
      assert.equal(stem.modelVersion, KIM.sha256, "modelVersion pins the exact model file");
      assert.equal(stem.durationSeconds, 1);
      assert.equal(stem.sampleRate, 44_100);
      assert.equal(stem.channels, 2);
      assert.equal(stem.format, "wav");
      const stored = getStorage().getLocalPath(stem.storageKey);
      assert.ok(stored, "stem object exists in storage");
      const bytes = new Uint8Array(await readFile(stored!));
      assert.equal(bytes.length, 44 + SAMPLES * 4, "16-bit stereo WAV size");
      const rechecksum = await checksumFile(stored!);
      assert.equal(rechecksum, stem.checksumSha256, "row checksum matches the stored file");
    }

    // Decode all three back and verify the math end to end. With the
    // identity session, vocals ≈ source; instrumental = source −
    // vocals·compensate — the stem-sum guarantee, after 16-bit storage.
    const sourceDecoded = decodeWav16(new Uint8Array(await readFile(f.sourcePath)))!;
    const vocalsDecoded = decodeWav16(new Uint8Array(await readFile(getStorage().getLocalPath(vocals.storageKey)!)))!;
    const instrDecoded = decodeWav16(new Uint8Array(await readFile(getStorage().getLocalPath(instrumental.storageKey)!)))!;
    assert.ok(sourceDecoded && vocalsDecoded && instrDecoded);
    assert.equal(sourceDecoded.sampleRate, 44_100);
    const trim = 3840; // engine discards the padded edges; assert the interior
    const src = sourceDecoded.samples;
    const voc = vocalsDecoded.samples;
    const instr = instrDecoded.samples;
    const snrL = snrDb(voc, src, trim * 2, (SAMPLES - trim) * 2);
    assert.ok(snrL > 60, `identity vocals reconstruct the source (got ${snrL.toFixed(1)} dB)`);
    let maxArithmeticError = 0;
    for (let i = trim * 2; i < (SAMPLES - trim) * 2; i += 1) {
      const expected = src[i] - voc[i] * KIM.params.compensate;
      maxArithmeticError = Math.max(maxArithmeticError, Math.abs(instr[i] - expected));
    }
    assert.ok(maxArithmeticError < 3e-4, `instrumental = source − vocals·compensate (max err ${maxArithmeticError.toExponential(1)})`);

    // One waveform job per stem, each with its own honest failure boundary:
    // this test process has no queue (no Redis, not desktop mode), so both
    // record queue-unavailable while separation itself is complete.
    const wfJobs = await f.database.select().from(waveformJobs).where(eq(waveformJobs.projectId, f.project.id));
    const stemWaveformJobs = wfJobs.filter((j) => j.stemAssetId !== null);
    assert.equal(stemWaveformJobs.length, 2);
    for (const j of stemWaveformJobs) {
      assert.equal(j.status, "failed");
      assert.equal(j.errorCode, "queue_unavailable");
    }
  } finally {
    await f.close();
  }
});

test("model not seeded: honest separation_unavailable failure, no stem rows, no objects", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => handleSeparationJob(payloadOf(f), { db: f.database }), // default engine opener → real models dir (empty temp)
      (err: unknown) => {
        assert.match(err instanceof Error ? err.message : "", /not present on this machine/);
        return true;
      },
    );
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.status, "failed");
    assert.equal(row.errorCode, "separation_unavailable");
    assert.match(row.errorMessage ?? "", /not present on this machine/);
    const stems = await f.database.select().from(stemAssets);
    assert.equal(stems.length, 0);
    const stemDir = join(f.storageDir, "projects", f.project.id, "stem");
    await assert.rejects(() => readdir(stemDir), /ENOENT/, "no stem objects were written");
  } finally {
    await f.close();
  }
});

test("unknown model for this machine: honest unknown_model failure", async () => {
  const f = await fixture();
  try {
    // Keep job.model and payload.model consistent so the identity check passes.
    await f.database.update(processingJobs).set({ model: "htdemucs" }).where(eq(processingJobs.id, f.job.id));
    await assert.rejects(
      () => handleSeparationJob(payloadOf(f, { model: "htdemucs" }), { db: f.database, openEngine: identityEngine() }),
      /Unknown separation model/,
    );
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.errorCode, "unknown_model");
  } finally {
    await f.close();
  }
});

test("payload/job mismatch: honest invalid_payload failure", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => handleSeparationJob(payloadOf(f, { model: "some_other_model" }), { db: f.database, openEngine: identityEngine() }),
      /does not match its durable job target/,
    );
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.errorCode, "invalid_payload");
    assert.equal(row.status, "failed");
  } finally {
    await f.close();
  }
});

test("engine failure mid-run: job fails honestly and uploaded stem objects are cleaned up", async () => {
  const f = await fixture();
  try {
    let opened = false;
    const failingEngine = async (): Promise<OpenedEngine> => ({
      infer: async () => {
        throw new Error("inference exploded");
      },
      release: async () => {
        opened = true;
      },
      resolvedDevice: "cpu",
    });
    await assert.rejects(
      () => handleSeparationJob(payloadOf(f), { db: f.database, openEngine: failingEngine }),
      /inference exploded/,
    );
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.status, "failed");
    assert.equal(row.errorCode, "separation_failed");
    assert.match(row.errorMessage ?? "", /inference exploded/);
    assert.equal(opened, true, "engine session released on failure");
    const stems = await f.database.select().from(stemAssets);
    assert.equal(stems.length, 0);
  } finally {
    await f.close();
  }
});

test("the local broker registers the separation queue alongside the other engines", async () => {
  const { startLocalWorker } = await import("./index");
  const { getLocalJobBroker, resetLocalJobBrokerForTests } = await import("./broker");
  const prevDesktop = process.env.ARENA_DESKTOP_MODE;
  const prevRedis = process.env.REDIS_URL;
  try {
    process.env.ARENA_DESKTOP_MODE = "1";
    delete process.env.REDIS_URL;
    resetLocalJobBrokerForTests();
    const broker = startLocalWorker();
    assert.ok(broker, "broker starts in desktop mode");
    assert.ok(broker!.hasHandler("waveyard-separation"), "SEPARATION_QUEUE registered");
    assert.ok(broker!.hasHandler("waveyard-waveform"));
    assert.ok(broker!.hasHandler("waveyard-export"));
    assert.ok(!broker!.hasHandler("waveyard-drum-analysis"), "Python-only analyses stay unregistered (honest)");
  } finally {
    if (prevDesktop === undefined) delete process.env.ARENA_DESKTOP_MODE;
    else process.env.ARENA_DESKTOP_MODE = prevDesktop;
    if (prevRedis !== undefined) process.env.REDIS_URL = prevRedis;
    resetLocalJobBrokerForTests();
  }
});
