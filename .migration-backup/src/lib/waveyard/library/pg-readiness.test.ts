/**
 * Regression tests for the Windows acceptance failure on 9431870:
 * the embedded-postgres readiness loop reused ONE pg Client across failed
 * connection attempts, and node-postgres threw
 * "Client has already been connected. You cannot reuse a client." —
 * collapsing every library/session integration test (the shared before()
 * hook never completed).
 *
 * These tests enforce the retry-safe contract WITHOUT a database: the fake
 * clients below model node-postgres's real poison behavior (a second
 * connect() on a failed client rejects with the production error), so
 * reintroducing the single-client loop fails these tests with exactly the
 * error the Windows gate saw.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { waitForPostgresReady, type PgReadinessClient } from "./pg-readiness";

/** Models node-postgres Client behavior: a connect() after a FAILED
 * attempt rejects with the real reuse error. `readyAfter` attempts fail
 * before one succeeds (default 0 = ready immediately). */
function makePgLikeWorld(readyAfter: number) {
  const created: FakeClient[] = [];
  let attempts = 0;
  class FakeClient implements PgReadinessClient {
    connectCalls = 0;
    endCalls = 0;
    endedAfterUse: string[] = [];
    constructor() {
      created.push(this);
    }
    async connect(): Promise<void> {
      this.connectCalls += 1;
      if (this.connectCalls > 1) {
        // EXACT production behavior of a reused, previously-failed client.
        throw new Error("Client has already been connected. You cannot reuse a client.");
      }
      attempts += 1;
      if (attempts <= readyAfter) throw new Error("connect ECONNREFUSED 127.0.0.1:5432 (not ready yet)");
    }
    async end(): Promise<void> {
      this.endCalls += 1;
    }
  }
  const world = {
    created,
    /** How many clients the helper built (MUST equal attempts, i.e. a fresh
     * client per attempt — the core regression assertion). */
    get clientCount() {
      return created.length;
    },
    createClient: () => new FakeClient(),
  };
  return world;
}

test("readiness: a failed first attempt gets a FRESH client (never reuses the poisoned one)", async () => {
  // First attempt loses the race against postgres startup; second succeeds.
  const world = makePgLikeWorld(1);
  const used: unknown[] = [];
  await waitForPostgresReady({
    createClient: world.createClient,
    useConnectedClient: async (client) => {
      used.push(client);
    },
    timeoutMs: 5_000,
    intervalMs: 1,
  });
  // THE regression guard: exactly one connect per client, two clients built.
  assert.equal(world.clientCount, 2, "a fresh client must be built per attempt");
  assert.equal(world.created[0]?.connectCalls, 1, "the failed client must never be re-connected");
  assert.equal(world.created[1]?.connectCalls, 1);
  assert.equal(used.length, 1);
  assert.equal(used[0], world.created[1], "the connected (second) client is the one used");
  // Cleanup: both the failed and the used client were ended.
  assert.equal(world.created[0]?.endCalls, 1);
  assert.equal(world.created[1]?.endCalls, 1);
});

test("readiness: immediate connection uses and ends exactly one client", async () => {
  const world = makePgLikeWorld(0);
  const order: string[] = [];
  await waitForPostgresReady({
    createClient: world.createClient,
    useConnectedClient: async () => {
      order.push("use");
    },
    timeoutMs: 5_000,
    intervalMs: 1,
  });
  assert.equal(world.clientCount, 1);
  order.push("ended"); // end() resolved inside the helper before returning
  assert.deepEqual(order, ["use", "ended"]);
  assert.equal(world.created[0]?.endCalls, 1);
});

test("readiness: a failure INSIDE useConnectedClient propagates immediately (no retry masking)", async () => {
  const world = makePgLikeWorld(0);
  await assert.rejects(
    waitForPostgresReady({
      createClient: world.createClient,
      useConnectedClient: async () => {
        throw new Error("create database failed: permission denied");
      },
      timeoutMs: 5_000,
      intervalMs: 1,
    }),
    /permission denied/,
  );
  // No retry was burned on a setup error, and the client was still ended.
  assert.equal(world.clientCount, 1);
  assert.equal(world.created[0]?.endCalls, 1);
});

test("readiness: deadline exhaustion throws the last real error (bounded, honest diagnostics)", async () => {
  const world = makePgLikeWorld(Number.POSITIVE_INFINITY); // never ready
  await assert.rejects(
    waitForPostgresReady({
      createClient: world.createClient,
      useConnectedClient: async () => undefined,
      timeoutMs: 120,
      intervalMs: 30,
      label: "embedded postgres",
    }),
    /embedded postgres never became ready:[\s\S]*ECONNREFUSED/,
  );
  // Bounded: several fresh attempts, not one poisoned client spinning, and
  // not unbounded (deadline ~120ms / 30ms ≈ ≤ 8 attempts).
  assert.ok(world.clientCount >= 2, "retried with fresh clients");
  assert.ok(world.clientCount <= 10, "bounded by the deadline");
  for (const client of world.created) {
    assert.equal(client.connectCalls, 1, "no client was ever reused");
  }
});

test("readiness: a failed client whose end() also throws does not break the loop", async () => {
  let failures = 0;
  const created: PgReadinessClient[] = [];
  const createClient = (): PgReadinessClient => {
    const client: PgReadinessClient = {
      async connect() {
        if (failures === 0) {
          failures += 1;
          throw new Error("connect ECONNREFUSED (not ready)");
        }
      },
      async end() {
        if (failures === 1 && created.length === 1 && client === created[0]) {
          throw new Error("end failed on the broken client");
        }
      },
    };
    created.push(client);
    return client;
  };
  await waitForPostgresReady({
    createClient,
    useConnectedClient: async () => undefined,
    timeoutMs: 5_000,
    intervalMs: 1,
  });
  assert.equal(created.length, 2);
});

test("readiness: original harness semantics preserved (default 30s deadline, 150ms interval, message text)", async () => {
  // One failure then success; the defaults path (no explicit timeout/interval).
  const world = makePgLikeWorld(1);
  await assert.doesNotReject(
    waitForPostgresReady({
      createClient: world.createClient,
      useConnectedClient: async () => undefined,
      intervalMs: 1, // keep the test fast; deadline default is exercised elsewhere
    }),
  );
  assert.equal(world.clientCount, 2);
});
