import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { eq } from "drizzle-orm";

import { checksumFile } from "@workspace/arena/lib/waveyard/audio";
import { decodeWav16, encodeWav16 } from "@workspace/arena/lib/waveyard/mixer/synth";
import { getStorage, privateObjectKey } from "@workspace/arena/lib/waveyard/storage";
import { processingJobs, stemAssets, waveformAssets, waveformJobs } from "@workspace/db/waveyardSchema";
import { findMdxModel, type MdxInfer, type MdxModelSpec } from "@workspace/arena/lib/waveyard/separation/mdx";
import { DEEP_MODEL_SIGNATURE, resetDeepProbeCacheForTests } from "@workspace/arena/lib/waveyard/separation/deep";
import { NO_TEST_PYTHON, STUB_DEEP_ENV_KEYS, writeStubDeepEngine } from "@workspace/arena/lib/waveyard/separation/deep-fixtures";
import { DEEP_STEM_TYPES } from "@workspace/arena/lib/waveyard/separation/modes";
import { retrySeparationJob } from "@workspace/arena/lib/waveyard/separation/retry";
import { WAVEFORM_RESOLUTIONS, type WaveformDocument } from "@workspace/arena/lib/waveyard/types";
import type { OpenedEngine, SeparationHandlerDeps } from "./separation";
import { handleSeparationJob } from "./separation";
import {
  cleanupOrphanedWaveformObjects,
  handleWaveformJob,
  ORPHAN_WAVEFORM_GRACE_PERIOD_MS,
  WAVEFORM_MAX_ATTEMPTS,
  WAVEFORM_RETRY_BACKOFF_MS,
} from "./waveform";
import { LocalJobBroker } from "./broker";
import { fixture, identityEngine, payloadOf, SAMPLES, snrDb, type SeparationFixture } from "./separation-fixtures";
import { recoverInterruptedLocalSeparationJobs, recoverPendingLocalWaveformJobs } from "./recovery";

const KIM = findMdxModel("kim_vocal_2")!;
type Fixture = SeparationFixture;

function validWaveformDocument(): WaveformDocument {
  return {
    format: "waveyard-peaks-v1",
    durationSeconds: 1,
    sampleRate: 44_100,
    channels: 1,
    resolutions: Object.fromEntries(WAVEFORM_RESOLUTIONS.map((resolution) => [
      String(resolution),
      {
        min: new Array<number>(resolution).fill(-0.25),
        max: new Array<number>(resolution).fill(0.25),
      },
    ])) as WaveformDocument["resolutions"],
  };
}

async function createSourceWaveformJob(f: Fixture) {
  const [job] = await f.database
    .insert(waveformJobs)
    .values({
      projectId: f.project.id,
      sourceAssetId: f.source.id,
      status: "queued",
      stage: "queued",
      idempotencyKey: `waveform:retry-test:${f.source.id}`,
    })
    .returning();
  return job;
}

function sourceWaveformPayload(f: Fixture, waveformJobId: string) {
  return { waveformJobId, projectId: f.project.id, sourceAssetId: f.source.id };
}

test("waveform cleanup removes only old unreferenced generated objects", async () => {
  const f = await fixture();
  try {
    const storage = getStorage();
    const referencedKey = privateObjectKey(f.project.id, "waveform", "json");
    const orphanKey = privateObjectKey(f.project.id, "waveform", "json");
    const recentKey = privateObjectKey(f.project.id, "waveform", "json");
    for (const key of [referencedKey, orphanKey, recentKey]) {
      await storage.putBuffer(key, "{}");
    }

    const [waveformJob] = await f.database
      .insert(waveformJobs)
      .values({
        projectId: f.project.id,
        sourceAssetId: f.source.id,
        status: "complete",
        stage: "complete",
        idempotencyKey: `waveform:cleanup-test:${f.source.id}`,
      })
      .returning();
    await f.database.insert(waveformAssets).values({
      projectId: f.project.id,
      sourceAssetId: f.source.id,
      waveformJobId: waveformJob.id,
      storageKey: referencedKey,
      checksumSha256: "a".repeat(64),
    });

    const oldTime = new Date(Date.now() - ORPHAN_WAVEFORM_GRACE_PERIOD_MS - 60_000);
    const orphanPath = storage.getLocalPath(orphanKey)!;
    await utimes(orphanPath, oldTime, oldTime);

    const removed = await cleanupOrphanedWaveformObjects({
      db: f.database,
      storage,
      now: new Date(),
    });

    assert.deepEqual(removed, [orphanKey]);
    assert.equal(await storage.exists(referencedKey), true, "an object with a matching asset row is retained");
    assert.equal(await storage.exists(recentKey), true, "a recently-created orphan is retained");
    assert.equal(await storage.exists(orphanKey), false, "an old unreferenced waveform object is removed");
  } finally {
    await f.close();
  }
});

test("waveform retries a transient storage failure and completes without manual intervention", async () => {
  const f = await fixture();
  try {
    const job = await createSourceWaveformJob(f);
    const baseStorage = getStorage();
    const flakyStorage = Object.create(baseStorage) as typeof baseStorage;
    const delays: number[] = [];
    let storageReads = 0;
    let generationCalls = 0;
    flakyStorage.getToFile = async (key, localPath) => {
      storageReads += 1;
      if (storageReads === 1) {
        throw Object.assign(new Error("Temporary storage read failure"), { code: "EIO" });
      }
      return baseStorage.getToFile(key, localPath);
    };

    await handleWaveformJob(sourceWaveformPayload(f, job.id), {
      db: f.database,
      storage: flakyStorage,
      generateWaveform: async () => {
        generationCalls += 1;
        return validWaveformDocument();
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });

    const [completed] = await f.database.select().from(waveformJobs).where(eq(waveformJobs.id, job.id));
    const assets = await f.database.select().from(waveformAssets).where(eq(waveformAssets.waveformJobId, job.id));
    assert.equal(storageReads, 2);
    assert.equal(generationCalls, 1);
    assert.deepEqual(delays, [WAVEFORM_RETRY_BACKOFF_MS[0]]);
    assert.equal(completed.status, "complete");
    assert.equal(completed.attempts, 2);
    assert.equal(completed.errorCode, null);
    assert.equal(assets.length, 1);
    assert.equal(await getStorage().exists(assets[0]!.storageKey), true);
  } finally {
    await f.close();
  }
});

test("waveform stops after the bounded transient retry limit and keeps the failure visible", async () => {
  const f = await fixture();
  try {
    const job = await createSourceWaveformJob(f);
    const delays: number[] = [];
    let generationCalls = 0;

    await assert.rejects(
      () => handleWaveformJob(sourceWaveformPayload(f, job.id), {
        db: f.database,
        generateWaveform: async () => {
          generationCalls += 1;
          throw Object.assign(new Error("Temporary FFmpeg resource failure"), { code: "EAGAIN" });
        },
        sleep: async (milliseconds) => { delays.push(milliseconds); },
      }),
      /Temporary FFmpeg resource failure/,
    );

    const [failed] = await f.database.select().from(waveformJobs).where(eq(waveformJobs.id, job.id));
    const assets = await f.database.select().from(waveformAssets).where(eq(waveformAssets.waveformJobId, job.id));
    assert.equal(generationCalls, WAVEFORM_MAX_ATTEMPTS);
    assert.deepEqual(delays, [...WAVEFORM_RETRY_BACKOFF_MS]);
    assert.equal(failed.status, "failed");
    assert.equal(failed.stage, "failed");
    assert.equal(failed.attempts, WAVEFORM_MAX_ATTEMPTS);
    assert.equal(failed.errorCode, "waveform_retry_exhausted");
    assert.match(failed.errorMessage ?? "", /failed after 3 attempts/i);
    assert.equal(assets.length, 0);
  } finally {
    await f.close();
  }
});

test("waveform does not retry permanent decode failures", async () => {
  const f = await fixture();
  try {
    const job = await createSourceWaveformJob(f);
    const delays: number[] = [];
    let generationCalls = 0;

    await assert.rejects(
      () => handleWaveformJob(sourceWaveformPayload(f, job.id), {
        db: f.database,
        generateWaveform: async () => {
          generationCalls += 1;
          throw new Error("Invalid data found when processing input.");
        },
        sleep: async (milliseconds) => { delays.push(milliseconds); },
      }),
      /Invalid data found when processing input/,
    );

    const [failed] = await f.database.select().from(waveformJobs).where(eq(waveformJobs.id, job.id));
    assert.equal(generationCalls, 1);
    assert.deepEqual(delays, []);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    assert.equal(failed.errorCode, "waveform_failed");
    assert.match(failed.errorMessage ?? "", /Invalid data found/);
  } finally {
    await f.close();
  }
});

test("waveform retry resumes after local worker recovery with the remaining attempt budget", async () => {
  const f = await fixture();
  try {
    const job = await createSourceWaveformJob(f);
    let interruptedCalls = 0;
    await assert.rejects(
      () => handleWaveformJob(sourceWaveformPayload(f, job.id), {
        db: f.database,
        generateWaveform: async () => {
          interruptedCalls += 1;
          throw Object.assign(new Error("Temporary FFmpeg resource failure"), { code: "EAGAIN" });
        },
        sleep: async () => { throw new Error("Worker stopped during retry backoff"); },
      }),
      /Worker stopped during retry backoff/,
    );

    const [interrupted] = await f.database.select().from(waveformJobs).where(eq(waveformJobs.id, job.id));
    assert.equal(interrupted.status, "processing");
    assert.equal(interrupted.stage, "retrying");
    assert.equal(interrupted.attempts, 1);

    const dispatched: Array<{
      waveformJobId: string;
      projectId: string;
      sourceAssetId?: string;
      stemAssetId?: string;
    }> = [];
    const recovery = await recoverPendingLocalWaveformJobs(f.database, async (payload) => {
      dispatched.push(payload);
    });
    assert.deepEqual(recovery.resetJobIds, [job.id]);
    assert.deepEqual(recovery.requeuedJobIds, [job.id]);
    assert.deepEqual(recovery.failedJobIds, []);
    assert.equal(dispatched.length, 1);

    const [requeued] = await f.database.select().from(waveformJobs).where(eq(waveformJobs.id, job.id));
    assert.equal(requeued.status, "queued");
    assert.equal(requeued.attempts, 1, "recovery preserves the already-spent attempt");

    const resumedDelays: number[] = [];
    let resumedCalls = 0;
    await handleWaveformJob(dispatched[0]!, {
      db: f.database,
      generateWaveform: async () => {
        resumedCalls += 1;
        if (resumedCalls === 1) {
          throw Object.assign(new Error("Temporary FFmpeg resource failure"), { code: "EAGAIN" });
        }
        return validWaveformDocument();
      },
      sleep: async (milliseconds) => { resumedDelays.push(milliseconds); },
    });

    const [completed] = await f.database.select().from(waveformJobs).where(eq(waveformJobs.id, job.id));
    const assets = await f.database.select().from(waveformAssets).where(eq(waveformAssets.waveformJobId, job.id));
    assert.equal(interruptedCalls + resumedCalls, WAVEFORM_MAX_ATTEMPTS);
    assert.deepEqual(resumedDelays, [WAVEFORM_RETRY_BACKOFF_MS[1]]);
    assert.equal(completed.status, "complete");
    assert.equal(completed.attempts, WAVEFORM_MAX_ATTEMPTS);
    assert.equal(assets.length, 1);
    assert.equal(assets[0]?.waveformJobId, job.id);
  } finally {
    await f.close();
  }
});

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
    assert.deepEqual(metadata.stems, ["vocals", "instrumental"]);
    assert.deepEqual(metadata.models, ["kim_vocal_2"]);

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

test("startup recovery enqueues persisted waveform jobs once for every saved stem", async () => {
  const f = await fixture();
  try {
    await handleSeparationJob(payloadOf(f), {
      db: f.database,
      openEngine: identityEngine(),
      // The separation transaction commits its stem and waveform rows, but the
      // process stops before the local broker receives any waveform jobs.
      enqueueWaveform: async () => undefined,
    });

    const [separation] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(separation.status, "complete");
    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    const pending = await f.database.select().from(waveformJobs).where(eq(waveformJobs.projectId, f.project.id));
    const stemJobs = pending.filter((job) => job.stemAssetId !== null);
    assert.equal(stems.length, 2);
    assert.equal(stemJobs.length, stems.length);
    assert.ok(stemJobs.every((job) => job.status === "queued"));

    const dispatched: Array<{ waveformJobId: string; projectId: string; stemAssetId?: string }> = [];
    const recovery = await recoverPendingLocalWaveformJobs(f.database, async (payload) => {
      dispatched.push(payload);
    });

    assert.deepEqual(recovery.resetJobIds, []);
    assert.deepEqual(new Set(recovery.enqueuedJobIds), new Set(stemJobs.map((job) => job.id)));
    assert.deepEqual(recovery.failedJobIds, []);
    assert.equal(dispatched.length, stems.length);
    assert.deepEqual(new Set(dispatched.map((payload) => payload.stemAssetId)), new Set(stems.map((stem) => stem.id)));
    assert.equal(new Set(dispatched.map((payload) => payload.waveformJobId)).size, stems.length);
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

test("API restart interrupts active separation, removes dead-worker temp output, and retry replaces one stem set", async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | null = null;
  let childTempDirectory: string | null = null;
  let liveTempDirectory: string | null = null;
  let legacyTempDirectory: string | null = null;
  try {
    await f.database
      .update(processingJobs)
      .set({ status: "processing", stage: "separating", startedAt: new Date() })
      .where(eq(processingJobs.id, f.job.id));

    // A child process owns a live worker thread and a partial output directory.
    // Terminating the API process must terminate all of its worker threads.
    const childScript = [
      `const { Worker } = require("node:worker_threads");`,
      `const { mkdtemp, writeFile } = require("node:fs/promises");`,
      `const { tmpdir } = require("node:os");`,
      `const { join } = require("node:path");`,
      `(async () => {`,
      `  const directory = await mkdtemp(join(tmpdir(), "arena-separation-" + process.pid + "-"));`,
      `  await writeFile(join(directory, "partial.wav"), "unfinished output");`,
      `  const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });`,
      `  await new Promise(resolve => worker.once("online", resolve));`,
      `  process.send({ pid: process.pid, threadId: worker.threadId, directory });`,
      `})().catch(error => { console.error(error); process.exit(1); });`,
    ].join("\n");
    child = spawn(process.execPath, ["-e", childScript], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const childReady = await new Promise<{ pid: number; threadId: number; directory: string }>((resolve, reject) => {
      child!.once("message", (message) => resolve(message as { pid: number; threadId: number; directory: string }));
      child!.once("error", reject);
    });
    childTempDirectory = childReady.directory;
    assert.equal(childReady.pid, child.pid);
    assert.ok(childReady.threadId > 0, "the child owns an active worker thread");

    liveTempDirectory = await mkdtemp(join(tmpdir(), `arena-separation-${process.pid}-`));
    await writeFile(join(liveTempDirectory, "active.wav"), "owned by this live process");
    legacyTempDirectory = await mkdtemp(join(tmpdir(), "arena-separation-legacy-"));
    await writeFile(join(legacyTempDirectory, "partial.wav"), "legacy output");

    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(child.kill("SIGTERM"), true, "the API process accepts the restart signal");
    const exit = await childExit;
    assert.equal(exit.signal, "SIGTERM", "the process exits with its worker thread");

    const recovery = await recoverInterruptedLocalSeparationJobs(f.database);
    assert.deepEqual(recovery.interruptedJobIds, [f.job.id]);
    assert.ok(recovery.cleanedTempDirectories.includes(basename(childTempDirectory)),
      "the abandoned worker's partial output directory is removed");
    assert.ok(recovery.cleanedTempDirectories.includes(basename(legacyTempDirectory)),
      "unscoped temporary outputs from older runs are also removed");
    assert.ok(!recovery.cleanedTempDirectories.includes(basename(liveTempDirectory)),
      "a directory owned by a live process is preserved");
    await assert.rejects(() => stat(join(childTempDirectory!, "partial.wav")), /ENOENT/);
    await assert.rejects(() => stat(join(legacyTempDirectory!, "partial.wav")), /ENOENT/);
    assert.equal((await stat(join(liveTempDirectory, "active.wav"))).isFile(), true);

    const [interrupted] = await f.database
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, f.job.id));
    assert.equal(interrupted.status, "failed");
    assert.equal(interrupted.stage, "interrupted");
    assert.equal(interrupted.errorCode, "processor_interrupted");
    assert.match(interrupted.errorMessage ?? "", /Retry separation to continue/);

    // A partial row from the killed attempt is removed by the normal atomic
    // retry transaction before the completed stem set is inserted.
    await f.database.insert(stemAssets).values({
      projectId: f.project.id,
      sourceAssetId: f.source.id,
      separationJobId: f.job.id,
      stemType: "unfinished",
      engine: "mdx",
      model: f.job.model,
      modelVersion: KIM.sha256,
      storageKey: f.source.storageKey,
      checksumSha256: f.source.checksumSha256,
      durationSeconds: 1,
      sampleRate: 44_100,
      channels: 2,
      codec: "pcm_s16le",
      format: "wav",
      fileSizeBytes: 1,
    });
    let retryRuns = 0;
    const retry = await retrySeparationJob(f.database, f.job.id, {
      handOff: async () => {
        retryRuns += 1;
        await handleSeparationJob(payloadOf(f), { db: f.database, openEngine: identityEngine() });
      },
    });
    assert.deepEqual(retry, { queued: true });
    assert.equal(retryRuns, 1);
    const [completed] = await f.database
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, f.job.id));
    assert.equal(completed.status, "complete");
    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    assert.equal(stems.length, 2, "exactly one complete output set is stored");
    assert.deepEqual(new Set(stems.map((stem) => stem.stemType)), new Set(["vocals", "instrumental"]));

    const duplicateRetry = await retrySeparationJob(f.database, f.job.id, {
      handOff: async () => { retryRuns += 1; },
    });
    assert.equal(duplicateRetry.queued, false, "a completed job cannot start a duplicate retry");
    assert.equal(retryRuns, 1);
    assert.equal(
      (await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id))).length,
      2,
    );
  } finally {
    if (child !== null && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (childTempDirectory !== null) await rm(childTempDirectory, { recursive: true, force: true });
    if (liveTempDirectory !== null) await rm(liveTempDirectory, { recursive: true, force: true });
    if (legacyTempDirectory !== null) await rm(legacyTempDirectory, { recursive: true, force: true });
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

test("startup recovery enqueues committed stem waveforms after a broker restart", async () => {
  const f = await fixture();
  try {
    // These rows model the committed separation transaction immediately
    // before its waveform jobs were submitted to the now-lost broker.
    const stemBytes = await readFile(f.sourcePath);
    const stems = [];
    for (const stemType of ["vocals", "instrumental"]) {
      const storageKey = privateObjectKey(f.project.id, "stem", "wav");
      await getStorage().putFile(storageKey, f.sourcePath, "audio/wav");
      const [stem] = await f.database
        .insert(stemAssets)
        .values({
          projectId: f.project.id,
          sourceAssetId: f.source.id,
          separationJobId: f.job.id,
          stemType,
          engine: "mdx",
          model: f.job.model,
          modelVersion: KIM.sha256,
          storageKey,
          checksumSha256: f.source.checksumSha256,
          durationSeconds: 1,
          sampleRate: 44_100,
          channels: 2,
          codec: "pcm_s16le",
          format: "wav",
          fileSizeBytes: stemBytes.length,
        })
        .returning();
      stems.push(stem);
    }
    const jobs = await f.database
      .insert(waveformJobs)
      .values(stems.map((stem, index) => ({
        projectId: f.project.id,
        stemAssetId: stem.id,
        status: index === 0 ? "queued" : "processing",
        stage: index === 0 ? "queued" : "decoding",
        idempotencyKey: `waveform:stem:${stem.id}`,
      })))
      .returning();

    // A fresh broker has no knowledge of the jobs that were in the old
    // process. Register the real handler against this disposable database.
    const restartedBroker = new LocalJobBroker();
    restartedBroker.register("waveyard-waveform", (payload) => handleWaveformJob(payload, { db: f.database }));
    const recovery = await recoverPendingLocalWaveformJobs(
      f.database,
      (payload) => restartedBroker.submit(
        "waveyard-waveform",
        payload.waveformJobId,
        payload as unknown as Record<string, unknown>,
      ),
    );
    assert.deepEqual(new Set(recovery.requeuedJobIds), new Set(jobs.map((job) => job.id)));
    assert.deepEqual(recovery.failedJobIds, []);
    assert.equal(await restartedBroker.drain(10_000), true);

    const completedJobs = await f.database
      .select()
      .from(waveformJobs)
      .where(eq(waveformJobs.projectId, f.project.id));
    const assets = await f.database
      .select()
      .from(waveformAssets)
      .where(eq(waveformAssets.projectId, f.project.id));
    assert.equal(assets.length, stems.length, "each committed stem receives exactly one waveform asset");
    for (const stem of stems) {
      const stemJobs = completedJobs.filter((job) => job.stemAssetId === stem.id);
      assert.equal(stemJobs.length, 1, "there is one durable waveform job for each stem");
      assert.equal(stemJobs[0]?.status, "complete");
      const stemWaveforms = assets.filter((asset) => asset.stemAssetId === stem.id);
      assert.equal(stemWaveforms.length, 1, "recovered work creates exactly one waveform per stem");
      assert.equal(stemWaveforms[0]?.waveformJobId, stemJobs[0]?.id);
    }
    assert.equal(restartedBroker.stats().submitted, stems.length, "one broker submission per stem");
    const secondRecovery = await recoverPendingLocalWaveformJobs(
      f.database,
      async () => { throw new Error("completed jobs must not be enqueued again"); },
    );
    assert.deepEqual(secondRecovery.requeuedJobIds, []);
  } finally {
    await f.close();
  }
});


test("stem layers: a second pass on a STEM pulls named layers out of it", async () => {
  // Parent = a melody ("other") stem whose audio IS the fixture's source
  // WAV (a real stored object the handler can download).
  const f = await fixture({ model: "kim_vocal_2" });
  try {
    const [parentStem] = await f.database
      .insert(stemAssets)
      .values({
        projectId: f.project.id,
        sourceAssetId: f.source.id,
        separationJobId: f.job.id,
        stemType: "other",
        engine: "mdx",
        model: "kuielab_b_other",
        modelVersion: "test",
        storageKey: f.source.storageKey,
        checksumSha256: "test",
        durationSeconds: 1,
        sampleRate: 44_100,
        channels: 2,
        codec: "pcm_s16le",
        format: "wav",
        fileSizeBytes: 1,
      })
      .returning();

    const seenSpecs: string[] = [];
    const engine: (spec: MdxModelSpec) => Promise<OpenedEngine> = async (spec) => {
      seenSpecs.push(spec.id);
      return { infer: (async (spek: Float32Array) => spek) as MdxInfer, release: async () => {}, resolvedDevice: "cpu" };
    };
    await handleSeparationJob(
      { ...payloadOf(f), parentStemAssetId: parentStem.id },
      { db: f.database, openEngine: engine },
    );

    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.status, "complete");
    const metadata = JSON.parse(row.metadata);
    assert.deepEqual(metadata.stems, ["other/vocals", "other/instrumental"], "layered names: <parent>/<child>");

    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    const byType = new Map(stems.map((stem) => [stem.stemType, stem]));
    assert.ok(byType.has("other/vocals"), "backing-vocals layer out of the melody");
    assert.ok(byType.has("other/instrumental"), "melody-minus-vocals layer");
    assert.equal(seenSpecs[0], "kim_vocal_2", "the second-pass model ran");
    // Identity inference on the parent stem's audio: both layers decode to
    // the parent's own samples (provenance: input was the STEM, not the source).
    for (const layer of ["other/vocals", "other/instrumental"]) {
      assert.equal(byType.get(layer)?.durationSeconds, 1);
    }
  } finally {
    await f.close();
  }
});

test("4-stem recipe: four stems stored, each attributed to its own model", async () => {
  const f = await fixture({ model: "stems_4" });
  try {
    const opened: string[] = [];
    let liveEngines = 0;
    const engine: (spec: MdxModelSpec) => Promise<OpenedEngine> = async (spec) => {
      assert.equal(liveEngines, 0, "the previous model must be released before opening another");
      liveEngines += 1;
      opened.push(spec.id);
      return { infer: (async (spek: Float32Array) => spek) as MdxInfer, release: async () => { liveEngines -= 1; }, resolvedDevice: "cpu" };
    };
    await handleSeparationJob(payloadOf(f), { db: f.database, openEngine: engine });
    assert.equal(liveEngines, 0, "the final model is released too");

    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.status, "complete");
    const metadata = JSON.parse(row.metadata);
    assert.equal(metadata.model, "stems_4");
    assert.deepEqual(metadata.stems, ["vocals", "drums", "bass", "other"]);
    assert.equal(metadata.outputCount, 4);
    assert.deepEqual(metadata.models, ["kim_vocal_2", "kuielab_b_drums", "kuielab_b_bass", "kuielab_b_other"]);

    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    assert.equal(stems.length, 4, "the stem.fm set: vocals, drums, bass, melody");
    const byType = new Map(stems.map((stem) => [stem.stemType, stem]));
    assert.equal(byType.get("vocals")?.model, "kim_vocal_2");
    assert.equal(byType.get("drums")?.model, "kuielab_b_drums");
    assert.equal(byType.get("bass")?.model, "kuielab_b_bass");
    assert.equal(byType.get("other")?.model, "kuielab_b_other");
    for (const stem of stems) {
      assert.equal(stem.durationSeconds, 1, "every stem is full length");
      assert.ok(stem.fileSizeBytes > 44, "stored WAV has real bytes");
    }
    // Four DISTINCT engines opened (one per recipe model).
    assert.equal(new Set(opened).size, 4);
  } finally {
    await f.close();
  }
});

// ------------------------------------------------------------- deep pass

/**
 * The A7 deep bridge through the handler: the SAME durable pipeline (job
 * row → payload → stems → waveform jobs) with the engine that only runs when
 * the owner has prepared it — and honest unavailability when they have not.
 */

/** The handler reads process.env (no injected env), so the stand-in engine's
 *  variables are installed there for the test and restored after. The
 *  dummy checkpoint goes into the fixture's own models dir — the same
 *  WAVEYARD_MODELS_DIR the MDX path uses. */
function captureDeepEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of STUB_DEEP_ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function installDeepEnv(env: NodeJS.ProcessEnv) {
  for (const key of STUB_DEEP_ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  resetDeepProbeCacheForTests();
}

function restoreDeepEnv(saved: Record<string, string | undefined>) {
  for (const key of STUB_DEEP_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetDeepProbeCacheForTests();
}

test("deep pass: the prepared engine runs end to end and stores six attributed stems", async (t) => {
  const f = await fixture({ model: "deep_6s" });
  const stubDirectory = await mkdtemp(join(tmpdir(), "wy-deep-handler-"));
  const savedEnv = captureDeepEnv();
  try {
    const engine = await writeStubDeepEngine(stubDirectory, f.sourcePath, { demucsVersion: "4.0.1", cuda: false, modelsDir: f.modelsDir });
    if (engine === null) {
      t.skip(NO_TEST_PYTHON);
      return;
    }
    installDeepEnv(engine.env);

    await handleSeparationJob(payloadOf(f), { db: f.database });

    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.status, "complete");
    assert.equal(row.stage, "complete");
    assert.equal(row.resolvedDevice, "cpu");
    assert.equal(row.errorCode, null);
    const metadata = JSON.parse(row.metadata);
    assert.equal(metadata.engine, "demucs");
    assert.equal(metadata.model, "deep_6s");
    assert.deepEqual(metadata.models, ["deep_6s"]);
    assert.equal(metadata.outputCount, 6);
    assert.deepEqual(metadata.stems, [...DEEP_STEM_TYPES]);

    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    assert.equal(stems.length, 6, "six deep lanes");
    for (const stem of stems) {
      assert.equal(stem.engine, "demucs", "attributed to the deep engine");
      assert.equal(stem.model, "deep_6s");
      assert.equal(
        stem.modelVersion,
        "htdemucs_6s@5c90dfd2-34c22ccb/demucs-4.0.1",
        "provenance pins the model family, the exact checkpoint identity and the engine version",
      );
      assert.equal(stem.sampleRate, 44_100);
      assert.equal(stem.channels, 2);
      assert.equal(stem.format, "wav");
      assert.equal(stem.durationSeconds, 1);
      const stored = getStorage().getLocalPath(stem.storageKey);
      assert.ok(stored, "deep stem object exists");
      const decoded = decodeWav16(new Uint8Array(await readFile(stored!)));
      assert.equal(decoded?.sampleRate, 44_100);
      assert.equal(decoded?.frames, SAMPLES, "full-length lane");
    }

    // The bridge loaded the local checkpoint out of the fixture's models dir
    // (never the remote family name) and was handed the handler's own
    // decoded 44.1 kHz WAV — not the stored container.
    const calls = await engine.calls();
    const runCall = calls.find((call) => call.includes("-m demucs"));
    assert.ok(runCall, "Demucs was invoked");
    assert.match(runCall!, new RegExp(`--name ${DEEP_MODEL_SIGNATURE}(\\s|$)`));
    assert.ok(runCall!.includes(`--repo ${f.modelsDir}`), `the fixture's WAVEYARD_MODELS_DIR is the local repo: ${runCall}`);
    assert.match(runCall!, /deep-input\.wav/);

    // One waveform job per deep lane, each with its own failure boundary.
    const wfJobs = await f.database.select().from(waveformJobs).where(eq(waveformJobs.projectId, f.project.id));
    const stemWaveformJobs = wfJobs.filter((job) => job.stemAssetId !== null);
    assert.equal(stemWaveformJobs.length, 6);
  } finally {
    restoreDeepEnv(savedEnv);
    await rm(stubDirectory, { recursive: true, force: true });
    await f.close();
  }
});

test("deep layers: a deep pass on a STEM names every lane <parent>/<child>", async (t) => {
  const f = await fixture({ model: "deep_6s" });
  const stubDirectory = await mkdtemp(join(tmpdir(), "wy-deep-layers-"));
  const savedEnv = captureDeepEnv();
  try {
    const [parentStem] = await f.database
      .insert(stemAssets)
      .values({
        projectId: f.project.id,
        sourceAssetId: f.source.id,
        separationJobId: f.job.id,
        stemType: "other",
        engine: "mdx",
        model: "kuielab_b_other",
        modelVersion: "test",
        storageKey: f.source.storageKey,
        checksumSha256: "test",
        durationSeconds: 1,
        sampleRate: 44_100,
        channels: 2,
        codec: "pcm_s16le",
        format: "wav",
        fileSizeBytes: 1,
      })
      .returning();

    const engine = await writeStubDeepEngine(stubDirectory, f.sourcePath, { demucsVersion: "4.0.1", cuda: false, modelsDir: f.modelsDir });
    if (engine === null) {
      t.skip(NO_TEST_PYTHON);
      return;
    }
    installDeepEnv(engine.env);

    await handleSeparationJob(
      { ...payloadOf(f), parentStemAssetId: parentStem.id },
      { db: f.database },
    );

    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    const metadata = JSON.parse(row.metadata);
    assert.deepEqual(metadata.stems, [
      "other/vocals",
      "other/drums",
      "other/bass",
      "other/guitar",
      "other/piano",
      "other/other",
    ]);
    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    assert.equal(stems.length, 6);
    assert.ok(stems.every((stem) => stem.stemType.startsWith("other/")), "every deep lane is a layer of the stem");
    assert.ok(stems.some((stem) => stem.stemType === "other/guitar"), "guitar inside the melody is addressable");
  } finally {
    restoreDeepEnv(savedEnv);
    await rm(stubDirectory, { recursive: true, force: true });
    await f.close();
  }
});

test("deep pass with no prepared engine: honest separation_unavailable, nothing stored", async (t) => {
  const f = await fixture({ model: "deep_6s" });
  const stubDirectory = await mkdtemp(join(tmpdir(), "wy-deep-missing-"));
  const savedEnv = captureDeepEnv();
  try {
    const engine = await writeStubDeepEngine(stubDirectory, f.sourcePath, { demucsVersion: null, modelsDir: f.modelsDir });
    if (engine === null) {
      t.skip(NO_TEST_PYTHON);
      return;
    }
    installDeepEnv(engine.env);

    await assert.rejects(
      () => handleSeparationJob(payloadOf(f), { db: f.database }),
      (error: unknown) => {
        assert.match(error instanceof Error ? error.message : "", /Demucs is not installed/);
        return true;
      },
    );
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.status, "failed");
    assert.equal(row.errorCode, "separation_unavailable");
    assert.match(row.errorMessage ?? "", /pip install demucs/, "records the prepare step");
    const stems = await f.database.select().from(stemAssets);
    assert.equal(stems.length, 0, "not one fabricated lane");
    const stemDir = join(f.storageDir, "projects", f.project.id, "stem");
    await assert.rejects(() => readdir(stemDir), /ENOENT/, "no stem objects were written");
  } finally {
    restoreDeepEnv(savedEnv);
    await rm(stubDirectory, { recursive: true, force: true });
    await f.close();
  }
});

test("deep seam: the decoded 44.1 kHz PCM is the engine input, no MDX engine opens, lanes persist exactly", async () => {
  const f = await fixture({ model: "deep_6s" });
  try {
    const sourceSamples = decodeWav16(new Uint8Array(await readFile(f.sourcePath)));
    assert.ok(sourceSamples, "fixture source decodes");
    const captured: { inputBytes: Uint8Array | null; progressPercent: number | null } = {
      inputBytes: null,
      progressPercent: null,
    };
    const openEngine = async (): Promise<OpenedEngine> => {
      throw new Error("the deep pass must never open an MDX engine");
    };
    const runDeep: NonNullable<SeparationHandlerDeps["runDeep"]> = async (request) => {
      captured.inputBytes = new Uint8Array(await readFile(request.inputPath));
      request.onProgress?.(100);
      // The progress contract: the durable row carries the engine's own
      // percent while the pass runs (poll briefly — the write is async).
      for (let attempt = 0; attempt < 20 && captured.progressPercent === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const [mid] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
        const progress = JSON.parse(mid.metadata).progress as { percent?: number; phase?: string } | undefined;
        if (progress?.percent === 100 && progress.phase === "deep") captured.progressPercent = progress.percent;
      }
      await mkdir(request.outputDirectory, { recursive: true });
      const stems = [];
      for (const [index, stemType] of DEEP_STEM_TYPES.entries()) {
        const path = join(request.outputDirectory, `${stemType}.wav`);
        const scale = 0.3 + index * 0.1; // distinct lanes so provenance is provable
        const scaled = new Float32Array(sourceSamples.samples.length);
        for (let i = 0; i < scaled.length; i += 1) scaled[i] = sourceSamples.samples[i] * scale;
        await writeFile(path, encodeWav16(scaled, 44_100));
        stems.push({ stemType, path, bytes: (await stat(path)).size });
      }
      return {
        engine: "demucs",
        model: "deep_6s",
        modelName: "htdemucs_6s",
        modelVersion: "stub-engine-1",
        checkpointPath: join(request.outputDirectory, "not-a-real-checkpoint.th"),
        resolvedDevice: "cpu",
        stems,
      };
    };

    await handleSeparationJob(payloadOf(f), { db: f.database, openEngine, runDeep });

    assert.equal(captured.progressPercent, 100, "progress reached the durable row while separating");
    assert.ok(captured.inputBytes, "the engine received a file");
    assert.equal(captured.inputBytes!.length, 44 + SAMPLES * 4, "input is the decoded 1 s stereo WAV");
    const inputDecoded = decodeWav16(captured.inputBytes!);
    assert.equal(inputDecoded?.sampleRate, 44_100);
    assert.equal(inputDecoded?.channels, 2);

    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    assert.equal(stems.length, 6);
    for (const [index, stemType] of DEEP_STEM_TYPES.entries()) {
      const stem = stems.find((row) => row.stemType === stemType);
      assert.ok(stem, `${stemType} lane stored`);
      assert.equal(stem!.modelVersion, "stub-engine-1");
      const decoded = decodeWav16(new Uint8Array(await readFile(getStorage().getLocalPath(stem!.storageKey)!)));
      assert.ok(decoded, `${stemType} decodes`);
      const scale = 0.3 + index * 0.1;
      let err = 0;
      let ref = 0;
      for (let i = 0; i < decoded!.samples.length; i += 1) {
        const expected = sourceSamples.samples[i] * scale;
        const delta = decoded!.samples[i] - expected;
        err += delta * delta;
        ref += expected * expected;
      }
      const snr = 10 * Math.log10(ref / Math.max(err, 1e-30));
      assert.ok(snr > 60, `${stemType} persists exactly what the engine produced (SNR ${snr.toFixed(1)} dB)`);
    }
  } finally {
    await f.close();
  }
});
