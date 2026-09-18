/**
 * Compatibility tests: Archive context normalizer.
 *
 * The semantics under test are the spec's correctness core:
 *   - lastAttemptedRefresh != lastSuccessfulRefresh leaves authority intact;
 *   - sync_error + partial  → INCOMPLETE observation, never "empty";
 *   - sync_error + unknown  → FAILED observation, provider contents UNKNOWN,
 *     never "absent";
 *   - lineage: workload.reviewItemId → currentObservationId / refreshId /
 *     snapshotReference, with the prior observation marked superseded.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildArchiveContext,
  buildFindingLineageFacts,
  buildRefreshFacts,
  buildReconciliationFact,
  buildWorkloadFacts,
  classifyRefreshAttempt,
  summarizeRefresh,
} from "./context";
import type { ArchiveContextClient } from "./types";
import {
  JELLYFIN_FAILED_UNKNOWN_ATTEMPT,
  JELLYFIN_STATE_FAILED_UNKNOWN,
  LINEAGE,
  OVERVIEW,
  PLEX_AUTHORITY,
  PLEX_FAILED_PARTIAL_ATTEMPT,
  PLEX_HISTORY,
  JELLYFIN_HISTORY,
  PLEX_STATE_PARTIAL_FAILURE,
  RECONCILIATION_REPORT,
  WORKLOAD,
} from "./fixtures";
import type { ProviderRefreshState } from "./generated/types";

/* --------------------------- attempt classification --------------------- */

test("classify: synced+complete is complete; syncing is in_progress", () => {
  assert.equal(classifyRefreshAttempt(PLEX_AUTHORITY), "complete");
  assert.equal(
    classifyRefreshAttempt({ ...PLEX_FAILED_PARTIAL_ATTEMPT, status: "syncing", snapshotCompleteness: "unknown" }),
    "in_progress",
  );
  assert.equal(classifyRefreshAttempt(null), "never_attempted");
});

test("classify: sync_error+partial is incomplete; sync_error+unknown is failed", () => {
  assert.equal(classifyRefreshAttempt(PLEX_FAILED_PARTIAL_ATTEMPT), "incomplete");
  assert.equal(classifyRefreshAttempt(JELLYFIN_FAILED_UNKNOWN_ATTEMPT), "failed");
});

/* ------------------------------ refresh state --------------------------- */

test("refresh semantics: failed attempt does not move authority", () => {
  const semantics = summarizeRefresh(PLEX_STATE_PARTIAL_FAILURE);
  assert.equal(semantics.lastAttempt, "incomplete");
  assert.equal(semantics.attemptedRefreshId, "plex-r18");
  assert.equal(semantics.lastSuccessfulRefreshId, "plex-r17");
  assert.equal(semantics.authorityRefreshId, "plex-r17");
  assert.ok(semantics.authoritativeComplete);

  // The interpretation must NOT treat the partial failure as emptiness.
  assert.match(semantics.interpretation, /incomplete, not empty/);
  assert.doesNotMatch(semantics.interpretation, /absent/);
});

test("refresh semantics: sync_error+unknown reads as failed, contents unknown", () => {
  const semantics = summarizeRefresh(JELLYFIN_STATE_FAILED_UNKNOWN);
  assert.equal(semantics.lastAttempt, "failed");
  assert.equal(semantics.authorityRefreshId, "jf-r08");
  assert.match(semantics.interpretation, /unknown, not absent/);
  assert.match(semantics.interpretation, /Authority remains refresh jf-r08/);
});

test("refresh semantics: a never-refreshed provider is explicit about knowing nothing", () => {
  const empty: ProviderRefreshState = {
    provider: "plex",
    lastAttemptedRefresh: null,
    lastSuccessfulRefresh: null,
    currentAuthoritativeRefresh: null,
  };
  const semantics = summarizeRefresh(empty);
  assert.equal(semantics.lastAttempt, "never_attempted");
  assert.equal(semantics.authorityRefreshId, null);
  assert.ok(!semantics.authoritativeComplete);
  assert.match(semantics.interpretation, /nothing is known/);
});

test("refresh semantics: synced attempt pinned as authority states it plainly", () => {
  const state: ProviderRefreshState = {
    provider: "plex",
    lastAttemptedRefresh: PLEX_AUTHORITY,
    lastSuccessfulRefresh: PLEX_AUTHORITY,
    currentAuthoritativeRefresh: PLEX_AUTHORITY,
  };
  const semantics = summarizeRefresh(state);
  assert.equal(semantics.lastAttempt, "complete");
  assert.equal(semantics.authorityRefreshId, "plex-r17");
  assert.match(
    semantics.interpretation,
    /Plex refresh plex-r17 is authoritative and complete \(35,890 items observed\)\./,
  );
});

test("refresh facts: attempt divergence is a separately citable fact", () => {
  const facts = buildRefreshFacts(PLEX_STATE_PARTIAL_FAILURE);
  assert.equal(facts.length, 2);
  const [authority, attempt] = facts;
  assert.equal(authority.source, "provider_refresh");
  assert.equal(authority.evidence.refreshId, "plex-r17");
  assert.equal(attempt.classification, "incomplete");
  assert.equal(attempt.evidence.refreshId, "plex-r18");
  assert.match(attempt.statement, /not authoritative/);
});

/* -------------------------------- workload ------------------------------ */

test("workload facts: items carry observation/refresh/evidence handles", () => {
  const { facts, truncated } = buildWorkloadFacts(WORKLOAD);
  assert.ok(!truncated);
  const first = facts.find((f) => f.subjectId === "wl-101");
  assert.ok(first, "needs_you item must sort first");
  assert.equal(first.source, "workload");
  assert.equal(first.classification, "quality_conflict");
  assert.deepEqual(first.evidence, {
    observationId: 9001,
    refreshId: "plex-r17",
    evidenceKey: "ek-abc-1",
    observedAt: "2026-09-17T10:01:00.000Z",
  });
  assert.match(first.statement, /prior observation 8800 was superseded/);

  const second = facts.find((f) => f.subjectId === "wl-102");
  assert.deepEqual(second?.evidence ?? null, {}, "items without handles cite no evidence");
});

test("workload facts: needs_you sorts ahead of waiting; output is bounded", () => {
  const states = buildWorkloadFacts(WORKLOAD).facts.map((f) => f.statement);
  assert.ok(states[0].startsWith("[needs_you]"));

  const many = {
    ...WORKLOAD,
    items: Array.from({ length: 120 }, (_, i) => ({ ...WORKLOAD.items[0], id: `wl-${i}` })),
  };
  const { facts, truncated } = buildWorkloadFacts(many);
  assert.equal(facts.length, 50);
  assert.ok(truncated);
});

test("reconciliation fact is a single cited summary, not raw rows", () => {
  const fact = buildReconciliationFact(RECONCILIATION_REPORT.summary);
  assert.equal(fact.source, "reconciliation");
  assert.match(fact.statement, /880 matched/);
  assert.match(fact.statement, /5 quality conflicts/);
  assert.doesNotMatch(fact.statement, /fileRecordId|ratingKey/);
});

/* -------------------------------- lineage ------------------------------- */

test("lineage facts: current truth, superseded prior, provider linkage", () => {
  const facts = buildFindingLineageFacts(LINEAGE);

  const current = facts.find((f) => f.classification === "quality_conflict");
  assert.ok(current);
  assert.match(current.statement, /current finding is quality_conflict/);
  assert.equal(current.evidence.observationId, 9001);
  assert.equal(current.evidence.evidenceKey, "ek-abc-1");

  const prior = facts.find((f) => f.classification === "superseded_observation");
  assert.ok(prior);
  assert.match(prior.statement, /prior observation 8800 was superseded/);
  assert.match(prior.statement, /historical evidence, not current truth/);

  const provider = facts.find((f) => f.classification === "provider_evidence");
  assert.ok(provider);
  assert.equal(provider.evidence.refreshId, "plex-r17");
  assert.match(provider.statement, /snapshot snap-plex-17/);
});

test("lineage facts: a finding without history still speaks explicitly", () => {
  const facts = buildFindingLineageFacts({
    ...LINEAGE,
    currentObservation: null,
    previousObservation: null,
    provider: null,
  });
  assert.equal(facts.length, 1);
  assert.match(facts[0].statement, /no active observation/);
});

/* ------------------------------ full assembly ---------------------------- */

function fakeClient(): ArchiveContextClient {
  return {
    getOverview: async () => OVERVIEW,
    getWorkload: async () => WORKLOAD,
    getReconciliationSummary: async () => RECONCILIATION_REPORT.summary,
    getFindingLineage: async () => LINEAGE,
    getProviderRefreshState: async (provider) =>
      provider === "plex" ? PLEX_STATE_PARTIAL_FAILURE : JELLYFIN_STATE_FAILED_UNKNOWN,
    getProviderRefreshHistory: async (provider) => (provider === "plex" ? PLEX_HISTORY : JELLYFIN_HISTORY),
  };
}

test("assembly: six-part context with normalized facts, spec shape", async () => {
  const { context, facts, factsTruncated } = await buildArchiveContext(fakeClient());

  // ArchiveContext stays spec-pure.
  assert.deepEqual(Object.keys(context).sort(), ["generatedAt", "overview", "reconciliation", "refresh", "workload"].sort());
  assert.equal(context.reconciliation.matchedCount, 880);
  assert.equal(context.refresh.plex.currentAuthoritativeRefresh?.refreshId, "plex-r17");
  assert.equal(context.refresh.jellyfin.currentAuthoritativeRefresh?.refreshId, "jf-r08");
  assert.ok(Date.parse(context.generatedAt));
  assert.ok(!factsTruncated);

  // Facts span all four sources a context answer may cite (lineage facts are
  // minted by the lineage route, not the context assembly).
  const sources = new Set(facts.map((f) => f.source));
  assert.deepEqual([...sources].sort(), ["provider_refresh", "reconciliation", "workload"]);

  for (const fact of facts) {
    assert.ok(fact.statement.length > 0);
    assert.ok(["workload", "reconciliation", "provider_refresh", "finding_lineage"].includes(fact.source));
  }
});

test("assembly: refresh history is opt-in and bounded", async () => {
  let historyCalls = 0;
  const client = fakeClient();
  const counting: ArchiveContextClient = {
    ...client,
    getProviderRefreshHistory: async (provider, options) => {
      historyCalls++;
      assert.ok((options?.pageSize ?? 10) <= 25);
      return client.getProviderRefreshHistory(provider, options);
    },
  };

  const without = await buildArchiveContext(counting);
  assert.equal(historyCalls, 0);
  assert.equal(without.refreshHistory, undefined);

  const withHistory = await buildArchiveContext(counting, { includeHistory: true, historyPageSize: 5 });
  assert.equal(historyCalls, 2);
  assert.equal(withHistory.refreshHistory?.plex?.results[0].refreshId, "plex-r18");
  assert.equal(withHistory.refreshHistory?.jellyfin?.results[0].refreshId, "jf-r09");
});
