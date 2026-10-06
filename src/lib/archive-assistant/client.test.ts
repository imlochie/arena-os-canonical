/**
 * Compatibility tests: Archive Assistant read-only client.
 *
 * Covers the spec's contract guarantees:
 *   - configuration rejects a missing URL (no silent localhost fallback);
 *   - bearer tokens are forwarded verbatim, per request (owner isolation);
 *   - local mode uses only the server-configured owner constant;
 *   - the test-only x-test-owner-id header is never emitted;
 *   - upstream statuses map onto the error taxonomy;
 *   - responses are validated against the generated contract;
 *   - the client has NO mutation methods (approve/reject/reopen/execute/
 *     delete/rename/move/download/sync stay in Archive Assistant).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createArchiveAssistantClient,
  resolveRequestAuth,
} from "./client";
import { getArchiveAssistantConfig } from "./config";
import {
  ArchiveAssistantApiError,
  ArchiveAssistantAuthRequiredError,
  ArchiveAssistantContractError,
  ArchiveAssistantNotFoundError,
  ArchiveAssistantTimeoutError,
  ArchiveAssistantUpstreamAuthError,
} from "./errors";
import { archiveReadOnlyOperations } from "./generated/contract";
import {
  LINEAGE,
  OVERVIEW,
  PLEX_AUTHORITY,
  PLEX_HISTORY,
  PLEX_STATE_PARTIAL_FAILURE,
  RECONCILIATION_REPORT,
  WORKLOAD,
  makeArchiveFetchStub,
} from "./fixtures";

const BASE_ENV = {
  ARCHIVE_ASSISTANT_API_URL: "https://archive-assistant.example.com/api",
};

/* ----------------------------- configuration ---------------------------- */

test("config: missing ARCHIVE_ASSISTANT_API_URL is a hard error (no localhost fallback)", () => {
  assert.throws(
    () => getArchiveAssistantConfig({}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match((error as Error).message, /ARCHIVE_ASSISTANT_API_URL is required/);
      assert.match((error as Error).message, /no localhost fallback/);
      assert.doesNotMatch((error as Error).message, /localhost:\d/);
      return true;
    },
  );
});

test("config: invalid URL and bad auth mode are rejected", () => {
  assert.throws(() => getArchiveAssistantConfig({ ARCHIVE_ASSISTANT_API_URL: "not-a-url" }));
  assert.throws(() =>
    getArchiveAssistantConfig({ ...BASE_ENV, ARCHIVE_ASSISTANT_AUTH_MODE: "sideways" }),
  );
});

test("config: local mode requires a server-configured owner id", () => {
  assert.throws(() =>
    getArchiveAssistantConfig({ ...BASE_ENV, ARCHIVE_ASSISTANT_AUTH_MODE: "local" }),
  );
  const config = getArchiveAssistantConfig({
    ...BASE_ENV,
    ARCHIVE_ASSISTANT_AUTH_MODE: "local",
    ARCHIVE_ASSISTANT_OWNER_ID: "__local__",
  });
  assert.equal(config.authMode, "local");
  assert.equal(config.ownerId, "__local__");
});

test("config: bearer is the default mode; trailing slashes are normalized", () => {
  const config = getArchiveAssistantConfig({ ARCHIVE_ASSISTANT_API_URL: "https://host.test/api///" });
  assert.equal(config.authMode, "bearer");
  assert.equal(config.baseUrl, "https://host.test/api");
});

/* ------------------------------- auth ----------------------------------- */

test("auth: bearer mode forwards the request token verbatim", () => {
  const config = getArchiveAssistantConfig(BASE_ENV);
  const req = new Request("https://arena.test/api/archive/context", {
    headers: { authorization: "Bearer user-token-A.123" },
  });
  const auth = resolveRequestAuth(req, config);
  assert.deepEqual(auth, { mode: "bearer", token: "user-token-A.123" });
});

test("auth: bearer mode without a token is rejected (401 at the boundary)", () => {
  const config = getArchiveAssistantConfig(BASE_ENV);
  assert.throws(
    () => resolveRequestAuth(new Request("https://arena.test/api/archive/context"), config),
    ArchiveAssistantAuthRequiredError,
  );
});

test("auth: local mode ignores any client-supplied identity header", () => {
  const config = getArchiveAssistantConfig({
    ...BASE_ENV,
    ARCHIVE_ASSISTANT_AUTH_MODE: "local",
    ARCHIVE_ASSISTANT_OWNER_ID: "__local__",
  });
  const req = new Request("https://arena.test/api/archive/context", {
    headers: {
      authorization: "Bearer attacker-token",
      "x-test-owner-id": "someone-else",
      "x-archive-assistant-owner-id": "someone-else",
    },
  });
  const auth = resolveRequestAuth(req, config);
  assert.deepEqual(auth, { mode: "local", ownerId: "__local__" });
});

/* ----------------------------- header safety ----------------------------- */

test("headers: requests forward the bearer token; x-test-owner-id is never emitted (owner A)", async () => {
  const config = getArchiveAssistantConfig(BASE_ENV);
  const { stub, calls } = makeArchiveFetchStub();
  const client = createArchiveAssistantClient(config, { mode: "bearer", token: "owner-A-token" }, { fetchImpl: stub });
  await client.getOverview();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["authorization"], "Bearer owner-A-token");
  assert.ok(!("x-test-owner-id" in calls[0].headers), "x-test-owner-id must never be sent");
  assert.ok(!("x-archive-assistant-owner-id" in calls[0].headers));
});

test("headers: owner isolation — request-scoped clients never mix identities", async () => {
  const config = getArchiveAssistantConfig(BASE_ENV);
  const { stub, calls } = makeArchiveFetchStub();

  const clientA = createArchiveAssistantClient(config, { mode: "bearer", token: "owner-A-token" }, { fetchImpl: stub });
  const clientB = createArchiveAssistantClient(config, { mode: "bearer", token: "owner-B-token" }, { fetchImpl: stub });
  await clientA.getWorkload();
  await clientB.getWorkload();
  await clientA.getReconciliationSummary();

  assert.equal(calls[0].headers["authorization"], "Bearer owner-A-token");
  assert.equal(calls[1].headers["authorization"], "Bearer owner-B-token");
  assert.equal(calls[2].headers["authorization"], "Bearer owner-A-token");
});

test("headers: local mode sends the server-configured owner constant, never the test header", async () => {
  const config = getArchiveAssistantConfig({
    ...BASE_ENV,
    ARCHIVE_ASSISTANT_AUTH_MODE: "local",
    ARCHIVE_ASSISTANT_OWNER_ID: "__local__",
  });
  const { stub, calls } = makeArchiveFetchStub();
  const client = createArchiveAssistantClient(config, { mode: "local", ownerId: config.ownerId ?? "" }, { fetchImpl: stub });
  await client.getProviderRefreshState("plex");
  assert.equal(calls[0].headers["x-archive-assistant-owner-id"], "__local__");
  assert.ok(!("x-test-owner-id" in calls[0].headers));
  assert.ok(!("authorization" in calls[0].headers));
});

/* ------------------------------ methods/URLs ---------------------------- */

test("client: six operations hit the official read-only endpoints", async () => {
  const config = getArchiveAssistantConfig(BASE_ENV);
  const { stub, calls } = makeArchiveFetchStub();
  const client = createArchiveAssistantClient(config, { mode: "bearer", token: "t" }, { fetchImpl: stub });

  const overview = await client.getOverview();
  assert.equal(overview.summary.health, OVERVIEW.summary.health);

  const workload = await client.getWorkload();
  assert.equal(workload.items.length, WORKLOAD.items.length);

  const summary = await client.getReconciliationSummary();
  assert.equal(summary.matchedCount, RECONCILIATION_REPORT.summary.matchedCount);

  const lineage = await client.getFindingLineage(42);
  assert.equal(lineage.finding.reviewItemId, LINEAGE.finding.reviewItemId);

  const state = await client.getProviderRefreshState("jellyfin");
  assert.equal(state.provider, "jellyfin");

  const history = await client.getProviderRefreshHistory("plex", { pageSize: 100 });
  assert.equal(history.pagination.total, PLEX_HISTORY.pagination.total);

  const urls = calls.map((c) => new URL(c.url));
  assert.equal(urls[0].pathname, "/api/assistant/overview");
  assert.equal(urls[1].pathname, "/api/assistant/workload");
  assert.equal(urls[2].pathname, "/api/archive/reconciliation");
  assert.equal(urls[2].searchParams.get("pageSize"), "1", "summary read stays bounded");
  assert.equal(urls[3].pathname, "/api/archive/reconciliation/findings/42/lineage");
  assert.equal(urls[4].pathname, "/api/provider/refresh");
  assert.equal(urls[4].searchParams.get("provider"), "jellyfin");
  assert.equal(urls[5].pathname, "/api/provider/refresh/history");
  assert.equal(urls[5].searchParams.get("pageSize"), "25", "history is hard-capped at 25");
  for (const call of calls) assert.equal(call.method, "GET");
});

test("client: invalid reviewItemId is rejected before any HTTP call", async () => {
  const config = getArchiveAssistantConfig(BASE_ENV);
  const { stub, calls } = makeArchiveFetchStub();
  const client = createArchiveAssistantClient(config, { mode: "bearer", token: "t" }, { fetchImpl: stub });
  await assert.rejects(() => client.getFindingLineage(0), ArchiveAssistantContractError);
  await assert.rejects(() => client.getFindingLineage(-3), ArchiveAssistantContractError);
  await assert.rejects(() => client.getFindingLineage(4.5), ArchiveAssistantContractError);
  assert.equal(calls.length, 0);
});

/* ------------------------------ error mapping --------------------------- */

test("errors: 404 → NotFound; 401/403 → UpstreamAuth; 500 → Api", async () => {
  const config = getArchiveAssistantConfig(BASE_ENV);
  const failing = (status: number) =>
    (async () => new Response("nope", { status })) as unknown as typeof fetch;

  const c404 = createArchiveAssistantClient(config, { mode: "bearer", token: "t" }, { fetchImpl: failing(404) });
  await assert.rejects(() => c404.getFindingLineage(42), ArchiveAssistantNotFoundError);

  const c401 = createArchiveAssistantClient(config, { mode: "bearer", token: "t" }, { fetchImpl: failing(401) });
  await assert.rejects(() => c401.getOverview(), ArchiveAssistantUpstreamAuthError);

  const c403 = createArchiveAssistantClient(config, { mode: "bearer", token: "t" }, { fetchImpl: failing(403) });
  await assert.rejects(() => c403.getOverview(), (e: unknown) => (e as ArchiveAssistantUpstreamAuthError).status === 403);

  const c500 = createArchiveAssistantClient(config, { mode: "bearer", token: "t" }, { fetchImpl: failing(500) });
  await assert.rejects(() => c500.getWorkload(), (e: unknown) => {
    assert.ok(e instanceof ArchiveAssistantApiError);
    assert.equal((e as ArchiveAssistantApiError).status, 500);
    assert.doesNotMatch((e as ArchiveAssistantApiError).message, /nope/, "upstream body must not leak");
    return true;
  });
});

test("errors: non-JSON and schema-violating bodies are contract violations", async () => {
  const config = getArchiveAssistantConfig(BASE_ENV);

  const notJson = (async () => new Response("<html>ok</html>", { status: 200 })) as unknown as typeof fetch;
  const c1 = createArchiveAssistantClient(config, { mode: "bearer", token: "t" }, { fetchImpl: notJson });
  await assert.rejects(() => c1.getOverview(), ArchiveAssistantContractError);

  const missingField = { ...WORKLOAD, counts: undefined } as unknown;
  const wrongShape = (async () => Response.json(missingField)) as unknown as typeof fetch;
  const c2 = createArchiveAssistantClient(config, { mode: "bearer", token: "t" }, { fetchImpl: wrongShape });
  await assert.rejects(
    () => c2.getWorkload(),
    (e: unknown) => {
      assert.ok(e instanceof ArchiveAssistantContractError);
      assert.match((e as ArchiveAssistantContractError).message, /AssistantWorkload/);
      assert.match((e as ArchiveAssistantContractError).message, /counts/);
      return true;
    },
  );

  const badEnum = {
    ...PLEX_STATE_PARTIAL_FAILURE,
    lastAttemptedRefresh: { ...PLEX_STATE_PARTIAL_FAILURE.lastAttemptedRefresh, status: "exploded" },
  } as unknown;
  const badEnumFetch = (async () => Response.json(badEnum)) as unknown as typeof fetch;
  const c3 = createArchiveAssistantClient(config, { mode: "bearer", token: "t" }, { fetchImpl: badEnumFetch });
  await assert.rejects(() => c3.getProviderRefreshState("plex"), /expected one of/);
});

test("errors: transport abort maps to a bounded timeout error", async () => {
  const config = getArchiveAssistantConfig({ ...BASE_ENV, ARCHIVE_ASSISTANT_TIMEOUT_MS: "5" });
  const slow = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation timed out.", "TimeoutError")),
      );
    })) as unknown as typeof fetch;
  const client = createArchiveAssistantClient(config, { mode: "bearer", token: "t" }, { fetchImpl: slow });
  await assert.rejects(() => client.getOverview(), ArchiveAssistantTimeoutError);
});

/* ----------------------------- read-only proof --------------------------- */

test("no mutation: client surface has no control-plane methods", () => {
  const config = getArchiveAssistantConfig(BASE_ENV);
  const client = createArchiveAssistantClient(config, { mode: "bearer", token: "t" }, { fetchImpl: async () => Response.json({}) });

  const forbidden = ["approve", "reject", "reopen", "execute", "delete", "rename", "move", "download", "sync"];
  for (const key of Object.keys(client)) {
    for (const verb of forbidden) {
      assert.ok(!key.toLowerCase().includes(verb), `client must not expose "${verb}" (found ${key})`);
    }
  }
  assert.deepEqual(
    Object.keys(client).sort(),
    [
      "getFindingLineage",
      "getOverview",
      "getProviderRefreshHistory",
      "getProviderRefreshState",
      "getReconciliationSummary",
      "getWorkload",
    ],
  );
  assert.ok(Object.isFrozen(client));
});

test("no mutation: generated operations are GET-only and source has no write verbs", () => {
  for (const [name, op] of Object.entries(archiveReadOnlyOperations)) {
    assert.equal((op as { method: string }).method, "GET", `${name} must be GET`);
  }
  const source = readFileSync(fileURLToPath(new URL("./client.ts", import.meta.url)), "utf8");
  for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.ok(!source.includes(`"${verb}"`), `client.ts must not reference method ${verb}`);
  }
  assert.ok(
    !/["']x-test-owner-id["']\s*:/.test(source),
    "client.ts must never emit the x-test-owner-id header (mentions in comments are the prohibition docs)",
  );
});
