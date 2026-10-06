/**
 * Compatibility tests: the Arena-side read-only routes.
 *   GET /api/archive/context
 *   GET /api/archive/findings/:reviewItemId/lineage
 *
 * Covers: context assembly, owner isolation (user A vs user B), refresh
 * semantics surfaced through the API, explicit bounded lineage lookup, and
 * honest status codes (503/401/400/404).
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { GET as getContext } from "./context/route";
import { GET as getLineage } from "./findings/[reviewItemId]/lineage/route";
import {
  LINEAGE,
  WORKLOAD,
  makeArchiveFetchStub,
  type RecordedCall,
} from "../../../lib/archive-assistant/fixtures";

const ENV_KEYS = [
  "ARCHIVE_ASSISTANT_API_URL",
  "ARCHIVE_ASSISTANT_AUTH_MODE",
  "ARCHIVE_ASSISTANT_OWNER_ID",
  "ARCHIVE_ASSISTANT_TIMEOUT_MS",
];

let savedEnv: Record<string, string | undefined> = {};
let realFetch: typeof fetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  realFetch = globalThis.fetch;
  process.env.ARCHIVE_ASSISTANT_API_URL = "https://archive-assistant.example.com/api";
  delete process.env.ARCHIVE_ASSISTANT_AUTH_MODE;
  delete process.env.ARCHIVE_ASSISTANT_OWNER_ID;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  globalThis.fetch = realFetch;
});

function ownerTaggedFetch() {
  const calls: RecordedCall[] = [];
  const { stub: base } = makeArchiveFetchStub();
  const stub = (async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    calls.push({ url, method: init?.method ?? "GET", headers });
    const res = await base(url, init as never);
    if (new URL(url).pathname === "/api/assistant/workload" && res.ok) {
      // Tag the payload with the identity it was fetched as, the same way a
      // real owner-scoped upstream scopes rows by the authenticated owner.
      const token = headers["authorization"] ?? "none";
      const tagged = {
        ...WORKLOAD,
        items: WORKLOAD.items.map((item, i) => (i === 0 ? { ...item, title: `${item.title} · fetched-as:${token}` } : item)),
      };
      return Response.json(tagged);
    }
    return res;
  }) as unknown as typeof fetch;
  return { stub, calls };
}

/* ------------------------------ context route ---------------------------- */

test("context: assembles the six-part context with normalized facts", async () => {
  const { stub, calls } = makeArchiveFetchStub();
  globalThis.fetch = stub;

  const res = await getContext(
    new Request("http://arena.test/api/archive/context", { headers: { authorization: "Bearer owner-a" } }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(Object.keys(body.context).sort(), ["generatedAt", "overview", "reconciliation", "refresh", "workload"].sort());
  assert.equal(body.context.reconciliation.localCount, 900);
  assert.equal(body.context.refresh.plex.currentAuthoritativeRefresh.refreshId, "plex-r17");
  assert.equal(body.context.refresh.jellyfin.lastAttemptedRefresh.refreshId, "jf-r09");
  assert.ok(Array.isArray(body.facts) && body.facts.length > 0);
  assert.equal(body.meta.authMode, "bearer");
  assert.equal(body.meta.upstreamHost, "archive-assistant.example.com");
  assert.equal(body.meta.refreshHistoryIncluded, false);
  assert.equal(body.refreshHistory, undefined);

  // Exactly the five core reads, all GET, all server-to-server with auth.
  assert.equal(calls.length, 5);
  const paths = calls.map((c) => new URL(c.url).pathname).sort();
  assert.deepEqual(paths, [
    "/api/archive/reconciliation",
    "/api/assistant/overview",
    "/api/assistant/workload",
    "/api/provider/refresh",
    "/api/provider/refresh",
  ]);
  for (const call of calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.headers["authorization"], "Bearer owner-a");
    assert.ok(!("x-test-owner-id" in call.headers));
  }
});

test("context: ?history=1 attaches one bounded history page per provider", async () => {
  const { stub, calls } = makeArchiveFetchStub();
  globalThis.fetch = stub;

  const res = await getContext(
    new Request("http://arena.test/api/archive/context?history=1", { headers: { authorization: "Bearer owner-a" } }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.meta.refreshHistoryIncluded, true);
  assert.equal(body.refreshHistory.plex.results[0].refreshId, "plex-r18");
  assert.equal(body.refreshHistory.jellyfin.results[0].refreshId, "jf-r09");
  const historyCalls = calls.filter((c) => new URL(c.url).pathname === "/api/provider/refresh/history");
  assert.equal(historyCalls.length, 2);
});

test("context: owner isolation — A and B receive identity-scoped data end to end", async () => {
  const { stub, calls } = ownerTaggedFetch();
  globalThis.fetch = stub;

  const resA = await getContext(
    new Request("http://arena.test/api/archive/context", { headers: { authorization: "Bearer owner-A" } }),
  );
  const resB = await getContext(
    new Request("http://arena.test/api/archive/context", { headers: { authorization: "Bearer owner-B" } }),
  );
  const bodyA = await resA.json();
  const bodyB = await resB.json();

  const titleA = bodyA.context.workload.items[0].title;
  const titleB = bodyB.context.workload.items[0].title;
  assert.match(titleA, /fetched-as:Bearer owner-A/);
  assert.match(titleB, /fetched-as:Bearer owner-B/);
  assert.doesNotMatch(titleA, /owner-B/);
  assert.doesNotMatch(titleB, /owner-A/);

  // Every upstream call carried its own caller's identity, in order: all of
  // A's five reads, then all of B's.
  assert.equal(calls.length, 10);
  assert.ok(calls.slice(0, 5).every((c) => c.headers["authorization"] === "Bearer owner-A"));
  assert.ok(calls.slice(5).every((c) => c.headers["authorization"] === "Bearer owner-B"));
});

test("context: 503 when the bridge is not configured (never a localhost guess)", async () => {
  delete process.env.ARCHIVE_ASSISTANT_API_URL;
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("x");
  }) as unknown as typeof fetch;

  const res = await getContext(
    new Request("http://arena.test/api/archive/context", { headers: { authorization: "Bearer owner-a" } }),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, "archive_assistant_not_configured");
  assert.match(body.message, /no localhost fallback/);
  assert.ok(!fetched);
});

test("context: 401 when no bearer token is available to forward", async () => {
  const res = await getContext(new Request("http://arena.test/api/archive/context"));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "auth_required");
});

test("context: upstream 401 means re-authenticate (no synthesized data)", async () => {
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  const res = await getContext(
    new Request("http://arena.test/api/archive/context", { headers: { authorization: "Bearer stale" } }),
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "archive_assistant_auth_failed");
});

test("context: local mode uses only the server-configured owner constant", async () => {
  process.env.ARCHIVE_ASSISTANT_AUTH_MODE = "local";
  process.env.ARCHIVE_ASSISTANT_OWNER_ID = "__local__";
  const { stub, calls } = makeArchiveFetchStub();
  globalThis.fetch = stub;

  const res = await getContext(new Request("http://arena.test/api/archive/context"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.meta.authMode, "local");
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.headers["x-archive-assistant-owner-id"], "__local__");
    assert.ok(!("x-test-owner-id" in call.headers));
    assert.ok(!("authorization" in call.headers));
  }
});

test("context: contract violation upstream → 502 with the schema path", async () => {
  const { stub } = makeArchiveFetchStub({ "/assistant/workload": { items: "not-an-array" } });
  globalThis.fetch = stub;
  const res = await getContext(
    new Request("http://arena.test/api/archive/context", { headers: { authorization: "Bearer owner-a" } }),
  );
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, "archive_assistant_contract_violation");
  assert.match(body.message, /AssistantWorkload/);
});

/* ------------------------------ lineage route ---------------------------- */

function lineageRequest(id: string, headers: Record<string, string> = { authorization: "Bearer owner-a" }) {
  return [
    new Request(`http://arena.test/api/archive/findings/${id}/lineage`, { headers }),
    { params: Promise.resolve({ reviewItemId: id }) },
  ] as const;
}

test("lineage: explicit lookup returns current + superseded observation and provider linkage", async () => {
  const { stub, calls } = makeArchiveFetchStub();
  globalThis.fetch = stub;

  const res = await getLineage(...lineageRequest("42"));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.lineage.finding.reviewItemId, LINEAGE.finding.reviewItemId);
  assert.equal(body.lineage.currentObservation.observationId, 9001);
  assert.equal(body.lineage.previousObservation.observationId, 8800);
  assert.equal(body.lineage.provider.snapshotReference, "snap-plex-17");

  const classifications = body.facts.map((f: { classification?: string }) => f.classification);
  assert.ok(classifications.includes("quality_conflict"));
  assert.ok(classifications.includes("superseded_observation"));
  assert.ok(classifications.includes("provider_evidence"));

  // Exactly one bounded upstream read — Arena never eagerly walks history.
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/api/archive/reconciliation/findings/42/lineage");
  assert.equal(calls[0].headers["authorization"], "Bearer owner-a");
});

test("lineage: non-positive or non-integer ids are 400 with zero upstream calls", async () => {
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response("x");
  }) as unknown as typeof fetch;

  for (const id of ["abc", "0", "-12", "4.5"]) {
    const res = await getLineage(...lineageRequest(id));
    assert.equal(res.status, 400, `id=${id}`);
    const body = await res.json();
    assert.equal(body.error, "invalid_review_item_id");
  }
  assert.equal(fetched, 0);
});

test("lineage: upstream 404 stays a 404 (no fabricated lineage)", async () => {
  const { stub } = makeArchiveFetchStub();
  globalThis.fetch = stub;
  const res = await getLineage(...lineageRequest("999"));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "archive_assistant_not_found");
});
