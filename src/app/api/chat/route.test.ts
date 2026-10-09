/**
 * Compatibility tests: opt-in archive evidence in the reasoning route.
 *
 * `POST /api/chat` stays the reasoning backend; Archive Assistant only
 * supplies bounded, normalized facts when the caller asks. Local Mode's
 * zero-egress guarantee always wins over archive context.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { POST as postChat } from "./route";
import { makeArchiveFetchStub } from "../../../lib/archive-assistant/fixtures";

const ENV_KEYS = [
  "ARCHIVE_ASSISTANT_API_URL",
  "ARCHIVE_ASSISTANT_AUTH_MODE",
  "ARCHIVE_ASSISTANT_OWNER_ID",
  "ARENA_INTERNAL_API_KEY",
];

let savedEnv: Record<string, string | undefined> = {};
let realFetch: typeof fetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  realFetch = globalThis.fetch;
  process.env.ARCHIVE_ASSISTANT_API_URL = "https://archive-assistant.example.com/api";
  delete process.env.ARCHIVE_ASSISTANT_AUTH_MODE;
  delete process.env.ARCHIVE_ASSISTANT_OWNER_ID;
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

test("chat: archiveContext=true folds cited facts into an offline answer, forwarding the bearer token", async () => {
  const { stub, calls } = makeArchiveFetchStub();
  globalThis.fetch = stub;

  const res = await postChat(chatRequest({ ...OFFLINE_BODY, archiveContext: true }, { authorization: "Bearer owner-a" }));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.archiveContext.included, true);
  assert.ok(body.archiveContext.factCount > 0);
  assert.ok(Date.parse(body.archiveContext.generatedAt));
  assert.ok(body.text.length > 0);
  assert.ok(calls.length >= 5, "context assembly reads the archive bridge only");

  // Zero non-archive egress: the offline model never leaves the machine.
  for (const call of calls) {
    assert.match(new URL(call.url).host, /^archive-assistant\.example\.com$/);
    assert.equal(call.headers["authorization"], "Bearer owner-a");
    assert.ok(!("x-test-owner-id" in call.headers));
  }
});

test("chat: Local Mode wins — zero egress, archive explicitly skipped", async () => {
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as unknown as typeof fetch;

  const res = await postChat(
    chatRequest({ ...OFFLINE_BODY, localOnly: true, archiveContext: true }, { authorization: "Bearer owner-a" }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.localOnly, true);
  assert.equal(body.archiveContext.included, false);
  assert.equal(body.archiveContext.reason, "local_only");
  assert.equal(fetched, 0, "Local Mode must not touch the network at all");
});

test("chat: unconfigured bridge degrades softly and says why", async () => {
  delete process.env.ARCHIVE_ASSISTANT_API_URL;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as unknown as typeof fetch;

  const res = await postChat(chatRequest({ ...OFFLINE_BODY, archiveContext: true }, { authorization: "Bearer owner-a" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.archiveContext.included, false);
  assert.equal(body.archiveContext.reason, "not_configured");
  assert.equal(fetched, 0);
});

test("chat: missing bearer with archive requested degrades softly as auth_required", async () => {
  const res = await postChat(chatRequest({ ...OFFLINE_BODY, archiveContext: true }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.archiveContext.included, false);
  assert.equal(body.archiveContext.reason, "auth_required");
});

test("chat: without the flag there is no archive work at all", async () => {
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as unknown as typeof fetch;

  const res = await postChat(chatRequest(OFFLINE_BODY, { authorization: "Bearer owner-a" }));
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

test("chat: the internal credential authenticates service calls on the legacy path", async () => {
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

  // The service credential is NOT a user identity: archive evidence
  // forwarding is refused even when explicitly requested.
  const res2 = await postChat(
    chatRequest({ ...OFFLINE_BODY, archiveContext: true }, { authorization: `Bearer ${INTERNAL_KEY}` }),
  );
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.caller, "internal_service");
  assert.equal(body2.archiveContext.included, false);
  assert.equal(body2.archiveContext.reason, "internal_caller");
  assert.equal(fetched, 0, "the internal credential must never be forwarded to Archive Assistant");
});

test("chat: an unknown bearer on plain chat is rejected; as an archive user token it is forwarded", async () => {
  process.env.ARENA_INTERNAL_API_KEY = INTERNAL_KEY;

  // Wrong secret, no archiveContext: no forwarding purpose → 401.
  const rejected = await postChat(chatRequest(OFFLINE_BODY, { authorization: "Bearer not-the-key" }));
  assert.equal(rejected.status, 401);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.error, "unauthorized_internal_caller");

  // Unknown bearer + archiveContext: it is a USER token for Archive
  // Assistant, forwarded server-to-server exactly like the browser flow.
  const { stub, calls } = makeArchiveFetchStub();
  globalThis.fetch = stub;
  const forwarded = await postChat(
    chatRequest({ ...OFFLINE_BODY, archiveContext: true }, { authorization: "Bearer user-aa-token" }),
  );
  assert.equal(forwarded.status, 200);
  const forwardedBody = await forwarded.json();
  assert.equal(forwardedBody.archiveContext.included, true);
  assert.ok(calls.length >= 5);
  assert.ok(calls.every((c) => c.headers["authorization"] === "Bearer user-aa-token"));
});
