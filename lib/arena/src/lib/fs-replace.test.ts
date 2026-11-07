/**
 * `replaceFile` — the Windows-safe atomic replace contract.
 *
 * Deterministic on every platform: the rename and sleep seams inject the exact
 * error codes Windows produces when the destination is momentarily open, so
 * the retry policy is proven without needing Windows to misbehave on demand.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { replaceFile } from "./fs-replace";

const coded = (code: string) => Object.assign(new Error(`${code}: sharing violation`), { code });

test("replaces a real existing file with real bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "arena-replace-"));
  const target = path.join(dir, "status.json");
  const temp = `${target}.tmp`;
  await writeFile(target, '{"state":"running"}', "utf8");
  await writeFile(temp, '{"state":"ready"}', "utf8");
  await replaceFile(temp, target);
  assert.equal(await readFile(target, "utf8"), '{"state":"ready"}');
  assert.equal(existsSync(temp), false, "the temp file is consumed by the replace");
});

test("retries EPERM, EACCES and EBUSY, then succeeds once the handle clears", async () => {
  let calls = 0;
  const codes = ["EPERM", "EACCES", "EBUSY"];
  const sleeps: number[] = [];
  await replaceFile("C:\\fake\\status.json.tmp", "C:\\fake\\status.json", {
    renameImpl: async () => {
      const attempt = calls;
      calls += 1;
      if (attempt < codes.length) throw coded(codes[attempt]);
    },
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(sleeps, [25, 50, 75], "backoff grows linearly and stops when the rename succeeds");
});

test("a non-transient error is rethrown immediately, with no retry", async () => {
  let calls = 0;
  await assert.rejects(
    replaceFile("a", "b", {
      renameImpl: async () => {
        calls += 1;
        throw coded("ENOENT");
      },
    }),
    { code: "ENOENT" },
  );
  assert.equal(calls, 1, "a missing source is a real error, not a sharing violation");
});

test("exhausting the attempts rethrows the last sharing violation unchanged", async () => {
  let calls = 0;
  await assert.rejects(
    replaceFile("a", "b", {
      attempts: 3,
      renameImpl: async () => {
        calls += 1;
        throw coded("EPERM");
      },
      sleepImpl: async () => {},
    }),
    { code: "EPERM" },
  );
  assert.equal(calls, 3, "the retry is bounded, not infinite");
});
