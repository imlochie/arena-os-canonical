import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArenaLogger, redact } from "./log";

test("redact masks secret-looking keys at any depth", () => {
  const out = redact({
    apiKey: "sk-123",
    name: "arena",
    nested: { AUTHORIZATION: "Bearer x", token: "t", keep: "me" },
    password: "hunter2",
  });
  assert.deepEqual(out, {
    apiKey: "[redacted]",
    name: "arena",
    nested: { AUTHORIZATION: "[redacted]", token: "[redacted]", keep: "me" },
    password: "[redacted]",
  });
});

test("logger appends JSONL, redacts secrets, keeps a ring buffer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arena-log-"));
  const lines: string[] = [];
  const logger = new ArenaLogger({
    dir,
    file: "test.log",
    write: async (_file, line) => {
      lines.push(line);
    },
    now: () => "2026-10-07T00:00:00.000Z",
  });
  await logger.init();
  await logger.info("test", "hello", { apiKey: "secret-value" });
  await logger.warn("test", "careful");

  const entries = lines.map((line) => JSON.parse(line));
  assert.ok(entries.every((e) => e.ts === "2026-10-07T00:00:00.000Z"));
  assert.equal(entries[0].scope, "log");
  assert.equal(entries[1].fields.apiKey, "[redacted]");
  assert.equal(entries[2].level, "warn");
  assert.equal(logger.recent().length, 3);
});

test("ring buffer is bounded", async () => {
  const logger = new ArenaLogger({
    dir: ".",
    maxRing: 2,
    write: async () => {},
    now: () => "2026-10-07T00:00:00.000Z",
  });
  await logger.init(); // counts toward the ring
  await logger.info("t", "one");
  await logger.info("t", "two");
  assert.equal(logger.recent().length, 2);
  assert.equal(logger.recent()[1].msg, "two");
});
