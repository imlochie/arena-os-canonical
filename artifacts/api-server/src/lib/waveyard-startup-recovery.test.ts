import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupAbandonedAudioRestoreUploadDirectories } from "@workspace/arena/lib/waveyard/worker-local";
import {
  AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX,
  AUDIO_RESTORE_UPLOAD_RETENTION_MS,
} from "@workspace/arena/lib/waveyard/library/audio-restore";
import {
  resolveProcessingMode,
  type ProcessingMode,
  type RuntimePolicyEnv,
} from "@workspace/arena/lib/waveyard/worker-local/runtime-policy";
import app from "../app";
import {
  isTransientDatabaseConnectionFailure,
  runWaveyardStartupRecovery,
  startApiServerAfterBestEffortRestoreUploadCleanup,
  waitForServerListening,
} from "./waveyard-startup-recovery";

const apiStartupModes: Array<{
  name: string;
  env: RuntimePolicyEnv;
  expected: ProcessingMode;
}> = [
  {
    name: "local worker enabled",
    env: { NODE_ENV: "production", WAVEYARD_LOCAL_WORKER: "1" },
    expected: "in-process",
  },
  {
    name: "external worker configured",
    env: { NODE_ENV: "production", REDIS_URL: "redis://worker.invalid" },
    expected: "external",
  },
  {
    name: "no worker configured",
    env: { NODE_ENV: "production", WAVEYARD_LOCAL_WORKER: "0" },
    expected: "none",
  },
];

for (const mode of apiStartupModes) {
  test(`API startup cleans expired restore uploads before listening (${mode.name})`, { timeout: 15_000 }, async (context) => {
    assert.equal(resolveProcessingMode(mode.env), mode.expected);
    const root = await mkdtemp(join(tmpdir(), "waveyard-restore-startup-mode-test-"));
    const expiredUpload = `${AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX}999999999-expired`;
    const recentUpload = `${AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX}999999999-recent`;
    const activeUpload = `${AUDIO_RESTORE_UPLOAD_DIRECTORY_PREFIX}${process.pid}-active`;
    const oldTimestamp = new Date(Date.now() - AUDIO_RESTORE_UPLOAD_RETENTION_MS - 1_000);
    const events: string[] = [];
    const cleanupWarnings: unknown[] = [];
    const cleanupSuccessLogs: number[] = [];
    let server: ReturnType<typeof app.listen> | undefined;
    let startupPromise: Promise<ReturnType<typeof app.listen>> | undefined;
    let releaseCleanup!: () => void;
    let signalCleanupStarted!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const cleanupStarted = new Promise<void>((resolve) => { signalCleanupStarted = resolve; });

    context.after(async () => {
      releaseCleanup();
      await startupPromise?.catch(() => undefined);
      if (server && !server.listening) {
        await waitForServerListening(server).catch(() => undefined);
      }
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server!.close((error) => error ? reject(error) : resolve());
        });
      }
      await rm(root, { recursive: true, force: true });
    });

    const createUpload = async (name: string, modifiedAt?: Date) => {
      const directory = join(root, name);
      await mkdir(directory);
      await writeFile(join(directory, "payload.zip"), name);
      if (modifiedAt) await utimes(directory, modifiedAt, modifiedAt);
    };
    await createUpload(expiredUpload, oldTimestamp);
    await createUpload(recentUpload);
    await createUpload(activeUpload, oldTimestamp);

    startupPromise = startApiServerAfterBestEffortRestoreUploadCleanup(
      async () => {
        events.push("cleanup:start");
        signalCleanupStarted();
        await cleanupGate;
        const removed = await cleanupAbandonedAudioRestoreUploadDirectories(root);
        events.push("cleanup:attempt-finished");
        return removed;
      },
      () => {
        events.push("listen");
        server = app.listen(0, "127.0.0.1");
        return server;
      },
      {
        onCleanupComplete: (count) => {
          cleanupSuccessLogs.push(count);
          events.push(`cleanup:logged:${count}`);
        },
        onCleanupFailure: (error) => cleanupWarnings.push(error),
      },
    );

    await cleanupStarted;
    assert.deepEqual(events, ["cleanup:start"]);
    assert.equal(server, undefined, "the API must not listen while restore-upload cleanup is pending");

    releaseCleanup();
    const startedServer = await startupPromise;
    await waitForServerListening(startedServer);
    assert.equal(startedServer, server);
    assert.equal(server?.listening, true);
    assert.deepEqual(events, [
      "cleanup:start",
      "cleanup:attempt-finished",
      "cleanup:logged:1",
      "listen",
    ], "cleanup must finish before the server listener is created");
    assert.deepEqual(cleanupSuccessLogs, [1]);
    assert.deepEqual(cleanupWarnings, []);
    await assert.rejects(() => readFile(join(root, expiredUpload, "payload.zip")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, recentUpload, "payload.zip"), "utf8"), recentUpload,
      "recent restore uploads must remain available");
    assert.equal(await readFile(join(root, activeUpload, "payload.zip"), "utf8"), activeUpload,
      "an old upload owned by the current process must remain available");

    const address = server!.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
}

test("API starts serving health requests after restore-upload cleanup hits an I/O failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "waveyard-restore-startup-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const cleanupRootFile = join(root, "not-a-directory");
  const unrelatedTempPath = join(root, "unrelated-audio-cache.tmp");
  await writeFile(cleanupRootFile, "the cleanup root is intentionally invalid");
  await writeFile(unrelatedTempPath, "keep this file");

  const cleanupWarnings: unknown[] = [];
  let cleanupSuccessLogs = 0;
  const server = await startApiServerAfterBestEffortRestoreUploadCleanup(
    () => cleanupAbandonedAudioRestoreUploadDirectories(cleanupRootFile),
    () => app.listen(0, "127.0.0.1"),
    {
      onCleanupComplete: () => { cleanupSuccessLogs += 1; },
      onCleanupFailure: (error) => cleanupWarnings.push(error),
    },
  );
  context.after(async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  await waitForServerListening(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(cleanupWarnings.length, 1, "the cleanup I/O failure is logged");
  assert.equal((cleanupWarnings[0] as NodeJS.ErrnoException).code, "ENOTDIR");
  assert.equal(cleanupSuccessLogs, 0);
  assert.equal(await readFile(unrelatedTempPath, "utf8"), "keep this file",
    "a cleanup failure must not remove unrelated temporary paths");
  assert.equal(await readFile(cleanupRootFile, "utf8"), "the cleanup root is intentionally invalid");
});

test("background Waveyard maintenance can wait for the server listening event", async (context) => {
  const server = createServer();
  context.after(async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  const ready = waitForServerListening(server);
  assert.equal(server.listening, false);
  server.listen(0, "127.0.0.1");
  await ready;
  assert.equal(server.listening, true);
  await waitForServerListening(server);
});

test("Waveyard startup recovery retries a wrapped connection interruption and succeeds", async () => {
  const delays: number[] = [];
  const retryAttempts: number[] = [];
  let attempts = 0;

  const result = await runWaveyardStartupRecovery(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Recovery query failed", {
          cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        });
      }
      return "recovered";
    },
    {
      retryDelaysMs: [20, 40],
      sleep: async (delay) => { delays.push(delay); },
      onRetry: (_error, nextAttempt) => retryAttempts.push(nextAttempt),
    },
  );

  assert.equal(result, "recovered");
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [20]);
  assert.deepEqual(retryAttempts, [2]);
});

test("Waveyard startup recovery fails fast for permanent schema errors", async () => {
  const schemaError = Object.assign(new Error("relation does not exist"), { code: "42P01" });
  let attempts = 0;
  const delays: number[] = [];

  await assert.rejects(
    () => runWaveyardStartupRecovery(
      async () => {
        attempts += 1;
        throw schemaError;
      },
      {
        retryDelaysMs: [20, 40],
        sleep: async (delay) => { delays.push(delay); },
      },
    ),
    (error) => error === schemaError,
  );

  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
  assert.equal(isTransientDatabaseConnectionFailure(schemaError), false);
});

test("Waveyard startup recovery surfaces the last connection error after bounded retries", async () => {
  const lastError = Object.assign(new Error("database is starting up"), { code: "57P03" });
  const delays: number[] = [];
  let attempts = 0;

  await assert.rejects(
    () => runWaveyardStartupRecovery(
      async () => {
        attempts += 1;
        throw lastError;
      },
      {
        retryDelaysMs: [20, 40],
        sleep: async (delay) => { delays.push(delay); },
      },
    ),
    (error) => error === lastError,
  );

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [20, 40]);
  assert.equal(isTransientDatabaseConnectionFailure(lastError), true);
});
