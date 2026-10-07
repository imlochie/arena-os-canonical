/**
 * fs-cleanup tests — the Windows-safe removal contract:
 * transient lock errors (EBUSY/EPERM/ENOTEMPTY) are retried with backoff and
 * then succeed; permanent errors are rethrown immediately; exhausting the
 * retries rethrows the last error. The rm/sleep seams make this deterministic
 * on any platform.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { removeDirWithRetry } from "./fs-cleanup";

test("removes a real nested directory tree", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "arena-fscleanup-"));
  await mkdir(path.join(dir, "data", "postgres"), { recursive: true });
  await writeFile(path.join(dir, "data", "postgres", "PG_VERSION"), "16\n");
  await removeDirWithRetry(dir);
  assert.equal(existsSync(dir), false, "directory is fully removed");
});

test("retries transient EBUSY and succeeds once the lock clears", async () => {
  let calls = 0;
  const rmImpl = async () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error("resource busy") as NodeJS.ErrnoException;
      error.code = "EBUSY";
      throw error;
    }
  };
  const sleeps: number[] = [];
  await removeDirWithRetry("C:\\fake\\cluster", {
    rmImpl: rmImpl as never,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 500], "backoff grows linearly");
});

test("permanent errors are rethrown immediately (no retry loop)", async () => {
  let calls = 0;
  const rmImpl = async () => {
    calls += 1;
    const error = new Error("no such file or directory") as NodeJS.ErrnoException;
    error.code = "ENOENT"; // force:true never yields this, but proves the point
    throw error;
  };
  await assert.rejects(
    () => removeDirWithRetry("/gone", { rmImpl: rmImpl as never, sleepImpl: async () => {} }),
    (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT",
  );
  assert.equal(calls, 1, "non-transient codes must not be retried");
});

test("exhausted retries rethrow the last transient error", async () => {
  const rmImpl = async () => {
    const error = new Error("directory not empty") as NodeJS.ErrnoException;
    error.code = "ENOTEMPTY";
    throw error;
  };
  await assert.rejects(
    () =>
      removeDirWithRetry("/locked", {
        attempts: 3,
        rmImpl: rmImpl as never,
        sleepImpl: async () => {},
      }),
    (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOTEMPTY",
  );
});

test("missing directory is a no-op (force semantics preserved)", async () => {
  await removeDirWithRetry(path.join(tmpdir(), "arena-fscleanup-does-not-exist"), {
    sleepImpl: async () => {},
  });
});
