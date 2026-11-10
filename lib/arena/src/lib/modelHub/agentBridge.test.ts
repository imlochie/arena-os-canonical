import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { applyDesktopMigrationsToPGlite } from "../waveyard/worker-local/pglite-migrations.test-helper";

// Agent-bridge tests use an isolated copy of the packaged PostgreSQL schema;
// they do not depend on whichever database happens to answer on localhost.
process.env.DATABASE_URL ??= "postgres://arena:arena@127.0.0.1:1/agent_bridge_test";

async function fixture() {
  const client = new PGlite();
  const arenaRoot = fileURLToPath(new URL("../../../", import.meta.url));
  await applyDesktopMigrationsToPGlite(client, join(arenaRoot, "desktop-migrations"));
  const schema = await import("@workspace/db/schema");
  const bridge = await import("./agentBridge");
  const database = drizzle(client, { schema }) as unknown as NonNullable<Parameters<typeof bridge.takeNextTask>[0]>;
  return {
    client,
    database,
    agentBridgeState: schema.agentBridgeState,
    agentBridgeTasks: schema.agentBridgeTasks,
    ...bridge,
  };
}

// Real queue round-trip: durable DB-backed handoff between the app and the
// bridge process. No inference is faked — tasks are completed with literal
// strings, which is exactly what the bridge contract promises.
test("agent bridge: fast-fail when no bridge is polling", async (t) => {
  const f = await fixture();
  t.after(() => f.client.close());
  const { database, agentBridgeState, submitAgentTask } = f;

  // Ensure no heartbeat within the staleness window.
  await database.delete(agentBridgeState);
  const result = await submitAgentTask([{ role: "user", content: "say hi" }], "arena-agent", 200, database);
  assert.equal(result, null, "submitAgentTask must fast-fail when no bridge is alive");
});

test("agent bridge: full round-trip through the durable DB queue", async (t) => {
  const f = await fixture();
  t.after(() => f.client.close());
  const { database, agentBridgeState, bridgeStatus, completeTask, submitAgentTask, takeNextTask, touchBridge } = f;

  await database.delete(agentBridgeState);
  await touchBridge("test-bridge", database);

  const status = await bridgeStatus(database);
  assert.equal(status.connected, true);
  assert.equal(status.name, "test-bridge");

  // Bridge polls for work and answers out-of-band while the app waits.
  const answer = (async () => {
    for (let i = 0; i < 200; i++) {
      const task = await takeNextTask(database);
      if (task) {
        assert.ok(task.id.length > 8);
        assert.equal(Array.isArray(task.messages), true);
        assert.equal(task.messages.at(-1)?.content, "what are you?");
        await completeTask(task.id, "literal bridge answer", true, database);
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("bridge never received the task");
  })();

  const result = await submitAgentTask([{ role: "user", content: "what are you?" }], "arena-agent", 8000, database);
  await answer;

  assert.equal(result, "literal bridge answer", "task should complete within the wait window");

  // The task must be gone from the queue after completion.
  const next = await takeNextTask(database);
  assert.equal(next, null);

  // touchBridge upserts rather than erroring on a second beat.
  await touchBridge("test-bridge", database);
  const after = await bridgeStatus(database);
  assert.equal(after.connected, true);

});

test("agent bridge: completing an unknown task is a safe no-op", async (t) => {
  const f = await fixture();
  t.after(() => f.client.close());

  const done = await f.completeTask("00000000-0000-0000-0000-000000000000", "x", false, f.database);
  assert.equal(done, false);
});

test("agent bridge: desktop restart expires queued and taken tasks without deleting their records", async (t) => {
  const f = await fixture();
  t.after(() => f.client.close());
  const { agentBridgeTasks, completeTask, recoverInterruptedAgentBridgeTasks, database } = f;
  const [queued] = await database.insert(agentBridgeTasks).values({ messagesJson: "[]", status: "queued" }).returning();
  const [taken] = await database.insert(agentBridgeTasks).values({ messagesJson: "[]", status: "taken" }).returning();
  const [done] = await database.insert(agentBridgeTasks).values({ messagesJson: "[]", status: "done", resultText: "answer" }).returning();
  const [failed] = await database.insert(agentBridgeTasks).values({ messagesJson: "[]", status: "failed" }).returning();

  const interrupted = await recoverInterruptedAgentBridgeTasks(database);
  assert.deepEqual(new Set(interrupted), new Set([queued.id, taken.id]));
  const rows = await database.select().from(agentBridgeTasks);
  assert.equal(rows.find((row) => row.id === queued.id)?.status, "expired");
  assert.equal(rows.find((row) => row.id === taken.id)?.status, "expired");
  assert.ok(rows.find((row) => row.id === queued.id)?.completedAt);
  assert.equal(rows.find((row) => row.id === done.id)?.status, "done");
  assert.equal(rows.find((row) => row.id === failed.id)?.status, "failed");
  assert.equal(await completeTask(taken.id, "late answer", true, database), false, "late bridge answer must not attach to an expired request");
  assert.deepEqual(await recoverInterruptedAgentBridgeTasks(database), [], "recovery is idempotent");
});
