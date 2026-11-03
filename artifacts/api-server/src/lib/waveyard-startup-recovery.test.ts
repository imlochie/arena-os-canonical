import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupAbandonedAudioRestoreUploadDirectories } from "@workspace/arena/lib/waveyard/worker-local";
import app from "../app";
import {
  isTransientDatabaseConnectionFailure,
  runWaveyardStartupRecovery,
  startApiServerAfterBestEffortRestoreUploadCleanup,
  waitForServerListening,
} from "./waveyard-startup-recovery";

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
