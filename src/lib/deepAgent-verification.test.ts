import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../../desktop/runtime/migrate";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deepAgentRuns } from "@/db/schema";
import type { db } from "@/db";
import type { generate } from "./ai";
import { getRun, parseVerdict, runDeepAgent } from "./deepAgent";

test("review parser never invents PASS for unknown, quoted or malformed evidence", () => {
  for (const text of ["", "I could not verify this", "The instruction said PASS or FAIL", "not PASS", '"PASS"']) {
    assert.equal(parseVerdict(text).verdict, "fail", text);
  }
  assert.equal(parseVerdict("PASS — draft meets its requirements").verdict, "pass");
  assert.equal(parseVerdict("FAIL: output is empty").verdict, "fail");
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const client = new PGlite();
  // Real production migration + real persisted SQL rows, no mock store.
  t.after(() => client.close());
  await applyMigrations({ client: client as unknown as import("pg").Client, migrationsDir: fileURLToPath(new URL("../../desktop-migrations", import.meta.url)) });
  return drizzle(client) as unknown as typeof db;
}
function scripted(replies: Array<string | Error>, fallback = false): typeof generate {
  return async () => {
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    assert.notEqual(reply, undefined, "unexpected downstream generation call");
    return { text: reply!, modelId: "test-model", runtimeLevel: "remote", backend: "groq", via: "controlled-test", ms: 1, fallback };
  };
}
const plan = '["Inspect the source", "Summarise the finding"]';

test("failed review retries once, persists failure and never executes a dependent step", async (t) => {
  const database = await fixture(t);
  const replies = [plan, "first draft", "FAIL: unsupported conclusion", "a longer retry draft", "no usable verdict"];
  const run = await runDeepAgent("inspect the defect", { steps: 2 }, { database, generate: scripted(replies) });
  assert.equal(run.status, "failed");
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].verdict, "fail");
  assert.equal(run.steps[0].attempts, 2);
  assert.equal(run.engine, "groq");
  const reopened = await getRun(run.id, database);
  assert.deepEqual(reopened, run);
  assert.equal(replies.length, 0);
});

test("successful review chain persists only accepted drafts as completed steps", async (t) => {
  const database = await fixture(t);
  const replies = [plan, "finding with source", "PASS: draft has source", "summary of finding", "PASS: complete draft"];
  const run = await runDeepAgent("inspect the defect", { steps: 2 }, { database, generate: scripted(replies) });
  assert.equal(run.status, "done");
  assert.equal(run.steps.length, 2);
  assert.ok(run.steps.every((step) => step.verdict === "pass"));
  assert.equal((await getRun(run.id, database))?.status, "done");
});

test("fallback review is not evidence even when it says PASS", async (t) => {
  const database = await fixture(t);
  const replies = [plan, "draft", "PASS", "retry draft", "PASS"];
  const run = await runDeepAgent("inspect the defect", { steps: 2 }, { database, generate: scripted(replies, true) });
  assert.equal(run.status, "failed");
  assert.match(run.steps[0].verdictReason, /model is unavailable/);
});

test("provider failure cannot strand a durable run in running state", async (t) => {
  const database = await fixture(t);
  await assert.rejects(runDeepAgent("inspect the defect", { steps: 2 }, {
    database, generate: scripted([plan, new Error("provider unavailable")]),
  }), /provider unavailable/);
  const [run] = await database.select().from(deepAgentRuns);
  assert.equal(run.status, "failed");
});
