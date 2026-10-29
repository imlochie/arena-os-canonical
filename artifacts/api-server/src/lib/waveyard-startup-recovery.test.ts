import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  isTransientDatabaseConnectionFailure,
  runWaveyardStartupRecovery,
  waitForServerListening,
} from "./waveyard-startup-recovery";

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
