import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import net from "node:net";

// The src-loader pre-seeds a dummy DATABASE_URL (port 1) so importing @/db
// never throws at load time. This test exercises the real DB queue, so we
// replace that dummy before the first @/db import below (dynamic import:
// static imports would hoist above this code).
function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL ?? "";
  if (envUrl && !envUrl.includes("arena-test-no-connect")) return envUrl;
  try {
    const env = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    const match = env.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // no .env — fall through to the standard local default
  }
  return "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
}

async function localPostgresUp(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || 5432);
    return await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: parsed.hostname, port, timeout: 800 });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

const databaseUrl = resolveDatabaseUrl();
const pgUp = await localPostgresUp(databaseUrl);
process.env.DATABASE_URL = databaseUrl;

// Real queue round-trip: durable DB-backed handoff between the app and the
// bridge process. No inference is faked — tasks are completed with literal
// strings, which is exactly what the bridge contract promises.
test("agent bridge: fast-fail when no bridge is polling", { skip: !pgUp }, async () => {
  const { db } = await import("@/db");
  const { agentBridgeState } = await import("@/db/schema");
  const { submitAgentTask } = await import("./agentBridge");

  // Ensure no heartbeat within the staleness window.
  await db.delete(agentBridgeState);
  const result = await submitAgentTask([{ role: "user", content: "say hi" }], "arena-agent", 200);
  assert.equal(result, null, "submitAgentTask must fast-fail when no bridge is alive");
});

test("agent bridge: full round-trip through the DB queue", { skip: !pgUp }, async () => {
  const { db } = await import("@/db");
  const { agentBridgeState } = await import("@/db/schema");
  const { bridgeStatus, completeTask, submitAgentTask, takeNextTask, touchBridge } = await import("./agentBridge");

  await db.delete(agentBridgeState);
  await touchBridge("test-bridge");

  const status = await bridgeStatus();
  assert.equal(status.connected, true);
  assert.equal(status.name, "test-bridge");

  // Bridge polls for work and answers out-of-band while the app waits.
  const answer = (async () => {
    for (let i = 0; i < 200; i++) {
      const task = await takeNextTask();
      if (task) {
        assert.ok(task.id.length > 8);
        assert.equal(Array.isArray(task.messages), true);
        assert.equal(task.messages.at(-1)?.content, "what are you?");
        await completeTask(task.id, "literal bridge answer", true);
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("bridge never received the task");
  })();

  const result = await submitAgentTask([{ role: "user", content: "what are you?" }], "arena-agent", 8000);
  await answer;

  assert.equal(result, "literal bridge answer", "task should complete within the wait window");

  // The task must be gone from the queue after completion.
  const next = await takeNextTask();
  assert.equal(next, null);

  // touchBridge upserts rather than erroring on a second beat.
  await touchBridge("test-bridge");
  const after = await bridgeStatus();
  assert.equal(after.connected, true);

});

test("agent bridge: completing an unknown task is a safe no-op", { skip: !pgUp }, async () => {
  const { completeTask } = await import("./agentBridge");

  const done = await completeTask("00000000-0000-0000-0000-000000000000", "x", false);
  assert.equal(done, false);
});

// Do not leave the pg pool holding the test process open.
after(async () => {
  if (pgUp) {
    const { pool } = await import("@/db");
    await pool.end().catch(() => {});
  }
});
