import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeDirWithRetry } from "./fs-cleanup.mjs";

test("removes a real nested directory tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-fs-cleanup-"));
  const target = path.join(root, "stage");
  await mkdir(path.join(target, "browser"), { recursive: true });
  await writeFile(path.join(target, "browser", "chrome.exe"), "staged");
  try {
    await removeDirWithRetry(target);
    assert.equal(existsSync(target), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retries transient Windows lock errors with increasing delays", async () => {
  let calls = 0;
  const sleeps = [];
  await removeDirWithRetry("C:\\arena\\stage", {
    rmImpl: async (_target, _options) => {
      calls += 1;
      if (calls < 3) {
        const error = new Error("file is temporarily locked");
        error.code = "EBUSY";
        throw error;
      }
    },
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 500]);
});

test("permanent errors fail immediately", async () => {
  let calls = 0;
  const permanentError = Object.assign(new Error("permission denied permanently"), { code: "EROFS" });
  await assert.rejects(
    removeDirWithRetry("C:\\arena\\stage", {
      rmImpl: async () => {
        calls += 1;
        throw permanentError;
      },
      sleepImpl: async () => {},
    }),
    (error) => error === permanentError,
  );
  assert.equal(calls, 1);
});

test("exhausted lock retries rethrow the last error", async () => {
  let calls = 0;
  const lastError = Object.assign(new Error("still locked"), { code: "EPERM" });
  await assert.rejects(
    removeDirWithRetry("C:\\arena\\dist", {
      attempts: 3,
      rmImpl: async () => {
        calls += 1;
        throw lastError;
      },
      sleepImpl: async () => {},
    }),
    (error) => error === lastError,
  );
  assert.equal(calls, 3);
});

test("a missing directory remains a no-op", async () => {
  await removeDirWithRetry(path.join(os.tmpdir(), `arena-missing-${process.pid}`), {
    sleepImpl: async () => {},
  });
});
