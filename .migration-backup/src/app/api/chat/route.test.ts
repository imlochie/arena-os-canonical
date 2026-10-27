/**
 * Compatibility tests: opt-in archive evidence in the reasoning route —
 * NATIVE since the Archive Assistant merge (facts from Arena's own tables,
 * zero network hops).
 *
 * `POST /api/chat` stays the reasoning backend; the merged archive
 * assistant only supplies bounded, normalized facts when the caller asks.
 * Local Mode's zero-egress guarantee always wins over archive context, and
 * the internal service credential is never treated as a user identity.
 */

import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";

const ENV_KEYS = [
  "ARENA_INTERNAL_API_KEY",
];

let savedEnv: Record<string, string | undefined> = {};
let realFetch: typeof fetch;

function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL ?? "";
  if (envUrl && !envUrl.includes("arena-test-no-connect")) return envUrl;
  try {
    const env = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    const match = env.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    /* fall through */
  }
  return "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
}

async function localPostgresUp(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    return await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port || 5432), timeout: 800 });
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

// The route builds the pg pool at import time (chatRunner → native client),
// so it is imported only after the real DATABASE_URL is in place.
const { POST: postChat } = await import("./route");

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  realFetch = globalThis.fetch;
  delete process.env.ARENA_INTERNAL_API_KEY;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  globalThis.fetch = realFetch;
});

function chatRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://arena.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const OFFLINE_BODY = {
  modelId: "offline-sage",
  messages: [{ role: "user", content: "What in my archive needs attention?" }],
};

async function seedOneReviewItem(): Promise<void> {
  const { db } = await import("@/db");
  const { archiveObservations, archiveReviewItems } = await import("@/db/schema");
  await db.delete(archiveObservations);
  await db.delete(archiveReviewItems);
  const [review] = await db
    .insert(archiveReviewItems)
    .values({
      subjectKey: "movie|heat|1995",
      title: "Heat (1995) local_only",
      kind: "identity",
      state: "needs_you",
      classification: "local_only",
      payload: { summary: "Local archive file is not indexed by any synced provider library." },
      evidence: ["archive index"],
    })
    .returning();
  await db.insert(archiveObservations).values({
    reviewItemId: review.id,
    evidenceKey: "chat-obs-1",
    payload: { summary: "still local_only" },
  });
}

async function clearReviewItems(): Promise<void> {
  const { db } = await import("@/db");
  const { archiveObservations, archiveReviewItems } = await import("@/db/schema");
  await db.delete(archiveObservations);
  await db.delete(archiveReviewItems);
}

test("chat: archiveContext=true folds cited native facts into an offline answer with zero network", async () => {
  if (!pgUp) return assert.fail("PG required for native archive context chat test");
  await seedOneReviewItem();
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as unknown as typeof fetch;
  try {
    const res = await postChat(chatRequest({ ...OFFLINE_BODY, archiveContext: true }));
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.archiveContext.included, true);
    assert.ok(body.archiveContext.factCount > 0);
    assert.ok(Date.parse(body.archiveContext.generatedAt));
    assert.ok(body.text.length > 0);
    // Native means native: context assembly touched only the local database.
    assert.equal(fetched, 0, "native archive context must make zero network calls");
  } finally {
    await clearReviewItems();
  }
});

test("chat: Local Mode wins — zero egress, archive explicitly skipped", async () => {
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as unknown as typeof fetch;

  const res = await postChat(chatRequest({ ...OFFLINE_BODY, localOnly: true, archiveContext: true }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.localOnly, true);
  assert.equal(body.archiveContext.included, false);
  assert.equal(body.archiveContext.reason, "local_only");
  assert.equal(fetched, 0, "Local Mode must not touch the network at all");
});

test("chat: without the flag there is no archive work at all", async () => {
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as unknown as typeof fetch;

  const res = await postChat(chatRequest(OFFLINE_BODY));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.archiveContext, undefined);
  assert.equal(fetched, 0);
});

/* ------------- internal credential on the browser leg (key configured) --- */

const INTERNAL_KEY = "test-internal-secret-0123456789";

test("chat: browser leg still works with no credential when the internal key is configured", async () => {
  process.env.ARENA_INTERNAL_API_KEY = INTERNAL_KEY;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as unknown as typeof fetch;

  const res = await postChat(chatRequest(OFFLINE_BODY));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.caller, undefined, "plain browser calls are not tagged as service calls");
  assert.equal(fetched, 0);
});

test("chat: the internal credential authenticates service calls, and archive stays off that leg", async () => {
  process.env.ARENA_INTERNAL_API_KEY = INTERNAL_KEY;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as unknown as typeof fetch;

  const res = await postChat(chatRequest(OFFLINE_BODY, { authorization: `Bearer ${INTERNAL_KEY}` }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.caller, "internal_service");
  assert.equal(fetched, 0);

  // The service credential is NOT a user identity: archive evidence is not
  // honored on the service leg even when explicitly requested.
  const res2 = await postChat(
    chatRequest({ ...OFFLINE_BODY, archiveContext: true }, { authorization: `Bearer ${INTERNAL_KEY}` }),
  );
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.caller, "internal_service");
  assert.equal(body2.archiveContext.included, false);
  assert.equal(body2.archiveContext.reason, "internal_caller");
});

test("chat: an unknown bearer on plain chat is rejected; as a user token it chats with native archive context", async () => {
  process.env.ARENA_INTERNAL_API_KEY = INTERNAL_KEY;

  // Wrong secret, no archiveContext: no user intent → 401.
  const rejected = await postChat(chatRequest(OFFLINE_BODY, { authorization: "Bearer not-the-key" }));
  assert.equal(rejected.status, 401);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.error, "unauthorized_internal_caller");

  // Unknown bearer + archiveContext: it is a user token — native context
  // is folded in from Arena's own tables (no forwarding exists any more).
  if (pgUp) {
    await seedOneReviewItem();
    try {
      const res = await postChat(
        chatRequest({ ...OFFLINE_BODY, archiveContext: true }, { authorization: "Bearer user-aa-token" }),
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.archiveContext.included, true);
      assert.ok(body.archiveContext.factCount > 0);
    } finally {
      await clearReviewItems();
    }
  }
});

// One shared pool lifecycle for the whole file.
after(async () => {
  if (pgUp) {
    const { pool } = await import("@/db");
    await pool.end().catch(() => {});
  }
});
