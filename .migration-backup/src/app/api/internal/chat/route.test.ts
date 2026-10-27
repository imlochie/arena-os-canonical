/**
 * Security tests: the internal service leg of the reasoning route.
 *
 * The exact contract requested for the canonical bridge:
 *   key not configured → 503 (fail closed)
 *   missing secret     → 401
 *   wrong secret       → 401 (byte-identical body — no missing-vs-wrong oracle)
 *   correct secret     → allowed
 *
 * Plus the confusion-deputy rule: the internal credential is never
 * forwarded to Archive Assistant as if it were a user identity.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { POST as postInternalChat } from "./route";

const INTERNAL_KEY = "test-internal-secret-0123456789";
const ENV_KEYS = ["ARENA_INTERNAL_API_KEY", "ARCHIVE_ASSISTANT_API_URL"];

let savedEnv: Record<string, string | undefined> = {};
let realFetch: typeof fetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  realFetch = globalThis.fetch;
  process.env.ARENA_INTERNAL_API_KEY = INTERNAL_KEY;
  process.env.ARCHIVE_ASSISTANT_API_URL = "https://archive-assistant.example.com/api";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  globalThis.fetch = realFetch;
});

function internalRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://arena.test/api/internal/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const OFFLINE_BODY = {
  modelId: "offline-sage",
  messages: [
    { role: "system", content: "You are the Archive Assistant reasoning layer." },
    { role: "user", content: "Question from the canonical bridge\n\nArchive evidence:\n{…}" },
  ],
};

test("internal: fail closed when ARENA_INTERNAL_API_KEY is not configured", async () => {
  delete process.env.ARENA_INTERNAL_API_KEY;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as unknown as typeof fetch;

  const res = await postInternalChat(
    internalRequest(OFFLINE_BODY, { authorization: `Bearer ${INTERNAL_KEY}` }),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, "internal_auth_not_configured");
  assert.equal(fetched, 0);
});

test("internal: missing secret → 401", async () => {
  const res = await postInternalChat(internalRequest(OFFLINE_BODY));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "unauthorized_internal_caller");
});

test("internal: wrong secret → 401, indistinguishable from missing", async () => {
  const missing = await postInternalChat(internalRequest(OFFLINE_BODY));
  const wrong = await postInternalChat(internalRequest(OFFLINE_BODY, { authorization: "Bearer nope" }));
  assert.equal(wrong.status, 401);

  const missingText = await missing.text();
  const wrongText = await wrong.text();
  assert.equal(wrongText, missingText, "wrong and missing secrets must be indistinguishable");
});

test("internal: near-miss secrets are rejected (comparison is exact)", async () => {
  for (const candidate of [INTERNAL_KEY + "x", INTERNAL_KEY.slice(0, -1), INTERNAL_KEY.toUpperCase()]) {
    const res = await postInternalChat(
      internalRequest(OFFLINE_BODY, { authorization: `Bearer ${candidate}` }),
    );
    assert.equal(res.status, 401, `candidate: ${candidate.slice(0, 12)}…`);
  }
});

test("internal: correct secret → allowed, tagged as service caller, zero archive egress", async () => {
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as unknown as typeof fetch;

  const res = await postInternalChat(
    internalRequest(OFFLINE_BODY, { authorization: `Bearer ${INTERNAL_KEY}` }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.caller, "internal_service");
  assert.equal(body.localOnly, false);
  assert.ok(typeof body.text === "string" && body.text.length > 0);
  assert.equal(fetched, 0);
});

test("internal: archiveContext is never honored for a service credential", async () => {
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as unknown as typeof fetch;

  const res = await postInternalChat(
    internalRequest(
      { ...OFFLINE_BODY, archiveContext: true },
      { authorization: `Bearer ${INTERNAL_KEY}` },
    ),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.caller, "internal_service");
  assert.equal(body.archiveContext.included, false);
  assert.equal(body.archiveContext.reason, "internal_caller");
  assert.equal(fetched, 0, "the internal credential must not reach Archive Assistant as an identity");
});

test("internal: missing and wrong secrets also gate archiveContext-carrying bodies", async () => {
  const missing = await postInternalChat(internalRequest({ ...OFFLINE_BODY, archiveContext: true }));
  assert.equal(missing.status, 401);
  const wrong = await postInternalChat(
    internalRequest({ ...OFFLINE_BODY, archiveContext: true }, { authorization: "Bearer nope" }),
  );
  assert.equal(wrong.status, 401);
});
