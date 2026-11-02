import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { basename, join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import { eq } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";

import { checksumFile } from "@workspace/arena/lib/waveyard/audio";
import { decodeWav16, encodeWav16 } from "@workspace/arena/lib/waveyard/mixer/synth";
import { getStorage, privateObjectKey } from "@workspace/arena/lib/waveyard/storage";
import { processingJobs, projects, sourceAssets, stemAssets, waveformAssets, waveformJobs } from "@workspace/db/waveyardSchema";
import { findMdxModel, type MdxInfer, type MdxModelSpec } from "@workspace/arena/lib/waveyard/separation/mdx";
import { DEEP_MODEL_SIGNATURE, resetDeepProbeCacheForTests } from "@workspace/arena/lib/waveyard/separation/deep";
import { NO_TEST_PYTHON, STUB_DEEP_ENV_KEYS, writeStubDeepEngine } from "@workspace/arena/lib/waveyard/separation/deep-fixtures";
import { DEEP_STEM_TYPES } from "@workspace/arena/lib/waveyard/separation/modes";
import { claimProcessingJob } from "@workspace/arena/lib/waveyard/separation/claim";
import { requestSeparationCancellation } from "@workspace/arena/lib/waveyard/separation/cancel";
import { retrySeparationJob } from "@workspace/arena/lib/waveyard/separation/retry";
import { SEPARATION_QUEUE } from "@workspace/arena/lib/waveyard/queue";
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
import { cleanupOrphanedSourceObjects, ORPHAN_SOURCE_GRACE_PERIOD_MS } from "./source-cleanup";

const KIM = findMdxModel("kim_vocal_2")!;
type Fixture = SeparationFixture;
const arenaPackageRoot = fileURLToPath(new URL("../../../..", import.meta.url));

function postgresBinary(name: string): string {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const packageName = process.platform === "win32" ? "windows-x64" : "linux-x64";
  const bundled = path.join(arenaPackageRoot, "..", "..", "node_modules", "@embedded-postgres", packageName, "native", "bin", executable);
  if (existsSync(bundled)) return bundled;

  const locator = process.platform === "win32" ? "where.exe" : "which";
  const located = spawnSync(locator, [executable], { encoding: "utf8" }).stdout?.trim().split(/\r?\n/)[0];
  if (located && existsSync(located)) return located;

  // Nix-hosted workspaces may expose PostgreSQL in the store without adding
  // initdb/postgres to PATH.
  if (process.platform !== "win32" && existsSync("/nix/store")) {
    const stores = readdirSync("/nix/store")
      .filter((entry) => entry.includes("postgresql-"))
      .sort()
      .reverse();
    for (const store of stores) {
      const candidate = path.join("/nix/store", store, "bin", executable);
      if (existsSync(candidate)) return candidate;
    }
  }
  return bundled;
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function independentRecoveryPostgres(t: TestContext) {
  if (!existsSync(postgresBinary("initdb")) || !existsSync(postgresBinary("postgres"))) {
    t.skip("a local PostgreSQL server is required to test independent recovery processes");
    return null;
  }

  const root = mkdtempSync(join(tmpdir(), "waveform-recovery-processes-"));
  const dataDirectory = join(root, "data");
  const port = await availablePort();
  const passwordFile = join(root, ".password");
  writeFileSync(passwordFile, "waveform-recovery-test", { mode: 0o600 });
  const initialize = spawnSync(postgresBinary("initdb"), [
    "-D", dataDirectory, "-U", "arena", "--pwfile", passwordFile, "-E", "UTF8", "--locale", "C", "-A", "scram-sha-256",
  ], { encoding: "utf8", timeout: 120_000 });
  rmSync(passwordFile, { force: true });
  if (initialize.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`initdb failed (${initialize.status}): ${initialize.stdout ?? ""}${initialize.stderr ?? ""}`.slice(0, 2000));
  }

  const serverProcess: ChildProcess = spawn(postgresBinary("postgres"), [
    "-D", dataDirectory, "-p", String(port), "-h", "127.0.0.1", "-F",
    "-c", "max_connections=30", "-c", "unix_socket_directories=",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const { Client, Pool } = await import("pg");
  const { waitForPostgresReady } = await import("../library/pg-readiness");
  try {
    await waitForPostgresReady({
      createClient: () => new Client({ connectionString: `postgresql://arena:waveform-recovery-test@127.0.0.1:${port}/postgres` }),
      useConnectedClient: async (admin) => { await admin.query("create database waveform_recovery_test"); },
    });
    const connectionString = `postgresql://arena:waveform-recovery-test@127.0.0.1:${port}/waveform_recovery_test`;
    const migrator = new Client({ connectionString });
    await migrator.connect();
    const desktop = await import(pathToFileURL(path.resolve(arenaPackageRoot, "../../desktop/database.mjs")).href);
    await desktop.migrate(migrator, join(arenaPackageRoot, "desktop-migrations"));
    await migrator.end();

    const pool = new Pool({ connectionString, max: 8 });
    return {
      connectionString,
      database: drizzlePg(pool),
      async close() {
        await pool.end().catch(() => undefined);
        spawnSync(postgresBinary("pg_ctl"), ["-D", dataDirectory, "-m", "fast", "-w", "-t", "20", "stop"], { timeout: 30_000 });
        if (serverProcess.exitCode === null) serverProcess.kill();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    spawnSync(postgresBinary("pg_ctl"), ["-D", dataDirectory, "-m", "immediate", "-w", "-t", "20", "stop"], { timeout: 30_000 });
    if (serverProcess.exitCode === null) serverProcess.kill();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function startRecoveryProcess(
  connectionString: string,
  jobId: string,
  mode: "hold" | "complete" | "claim-only",
): ChildProcess & { send(message: unknown): boolean } {
  const importFlagIndex = process.execArgv.findIndex((arg, index, args) =>
    arg === "--import" && args[index + 1]?.includes("tsx/dist/loader.mjs"));
  const tsxImport = process.execArgv.find((arg) =>
    arg.startsWith("--import=") && arg.includes("tsx/dist/loader.mjs"));
  const execArgv = importFlagIndex >= 0
    ? ["--import", process.execArgv[importFlagIndex + 1]!]
    : tsxImport
      ? [tsxImport]
      : [];
  return fork(fileURLToPath(new URL("./recovery-process.test-helper.ts", import.meta.url)), [], {
    execArgv,
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
      WAVEFORM_RECOVERY_TEST_JOB_ID: jobId,
      WAVEFORM_RECOVERY_TEST_MODE: mode,
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
}

function waitForRecoveryMessage(
  child: ChildProcess,
  type: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for recovery child message: ${type}`));
    }, 20_000);
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const record = message as Record<string, unknown>;
      if (record.type === "error") {
        cleanup();
        reject(new Error(String(record.message)));
      } else if (record.type === type) {
        cleanup();
        resolve(record);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Recovery child exited before ${type} (code=${code}, signal=${signal})`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function waitForRecoveryProcessExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode === 0 ? Promise.resolve() : Promise.reject(new Error(
      `Recovery process exited with code=${child.exitCode}, signal=${child.signalCode}.`,
    ));
  }
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Recovery process exited with code=${code}, signal=${signal}.`));
    });
    child.once("error", reject);
  });
}

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

test("source cleanup removes only old generated objects without a source row", async () => {
  const f = await fixture();
  try {
    const storage = getStorage();
    const referencedKey = f.source.storageKey;
    const orphanKey = privateObjectKey(f.project.id, "source", "wav");
    const recentKey = privateObjectKey(f.project.id, "source", "wav");
    const nonGeneratedKey = `projects/${f.project.id}/source/legacy-upload.wav`;
    const otherCategoryKey = privateObjectKey(f.project.id, "export", "wav");
    for (const key of [orphanKey, recentKey, nonGeneratedKey, otherCategoryKey]) {
      await storage.putBuffer(key, "test");
    }

    const oldTime = new Date(Date.now() - ORPHAN_SOURCE_GRACE_PERIOD_MS - 60_000);
    await utimes(storage.getLocalPath(orphanKey)!, oldTime, oldTime);
    await utimes(storage.getLocalPath(nonGeneratedKey)!, oldTime, oldTime);
    await utimes(storage.getLocalPath(otherCategoryKey)!, oldTime, oldTime);

    const removed = await cleanupOrphanedSourceObjects({
      db: f.database,
      storage,
      now: new Date(),
    });

    assert.deepEqual(removed, [orphanKey]);
    assert.equal(await storage.exists(referencedKey), true, "a source object with a source row is retained");
    assert.equal(await storage.exists(recentKey), true, "a recent unreferenced source object is retained");
    assert.equal(await storage.exists(nonGeneratedKey), true, "non-generated source paths are retained");
    assert.equal(await storage.exists(otherCategoryKey), true, "objects outside the source category are retained");
    assert.equal(await storage.exists(orphanKey), false, "an old generated source object without a row is removed");
    assert.equal((await f.database.select().from(sourceAssets)).length, 1, "source rows remain unchanged");
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

test("waveform save retry deletes a partially written object and leaves one asset", async () => {
  const f = await fixture();
  try {
    const job = await createSourceWaveformJob(f);
    const baseStorage = getStorage();
    const flakyStorage = Object.create(baseStorage) as typeof baseStorage;
    const attemptedKeys: string[] = [];
    const deletedKeys: string[] = [];
    const delays: number[] = [];
    let writeCalls = 0;

    flakyStorage.putFile = async (key, localPath, contentType) => {
      attemptedKeys.push(key);
      await baseStorage.putFile(key, localPath, contentType);
      writeCalls += 1;
      if (writeCalls === 1) {
        throw Object.assign(new Error("Temporary object-store write acknowledgement lost"), { code: "EIO" });
      }
    };
    flakyStorage.delete = async (key) => {
      deletedKeys.push(key);
      return baseStorage.delete(key);
    };

    await handleWaveformJob(sourceWaveformPayload(f, job.id), {
      db: f.database,
      storage: flakyStorage,
      generateWaveform: async () => validWaveformDocument(),
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });

    const [completed] = await f.database.select().from(waveformJobs).where(eq(waveformJobs.id, job.id));
    const assets = await f.database.select().from(waveformAssets).where(eq(waveformAssets.waveformJobId, job.id));
    assert.equal(attemptedKeys.length, 2);
    assert.notEqual(attemptedKeys[0], attemptedKeys[1], "each attempt owns a distinct temporary object key");
    assert.deepEqual(deletedKeys, [attemptedKeys[0]], "the object from the failed save attempt is removed");
    assert.equal(await baseStorage.exists(attemptedKeys[0]!), false);
    assert.equal(await baseStorage.exists(attemptedKeys[1]!), true);
    assert.deepEqual(delays, [WAVEFORM_RETRY_BACKOFF_MS[0]]);
    assert.equal(completed.status, "complete");
    assert.equal(completed.attempts, 2);
    assert.equal(assets.length, 1);
    assert.equal(assets[0]!.storageKey, attemptedKeys[1]);
  } finally {
    await f.close();
  }
});

test("waveform recovery resumes the persisted retry after a local worker restart", async () => {
  const f = await fixture();
  try {
    const job = await createSourceWaveformJob(f);
    let signalBackoffStarted!: () => void;
    const backoffStarted = new Promise<void>((resolve) => { signalBackoffStarted = resolve; });
    let stoppedDelay: number | null = null;
    const stoppedBroker = new LocalJobBroker();
    stoppedBroker.register("waveyard-waveform", (payload) => handleWaveformJob(payload, {
      db: f.database,
      generateWaveform: async () => {
        throw Object.assign(new Error("Temporary failure before restart"), { code: "EIO" });
      },
      sleep: async (milliseconds) => {
        stoppedDelay = milliseconds;
        signalBackoffStarted();
        // The old API process is stopped while its worker is in backoff.
        await new Promise<void>(() => {});
      },
    }));
    await stoppedBroker.submit(
      "waveyard-waveform",
      job.id,
      sourceWaveformPayload(f, job.id),
    );
    await backoffStarted;

    const [retrying] = await f.database.select().from(waveformJobs).where(eq(waveformJobs.id, job.id));
    assert.equal(stoppedDelay, WAVEFORM_RETRY_BACKOFF_MS[0]);
    assert.equal(retrying.status, "processing");
    assert.equal(retrying.stage, "retrying");
    assert.equal(retrying.attempts, 1, "the first failed attempt is persisted before backoff");

    const restartedBroker = new LocalJobBroker();
    restartedBroker.register("waveyard-waveform", (payload) => handleWaveformJob(payload, {
      db: f.database,
      generateWaveform: async () => validWaveformDocument(),
    }));
    const recovery = await recoverPendingLocalWaveformJobs(
      f.database,
      (payload) => restartedBroker.submit(
        "waveyard-waveform",
        payload.waveformJobId,
        payload as unknown as Record<string, unknown>,
      ),
    );
    assert.deepEqual(recovery.resetJobIds, [job.id]);
    assert.deepEqual(recovery.requeuedJobIds, [job.id]);
    assert.deepEqual(recovery.failedJobIds, []);
    assert.equal(await restartedBroker.drain(10_000), true);

    const [completed] = await f.database.select().from(waveformJobs).where(eq(waveformJobs.id, job.id));
    const assets = await f.database.select().from(waveformAssets).where(eq(waveformAssets.waveformJobId, job.id));
    assert.equal(completed.status, "complete");
    assert.equal(completed.attempts, 2, "recovery resumes at attempt two rather than resetting or exceeding the cap");
    assert.equal(assets.length, 1, "recovered work creates at most one waveform asset");
    assert.equal(await getStorage().exists(assets[0]!.storageKey), true);
    assert.equal(restartedBroker.stats().submitted, 1);
  } finally {
    await f.close();
  }
});

test("waveform recovery retries after its claim transaction loses the database connection", async () => {
  const f = await fixture();
  try {
    const job = await createSourceWaveformJob(f);
    let enqueueCalls = 0;
    const interruptedDatabase = new Proxy(f.database, {
      get(target, property) {
        if (property === "transaction") {
          return async (...args: Parameters<typeof target.transaction>) => target.transaction(async (tx) => {
            await args[0](tx);
            throw Object.assign(
              new Error("connection terminated during recovery queue handoff"),
              { code: "08006" },
            );
          });
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof f.database;

    await assert.rejects(
      recoverPendingLocalWaveformJobs(interruptedDatabase, async () => {
        enqueueCalls += 1;
      }),
      /connection terminated during recovery queue handoff/,
    );
    assert.equal(enqueueCalls, 0, "the queue is not called before the failed claim transaction commits");

    const [stillPending] = await f.database
      .select()
      .from(waveformJobs)
      .where(eq(waveformJobs.id, job.id));
    assert.equal(stillPending.status, "queued");
    assert.equal(stillPending.stage, "queued", "the interrupted transaction rolls its claim back");

    const restartedBroker = new LocalJobBroker();
    restartedBroker.register("waveyard-waveform", (payload) => handleWaveformJob(payload, {
      db: f.database,
      generateWaveform: async () => validWaveformDocument(),
    }));
    const recovery = await recoverPendingLocalWaveformJobs(
      f.database,
      (payload) => restartedBroker.submit(
        "waveyard-waveform",
        payload.waveformJobId,
        payload as unknown as Record<string, unknown>,
      ),
    );

    assert.deepEqual(recovery.requeuedJobIds, [job.id]);
    assert.deepEqual(recovery.failedJobIds, []);
    assert.equal(restartedBroker.stats().submitted, 1);
    assert.equal(await restartedBroker.drain(10_000), true);

    const [completed] = await f.database
      .select()
      .from(waveformJobs)
      .where(eq(waveformJobs.id, job.id));
    const assets = await f.database
      .select()
      .from(waveformAssets)
      .where(eq(waveformAssets.waveformJobId, job.id));
    assert.equal(completed.status, "complete");
    assert.equal(assets.length, 1, "the recovered waveform is saved exactly once");
    assert.equal(await getStorage().exists(assets[0]!.storageKey), true);
  } finally {
    await f.close();
  }
});

test("waveform recovery does not requeue a job completed after its pending read", async () => {
  const f = await fixture();
  try {
    const [completedDuringRecovery, stillPending] = await f.database
      .insert(waveformJobs)
      .values([
        {
          projectId: f.project.id,
          sourceAssetId: f.source.id,
          status: "processing",
          stage: "generating",
          idempotencyKey: `waveform:recovery-race-complete:${f.source.id}`,
        },
        {
          projectId: f.project.id,
          sourceAssetId: f.source.id,
          status: "processing",
          stage: "generating",
          idempotencyKey: `waveform:recovery-race-pending:${f.source.id}`,
        },
      ])
      .returning();

    let completionInjected = false;
    let completedSnapshot: typeof completedDuringRecovery | undefined;
    const raceDatabase = new Proxy(f.database as object, {
      get(target, property, receiver) {
        if (property !== "select") return Reflect.get(target, property, receiver);

        const select = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          const builder = Reflect.apply(select, target, args) as object;
          const wrapBuilder = (current: object, isWaveformSelect = false): object => new Proxy(current, {
            get(queryBuilder, method, queryReceiver) {
              const value = Reflect.get(queryBuilder, method, queryReceiver);
              if (method === "from" && typeof value === "function") {
                return (...fromArgs: unknown[]) => wrapBuilder(
                  Reflect.apply(value, queryBuilder, fromArgs) as object,
                  fromArgs[0] === waveformJobs,
                );
              }
              if (method === "where" && isWaveformSelect && typeof value === "function") {
                return (...whereArgs: unknown[]) => {
                  const query = Reflect.apply(value, queryBuilder, whereArgs) as {
                    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (error: unknown) => unknown) => unknown;
                  };
                  return {
                    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (error: unknown) => unknown) =>
                      query.then(async (rows) => {
                        if (!completionInjected) {
                          completionInjected = true;
                          [completedSnapshot] = await f.database
                            .update(waveformJobs)
                            .set({
                              status: "complete",
                              stage: "complete",
                              errorCode: "waveform_ready",
                              errorMessage: "Waveform finished before recovery claimed it.",
                              completedAt: new Date("2025-01-02T03:04:05.000Z"),
                              updatedAt: new Date("2025-01-02T03:04:05.000Z"),
                            })
                            .where(eq(waveformJobs.id, completedDuringRecovery.id))
                            .returning();
                        }
                        return onFulfilled(rows);
                      }, onRejected),
                  };
                };
              }
              return typeof value === "function" ? value.bind(queryBuilder) : value;
            },
          });
          return wrapBuilder(builder);
        };
      },
    }) as typeof f.database;

    const enqueued: string[] = [];
    const recovery = await recoverPendingLocalWaveformJobs(raceDatabase, async (payload) => {
      enqueued.push(payload.waveformJobId);
    });

    assert.ok(completionInjected, "the job completes after the initial pending read");
    assert.deepEqual(recovery.requeuedJobIds, [stillPending.id]);
    assert.deepEqual(recovery.enqueuedJobIds, [stillPending.id]);
    assert.deepEqual(enqueued, [stillPending.id], "the completed job is not submitted to the worker");
    assert.deepEqual(recovery.failedJobIds, []);

    const [completedAfterRecovery] = await f.database
      .select()
      .from(waveformJobs)
      .where(eq(waveformJobs.id, completedDuringRecovery.id));
    assert.deepEqual(completedAfterRecovery, completedSnapshot, "recovery leaves the terminal row unchanged");

    const [requeued] = await f.database
      .select()
      .from(waveformJobs)
      .where(eq(waveformJobs.id, stillPending.id));
    assert.equal(requeued.status, "queued");
    assert.match(requeued.stage, /^recovery-submitting:\d+:[0-9a-f-]+$/);
  } finally {
    await f.close();
  }
});

test("waveform recovery keeps a completed waveform when enqueue throws after worker completion", async () => {
  const f = await fixture();
  try {
    const job = await createSourceWaveformJob(f);
    const recovery = await recoverPendingLocalWaveformJobs(f.database, async (payload) => {
      await handleWaveformJob(payload as unknown as Record<string, unknown>, {
        db: f.database,
        generateWaveform: async () => validWaveformDocument(),
      });
      throw new Error("Queue acknowledgement failed after accepting the job");
    });

    const [completed] = await f.database
      .select()
      .from(waveformJobs)
      .where(eq(waveformJobs.id, job.id));
    const assets = await f.database
      .select()
      .from(waveformAssets)
      .where(eq(waveformAssets.waveformJobId, job.id));

    assert.deepEqual(recovery.requeuedJobIds, [job.id]);
    assert.deepEqual(recovery.failedJobIds, []);
    assert.equal(completed.status, "complete");
    assert.equal(completed.stage, "complete");
    assert.equal(assets.length, 1);
    assert.equal(await getStorage().exists(assets[0]!.storageKey), true);
  } finally {
    await f.close();
  }
});

test("waveform recovery records a genuine queue submission failure", async () => {
  const f = await fixture();
  try {
    const job = await createSourceWaveformJob(f);
    const recovery = await recoverPendingLocalWaveformJobs(f.database, async () => {
      throw new Error("Local waveform queue is unavailable");
    });

    const [failed] = await f.database
      .select()
      .from(waveformJobs)
      .where(eq(waveformJobs.id, job.id));
    assert.deepEqual(recovery.requeuedJobIds, []);
    assert.deepEqual(recovery.failedJobIds, [job.id]);
    assert.equal(failed.status, "failed");
    assert.equal(failed.stage, "queue-unavailable");
    assert.equal(failed.errorCode, "queue_unavailable");
    assert.match(failed.errorMessage ?? "", /Local waveform queue is unavailable/);
  } finally {
    await f.close();
  }
});

test("independent API processes submit a live waveform claim once and reclaim a stopped owner", async (t) => {
  const pg = await independentRecoveryPostgres(t);
  if (!pg) return;

  const children: ChildProcess[] = [];
  try {
    const [project] = await pg.database
      .insert(projects)
      .values({ ownerId: randomUUID(), title: "Independent waveform recovery" })
      .returning();
    const [source] = await pg.database
      .insert(sourceAssets)
      .values({
        projectId: project.id,
        originalFilename: "recovery-source.wav",
        mimeType: "audio/wav",
        storageKey: `projects/${project.id}/source/recovery-source.wav`,
        checksumSha256: "a".repeat(64),
        durationSeconds: 1,
        sampleRate: 44_100,
        channels: 2,
        codec: "pcm_s16le",
        fileSizeBytes: 176_400,
      })
      .returning();

    const [liveJob] = await pg.database
      .insert(waveformJobs)
      .values({
        projectId: project.id,
        sourceAssetId: source.id,
        status: "queued",
        stage: "queued",
        idempotencyKey: `waveform:independent-live:${source.id}`,
      })
      .returning();

    const firstApi = startRecoveryProcess(pg.connectionString, liveJob.id, "hold");
    children.push(firstApi);
    const firstSubmission = await waitForRecoveryMessage(firstApi, "submitted");
    const secondApi = startRecoveryProcess(pg.connectionString, liveJob.id, "complete");
    children.push(secondApi);
    const secondResult = await waitForRecoveryMessage(secondApi, "done");
    assert.deepEqual(
      (secondResult.recovery as { enqueuedJobIds: string[] }).enqueuedJobIds,
      [],
      "the second API instance leaves the live owner's claimed waveform alone",
    );
    await waitForRecoveryProcessExit(secondApi);

    firstApi.send({ type: "release" });
    const firstResult = await waitForRecoveryMessage(firstApi, "done");
    assert.deepEqual((firstResult.recovery as { enqueuedJobIds: string[] }).enqueuedJobIds, [liveJob.id]);
    await waitForRecoveryProcessExit(firstApi);
    assert.equal(firstSubmission.jobId, liveJob.id);
    const [liveCompleted] = await pg.database.select().from(waveformJobs).where(eq(waveformJobs.id, liveJob.id));
    assert.equal(liveCompleted.status, "complete");
    assert.equal(liveCompleted.stage, "complete");

    const [abandonedJob] = await pg.database
      .insert(waveformJobs)
      .values({
        projectId: project.id,
        sourceAssetId: source.id,
        status: "queued",
        stage: "queued",
        idempotencyKey: `waveform:independent-abandoned:${source.id}`,
      })
      .returning();
    const stoppedOwner = startRecoveryProcess(pg.connectionString, abandonedJob.id, "claim-only");
    children.push(stoppedOwner);
    const stoppedClaim = await waitForRecoveryMessage(stoppedOwner, "claimed");
    assert.match(String(stoppedClaim.stage), new RegExp(`^recovery-submitting:${stoppedClaim.pid}:`));
    const stoppedOwnerExit = new Promise<void>((resolve, reject) => {
      stoppedOwner.once("exit", (code, signal) => {
        if (code === null && signal === "SIGTERM") resolve();
        else reject(new Error(`Claim owner exited unexpectedly (code=${code}, signal=${signal}).`));
      });
    });
    stoppedOwner.kill("SIGTERM");
    await stoppedOwnerExit;

    const restartedApi = startRecoveryProcess(pg.connectionString, abandonedJob.id, "complete");
    children.push(restartedApi);
    const reclaimedSubmission = await waitForRecoveryMessage(restartedApi, "submitted");
    const reclaimedResult = await waitForRecoveryMessage(restartedApi, "done");
    assert.equal(reclaimedSubmission.jobId, abandonedJob.id);
    assert.deepEqual((reclaimedResult.recovery as { enqueuedJobIds: string[] }).enqueuedJobIds, [abandonedJob.id]);
    await waitForRecoveryProcessExit(restartedApi);

    const [reclaimedCompleted] = await pg.database
      .select()
      .from(waveformJobs)
      .where(eq(waveformJobs.id, abandonedJob.id));
    assert.equal(reclaimedCompleted.status, "complete");
    assert.equal(reclaimedCompleted.stage, "complete");
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        });
      }
    }
    await pg.close();
  }
});

test("waveform recovery reclaims a queue claim left by a stopped process", async () => {
  const f = await fixture();
  try {
    const [job] = await f.database
      .insert(waveformJobs)
      .values({
        projectId: f.project.id,
        sourceAssetId: f.source.id,
        status: "queued",
        stage: "recovery-submitting:999999999:abandoned-claim",
        idempotencyKey: `waveform:recovery-abandoned-claim:${f.source.id}`,
      })
      .returning();
    const dispatched: string[] = [];

    const recovery = await recoverPendingLocalWaveformJobs(f.database, async (payload) => {
      dispatched.push(payload.waveformJobId);
    });

    assert.deepEqual(recovery.requeuedJobIds, [job.id]);
    assert.deepEqual(recovery.failedJobIds, []);
    assert.deepEqual(dispatched, [job.id]);
  } finally {
    await f.close();
  }
});

test("overlapping waveform recovery calls submit each pending job only once", async () => {
  const f = await fixture();
  try {
    const firstJob = await createSourceWaveformJob(f);
    const [unrelatedJob] = await f.database
      .insert(waveformJobs)
      .values({
        projectId: f.project.id,
        sourceAssetId: f.source.id,
        status: "queued",
        stage: "queued",
        idempotencyKey: `waveform:recovery-overlap-unrelated:${f.source.id}`,
      })
      .returning();

    let signalFirstEnqueue!: () => void;
    const firstEnqueueStarted = new Promise<void>((resolve) => { signalFirstEnqueue = resolve; });
    let releaseFirstEnqueue!: () => void;
    const holdFirstEnqueue = new Promise<void>((resolve) => { releaseFirstEnqueue = resolve; });
    const enqueued: string[] = [];
    let enqueueCalls = 0;
    const enqueue = async (payload: { waveformJobId: string }) => {
      enqueued.push(payload.waveformJobId);
      enqueueCalls += 1;
      if (enqueueCalls === 1) {
        signalFirstEnqueue();
        await holdFirstEnqueue;
      }
    };

    const firstRecoveryPromise = recoverPendingLocalWaveformJobs(f.database, enqueue);
    await firstEnqueueStarted;
    const secondRecoveryPromise = recoverPendingLocalWaveformJobs(f.database, enqueue);
    // Let the second pass reach its conditional claim while the first still
    // holds the row lock through enqueue.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirstEnqueue();
    const [firstRecovery, secondRecovery] = await Promise.all([firstRecoveryPromise, secondRecoveryPromise]);

    assert.deepEqual(enqueued.sort(), [firstJob.id, unrelatedJob.id].sort());
    assert.equal(enqueued.length, 2, "each eligible waveform is submitted once across both recoveries");
    assert.equal(enqueued.filter((id) => id === firstJob.id).length, 1);
    assert.equal(enqueued.filter((id) => id === unrelatedJob.id).length, 1, "the unrelated job still recovers");
    assert.deepEqual(
      [...firstRecovery.enqueuedJobIds, ...secondRecovery.enqueuedJobIds].sort(),
      [firstJob.id, unrelatedJob.id].sort(),
    );
    assert.deepEqual(
      [...firstRecovery.failedJobIds, ...secondRecovery.failedJobIds],
      [],
    );
  } finally {
    await f.close();
  }
});

test("waveform recovery keeps the three-attempt limit and final error after a restart", async () => {
  const f = await fixture();
  try {
    const job = await createSourceWaveformJob(f);
    let signalBackoffStarted!: () => void;
    const backoffStarted = new Promise<void>((resolve) => { signalBackoffStarted = resolve; });
    const stoppedBroker = new LocalJobBroker();
    stoppedBroker.register("waveyard-waveform", (payload) => handleWaveformJob(payload, {
      db: f.database,
      generateWaveform: async () => {
        throw Object.assign(new Error("Temporary failure before restart"), { code: "EIO" });
      },
      sleep: async () => {
        signalBackoffStarted();
        await new Promise<void>(() => {});
      },
    }));
    await stoppedBroker.submit(
      "waveyard-waveform",
      job.id,
      sourceWaveformPayload(f, job.id),
    );
    await backoffStarted;

    const resumedDelays: number[] = [];
    let resumedAttempts = 0;
    const restartedBroker = new LocalJobBroker();
    restartedBroker.register("waveyard-waveform", (payload) => handleWaveformJob(payload, {
      db: f.database,
      generateWaveform: async () => {
        resumedAttempts += 1;
        throw Object.assign(new Error("Temporary failure after restart"), { code: "EIO" });
      },
      sleep: async (milliseconds) => { resumedDelays.push(milliseconds); },
    }));
    const recovery = await recoverPendingLocalWaveformJobs(
      f.database,
      (payload) => restartedBroker.submit(
        "waveyard-waveform",
        payload.waveformJobId,
        payload as unknown as Record<string, unknown>,
      ),
    );
    assert.deepEqual(recovery.requeuedJobIds, [job.id]);
    assert.equal(await restartedBroker.drain(10_000), true);

    const [failed] = await f.database.select().from(waveformJobs).where(eq(waveformJobs.id, job.id));
    const assets = await f.database.select().from(waveformAssets).where(eq(waveformAssets.waveformJobId, job.id));
    assert.equal(resumedAttempts, WAVEFORM_MAX_ATTEMPTS - 1, "only the two remaining attempts run after restart");
    assert.deepEqual(resumedDelays, [WAVEFORM_RETRY_BACKOFF_MS[1]]);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, WAVEFORM_MAX_ATTEMPTS);
    assert.equal(failed.errorCode, "waveform_retry_exhausted");
    assert.match(failed.errorMessage ?? "", /failed after 3 attempts: Temporary failure after restart/i);
    assert.equal(assets.length, 0);
  } finally {
    await f.close();
  }
});

test("waveform recovery preserves the remaining attempt budget across repeated worker restarts", async () => {
  const f = await fixture();
  try {
    const job = await createSourceWaveformJob(f);
    let firstBackoffStarted!: () => void;
    const firstBackoff = new Promise<void>((resolve) => { firstBackoffStarted = resolve; });
    const firstBroker = new LocalJobBroker();
    let generationCalls = 0;
    firstBroker.register("waveyard-waveform", (payload) => handleWaveformJob(payload, {
      db: f.database,
      generateWaveform: async () => {
        generationCalls += 1;
        throw Object.assign(new Error("Temporary failure on attempt one"), { code: "EIO" });
      },
      sleep: async () => {
        firstBackoffStarted();
        await new Promise<void>(() => {});
      },
    }));
    await firstBroker.submit(
      "waveyard-waveform",
      job.id,
      sourceWaveformPayload(f, job.id),
    );
    await firstBackoff;

    let secondBackoffStarted!: () => void;
    const secondBackoff = new Promise<void>((resolve) => { secondBackoffStarted = resolve; });
    const secondDelays: number[] = [];
    const secondBroker = new LocalJobBroker();
    secondBroker.register("waveyard-waveform", (payload) => handleWaveformJob(payload, {
      db: f.database,
      generateWaveform: async () => {
        generationCalls += 1;
        throw Object.assign(new Error("Temporary failure on attempt two"), { code: "EIO" });
      },
      sleep: async (milliseconds) => {
        secondDelays.push(milliseconds);
        secondBackoffStarted();
        await new Promise<void>(() => {});
      },
    }));
    const secondRecovery = await recoverPendingLocalWaveformJobs(
      f.database,
      (payload) => secondBroker.submit(
        "waveyard-waveform",
        payload.waveformJobId,
        payload as unknown as Record<string, unknown>,
      ),
    );
    assert.deepEqual(secondRecovery.requeuedJobIds, [job.id]);
    await secondBackoff;

    const [retryingAfterSecondAttempt] = await f.database
      .select()
      .from(waveformJobs)
      .where(eq(waveformJobs.id, job.id));
    assert.equal(retryingAfterSecondAttempt.stage, "retrying");
    assert.equal(retryingAfterSecondAttempt.attempts, 2, "the second worker records only its one attempt");
    assert.deepEqual(secondDelays, [WAVEFORM_RETRY_BACKOFF_MS[1]]);

    const thirdBroker = new LocalJobBroker();
    let thirdAttempts = 0;
    thirdBroker.register("waveyard-waveform", (payload) => handleWaveformJob(payload, {
      db: f.database,
      generateWaveform: async () => {
        generationCalls += 1;
        thirdAttempts += 1;
        throw Object.assign(new Error("Temporary failure on final attempt"), { code: "EIO" });
      },
    }));
    const thirdRecovery = await recoverPendingLocalWaveformJobs(
      f.database,
      (payload) => thirdBroker.submit(
        "waveyard-waveform",
        payload.waveformJobId,
        payload as unknown as Record<string, unknown>,
      ),
    );
    assert.deepEqual(thirdRecovery.requeuedJobIds, [job.id]);
    const [requeuedAfterSecondRestart] = await f.database
      .select()
      .from(waveformJobs)
      .where(eq(waveformJobs.id, job.id));
    assert.equal(requeuedAfterSecondRestart.attempts, 2, "the second restart does not reset or spend an attempt");
    assert.equal(await thirdBroker.drain(10_000), true);

    const [failed] = await f.database.select().from(waveformJobs).where(eq(waveformJobs.id, job.id));
    const assets = await f.database.select().from(waveformAssets).where(eq(waveformAssets.waveformJobId, job.id));
    assert.equal(generationCalls, WAVEFORM_MAX_ATTEMPTS);
    assert.equal(thirdAttempts, 1, "only the one remaining attempt runs after the second restart");
    assert.equal(failed.attempts, WAVEFORM_MAX_ATTEMPTS);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "waveform_retry_exhausted");
    assert.match(failed.errorMessage ?? "", /failed after 3 attempts: Temporary failure on final attempt/i);
    assert.equal(assets.length, 0);
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

test("waveform recovery stops immediately when the recovered audio has a permanent decode failure", async () => {
  const f = await fixture();
  try {
    const job = await createSourceWaveformJob(f);
    let firstBackoffStarted!: () => void;
    const firstBackoff = new Promise<void>((resolve) => { firstBackoffStarted = resolve; });
    const stoppedBroker = new LocalJobBroker();
    stoppedBroker.register("waveyard-waveform", (payload) => handleWaveformJob(payload, {
      db: f.database,
      generateWaveform: async () => {
        throw Object.assign(new Error("Temporary FFmpeg resource failure"), { code: "EAGAIN" });
      },
      sleep: async () => {
        firstBackoffStarted();
        await new Promise<void>(() => {});
      },
    }));
    await stoppedBroker.submit(
      "waveyard-waveform",
      job.id,
      sourceWaveformPayload(f, job.id),
    );
    await firstBackoff;

    let recoveredAttempts = 0;
    const recoveredDelays: number[] = [];
    const recoveredBroker = new LocalJobBroker();
    recoveredBroker.register("waveyard-waveform", (payload) => handleWaveformJob(payload, {
      db: f.database,
      generateWaveform: async () => {
        recoveredAttempts += 1;
        throw new Error("Invalid data found when processing input.");
      },
      sleep: async (milliseconds) => { recoveredDelays.push(milliseconds); },
    }));
    const recovery = await recoverPendingLocalWaveformJobs(
      f.database,
      (payload) => recoveredBroker.submit(
        "waveyard-waveform",
        payload.waveformJobId,
        payload as unknown as Record<string, unknown>,
      ),
    );
    assert.deepEqual(recovery.requeuedJobIds, [job.id]);
    assert.equal(await recoveredBroker.drain(10_000), true);

    const [failed] = await f.database.select().from(waveformJobs).where(eq(waveformJobs.id, job.id));
    const assets = await f.database.select().from(waveformAssets).where(eq(waveformAssets.waveformJobId, job.id));
    assert.equal(recoveredAttempts, 1, "only one attempt runs after recovery");
    assert.deepEqual(recoveredDelays, [], "a permanent decode error does not enter retry backoff");
    assert.equal(failed.status, "failed");
    assert.equal(failed.stage, "failed");
    assert.equal(failed.attempts, 2, "the first transient failure remains counted");
    assert.equal(failed.errorCode, "waveform_failed");
    assert.equal(failed.errorMessage, "Invalid data found when processing input.");
    assert.equal(assets.length, 0, "invalid audio does not create a waveform asset");
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

test("two-stem mode uses one model session to produce both outputs", async () => {
  const f = await fixture();
  try {
    const openedModels: string[] = [];
    let inferenceCalls = 0;
    let releasedSessions = 0;
    const openEngine = async (spec: MdxModelSpec): Promise<OpenedEngine> => {
      openedModels.push(spec.id);
      return {
        infer: (async (input: Float32Array) => {
          inferenceCalls += 1;
          return input;
        }) as MdxInfer,
        release: async () => {
          releasedSessions += 1;
        },
        resolvedDevice: "cpu",
      };
    };

    await handleSeparationJob(payloadOf(f), { db: f.database, openEngine });

    assert.deepEqual(openedModels, ["kim_vocal_2"], "one session is opened for the distinct model");
    assert.equal(inferenceCalls, 2, "the fixture's two model windows are each demixed once, not once per output stem");
    assert.equal(releasedSessions, 1, "the shared model session is released once");
    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    assert.deepEqual(
      stems.map((stem) => stem.stemType).sort(),
      ["instrumental", "vocals"],
      "the single demix result persists both requested outputs",
    );
  } finally {
    await f.close();
  }
});

test("queued separation can be stopped, preserve prior audio and stems, then restart from the same source", async () => {
  const f = await fixture();
  const broker = new LocalJobBroker();
  let releaseBlocker!: () => void;
  const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  let blockerStarted!: () => void;
  const started = new Promise<void>((resolve) => { blockerStarted = resolve; });
  let engineOpens = 0;

  try {
    const priorCompletedAt = new Date(Date.now() - 60_000);
    const [priorJob] = await f.database
      .insert(processingJobs)
      .values({
        projectId: f.project.id,
        sourceAssetId: f.source.id,
        type: "separation",
        model: f.job.model,
        requestedDevice: "auto",
        status: "complete",
        stage: "complete",
        idempotencyKey: `prior-complete:${f.source.id}`,
        createdAt: priorCompletedAt,
        updatedAt: priorCompletedAt,
        completedAt: priorCompletedAt,
      })
      .returning();
    const [priorStem] = await f.database
      .insert(stemAssets)
      .values({
        projectId: f.project.id,
        sourceAssetId: f.source.id,
        separationJobId: priorJob.id,
        stemType: "vocals",
        engine: "mdx",
        model: f.job.model,
        modelVersion: KIM.sha256,
        storageKey: f.source.storageKey,
        checksumSha256: f.source.checksumSha256,
        durationSeconds: f.source.durationSeconds,
        sampleRate: f.source.sampleRate,
        channels: f.source.channels,
        codec: f.source.codec,
        format: "wav",
        fileSizeBytes: f.source.fileSizeBytes,
      })
      .returning();
    const originalChecksum = await checksumFile(f.sourcePath);

    broker.register("test-blocker", async () => {
      blockerStarted();
      await blockerGate;
    });
    broker.registerCancellable(SEPARATION_QUEUE, async (payload, { signal }) => {
      await handleSeparationJob(payload, {
        db: f.database,
        signal,
        openEngine: async (spec) => {
          engineOpens += 1;
          return identityEngine()(spec);
        },
      });
    });
    await broker.submit("test-blocker", "blocker", {});
    await started;
    await broker.submit(SEPARATION_QUEUE, f.job.id, payloadOf(f));
    assert.equal(broker.isRunning(f.job.id), false, "the separation is queued behind the blocker");

    const stopped = await requestSeparationCancellation(f.database, f.job.id, broker, true);
    assert.equal(stopped.kind, "cancelled");
    assert.equal(stopped.job.status, "cancelled");
    releaseBlocker();
    assert.equal(await broker.drain(5_000), true);

    assert.equal(engineOpens, 0, "the queued handler observes cancellation before opening a model");
    const [cancelledAttempt] = await f.database
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, f.job.id));
    assert.equal(cancelledAttempt.status, "cancelled");
    assert.equal(cancelledAttempt.stage, "cancelled");
    const [retainedPriorStem] = await f.database
      .select()
      .from(stemAssets)
      .where(eq(stemAssets.id, priorStem.id));
    assert.ok(retainedPriorStem, "a previously usable stem remains referenced");
    assert.equal(await checksumFile(f.sourcePath), originalChecksum, "the original audio file is unchanged");

    const restart = await claimProcessingJob(f.database, {
      projectId: f.project.id,
      sourceAssetId: f.source.id,
      type: "separation",
      model: f.job.model,
      requestedDevice: "auto",
      idempotencyKey: f.job.idempotencyKey,
    });
    assert.equal(restart.created, true, "the cancelled attempt releases its active idempotency key");
    if (!restart.created) return;
    await broker.submit(
      SEPARATION_QUEUE,
      restart.job.id,
      payloadOf(f, { processingJobId: restart.job.id }),
    );
    assert.equal(await broker.drain(30_000), true);

    const [restartedAttempt] = await f.database
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, restart.job.id));
    assert.equal(restartedAttempt.status, "complete", "the fresh attempt completes using the saved source");
    assert.equal(await checksumFile(f.sourcePath), originalChecksum);
    const restartStems = await f.database
      .select()
      .from(stemAssets)
      .where(eq(stemAssets.separationJobId, restart.job.id));
    assert.equal(restartStems.length, 2, "the restarted attempt publishes a complete stem set");
    assert.ok(engineOpens > 0);
  } finally {
    releaseBlocker();
    await broker.drain(5_000);
    await f.close();
  }
});

test("separation progress writes complete in order before the job finalizes", async () => {
  const f = await fixture();
  const progressWriteOrder: number[] = [];
  await f.database
    .update(processingJobs)
    .set({ metadata: JSON.stringify({ progress: { done: 2, total: 2, percent: 100, phase: "1/1" } }) })
    .where(eq(processingJobs.id, f.job.id));
  let staleProgressCleared = false;
  try {
    const delayedDatabase = new Proxy(f.database as object, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== "update" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (table: unknown) => {
          const builder = Reflect.apply(value, target, [table]) as {
            set: (patch: unknown) => { where: (...args: unknown[]) => unknown };
          };
          return {
            set(patch: unknown) {
              const query = builder.set(patch);
              const patchValue = patch as { metadata?: unknown; stage?: unknown } | null;
              const metadata = patchValue?.metadata;
              if (table === processingJobs && patchValue?.stage === "preparing" && typeof metadata === "string") {
                staleProgressCleared = (JSON.parse(metadata) as { progress?: unknown }).progress === null;
              }
              const progress =
                table === processingJobs && typeof metadata === "string"
                  ? (JSON.parse(metadata) as { progress?: { percent?: number } }).progress
                  : undefined;
              if (progress?.percent === undefined) return query;
              return {
                where: async (...whereArgs: unknown[]) => {
                  if (progress.percent < 100) {
                    await new Promise((resolve) => setTimeout(resolve, 80));
                  }
                  const result = await query.where(...whereArgs);
                  progressWriteOrder.push(progress.percent!);
                  return result;
                },
              };
            },
          };
        };
      },
    }) as typeof f.database;

    await handleSeparationJob(payloadOf(f), {
      db: delayedDatabase,
      openEngine: identityEngine(),
    });

    assert.deepEqual(progressWriteOrder, [0, 50, 100], "pass-start and chunk progress must stay ordered");
    assert.equal(staleProgressCleared, true, "a retry must clear old progress before starting new inference");
    const [completed] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(completed.status, "complete");
  } finally {
    await f.close();
  }
});

test("multi-model progress reports the active pass before opening its engine", async () => {
  const f = await fixture({ model: "stems_4" });
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let signalFirst!: (modelId: string) => void;
  let signalSecond!: (modelId: string) => void;
  const firstOpened = new Promise<string>((resolve) => { signalFirst = resolve; });
  const secondOpened = new Promise<string>((resolve) => { signalSecond = resolve; });
  const fakeEngine = identityEngine();
  let openCount = 0;
  let job: Promise<void> | undefined;

  try {
    job = handleSeparationJob(payloadOf(f), {
      db: f.database,
      openEngine: async (spec) => {
        const index = openCount++;
        if (index === 0) {
          signalFirst(spec.id);
          await firstGate;
        } else if (index === 1) {
          signalSecond(spec.id);
          await secondGate;
        }
        return fakeEngine(spec);
      },
    });

    assert.equal(await firstOpened, "kim_vocal_2");
    const [firstRow] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    const firstProgress = (JSON.parse(firstRow!.metadata!) as { progress: Record<string, unknown> }).progress;
    assert.deepEqual(firstProgress, {
      done: 0,
      total: 4,
      percent: 0,
      phase: "1/4",
      model: "kim_vocal_2",
      kind: "model-pass",
    });

    releaseFirst();
    assert.equal(await secondOpened, "kuielab_b_drums");
    const [secondRow] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    const secondProgress = (JSON.parse(secondRow!.metadata!) as { progress: Record<string, unknown> }).progress;
    assert.deepEqual(secondProgress, {
      done: 1,
      total: 4,
      percent: 25,
      phase: "2/4",
      model: "kuielab_b_drums",
      kind: "model-pass",
    });

    releaseSecond();
    await job;
  } finally {
    releaseFirst();
    releaseSecond();
    await job?.catch(() => undefined);
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

test("a lost separation commit acknowledgement preserves the committed stem set", async () => {
  const f = await fixture();
  const storage = getStorage();
  const putFile = storage.putFile;
  const uploadedKeys: string[] = [];
  const db = new Proxy(f.database, {
    get(target, key) {
      if (key === "transaction") {
        return async (...args: Parameters<typeof target.transaction>) => {
          await target.transaction(...args);
          throw new Error("controlled lost separation commit acknowledgement");
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  try {
    storage.putFile = async (...args) => {
      uploadedKeys.push(args[0]);
      await putFile.apply(storage, args);
    };

    await handleSeparationJob(payloadOf(f), { db, openEngine: identityEngine() });

    const [job] = await f.database
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, f.job.id));
    const stems = await f.database
      .select()
      .from(stemAssets)
      .where(eq(stemAssets.separationJobId, f.job.id));
    assert.equal(job.status, "complete");
    assert.equal(stems.length, 2);
    assert.equal(uploadedKeys.length, stems.length);
    for (const stem of stems) {
      assert.ok(uploadedKeys.includes(stem.storageKey));
      assert.equal(await storage.exists(stem.storageKey), true);
    }
  } finally {
    storage.putFile = putFile;
    await f.close();
  }
});

test("unknown separation publication status retains outputs and records reconciliation keys", async () => {
  const f = await fixture();
  const storage = getStorage();
  const putFile = storage.putFile;
  const uploadedKeys: string[] = [];
  let transactionAttempted = false;
  const db = new Proxy(f.database, {
    get(target, key) {
      if (key === "transaction") {
        return async () => {
          transactionAttempted = true;
          throw new Error("controlled commit status unavailable");
        };
      }
      if (key === "select") {
        return (...args: Parameters<typeof target.select>) => {
          if (transactionAttempted) throw new Error("controlled publication lookup outage");
          return target.select(...args);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  try {
    storage.putFile = async (...args) => {
      uploadedKeys.push(args[0]);
      await putFile.apply(storage, args);
    };

    await assert.rejects(
      handleSeparationJob(payloadOf(f), { db, openEngine: identityEngine() }),
      /controlled commit status unavailable/,
    );

    const [job] = await f.database
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, f.job.id));
    assert.equal(job.status, "failed");
    assert.deepEqual(JSON.parse(job.metadata).cleanupFailedKeys, uploadedKeys);
    assert.equal(uploadedKeys.length, 2);
    for (const key of uploadedKeys) assert.equal(await storage.exists(key), true);
    assert.equal(
      (await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id))).length,
      0,
    );
  } finally {
    storage.putFile = putFile;
    await f.close();
  }
});

test("a storage write that rejects after writing is tracked and removed when unpublished", async () => {
  const f = await fixture();
  const storage = getStorage();
  const putFile = storage.putFile;
  const uploadedKeys: string[] = [];

  try {
    storage.putFile = async (...args) => {
      uploadedKeys.push(args[0]);
      await putFile.apply(storage, args);
      throw new Error("controlled failure after writing stem object");
    };

    await assert.rejects(
      handleSeparationJob(payloadOf(f), { db: f.database, openEngine: identityEngine() }),
      /failure after writing stem object/,
    );

    assert.equal(uploadedKeys.length, 1);
    assert.equal(await storage.exists(uploadedKeys[0]!), false);
    assert.equal(
      (await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id))).length,
      0,
    );
    assert.equal(await storage.exists(f.source.storageKey), true);
  } finally {
    storage.putFile = putFile;
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
