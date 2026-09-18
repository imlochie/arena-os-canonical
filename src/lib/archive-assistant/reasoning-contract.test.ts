/**
 * Reasoning-contract test: the disappearance trap.
 *
 * The evaluation matrix's killer scenario, made deterministic WITHOUT any
 * model: when a complete authoritative refresh (r17, 35,890 items) is
 * followed by a partial non-authoritative failure (r18), the evidence block
 * handed to the reasoner must arm the correct reasoning chain:
 *
 *   r18 is incomplete
 *     → r18 is not authoritative
 *     → r17 (35,890 items observed) remains authoritative
 *     → absence from r18 is not evidence of archive absence
 *     → investigate the incomplete refresh
 *
 * and must never itself assert a disappearance.
 *
 * The scenario is also exactly what a hostile reviewer checks last:
 * "Is this an action I should take?" must meet a prompt that forbids
 * action directives outright.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRefreshFacts } from "./context";
import { buildArchiveContextSystemPrompt } from "./prompt";
import type { ArchiveContext } from "./types";
import type { ProviderRefresh, ProviderRefreshState } from "./generated/types";

/* The exact scenario from the evaluation matrix. */
const R17: ProviderRefresh = {
  refreshId: "plex-r17",
  provider: "plex",
  startedAt: "2026-09-17T02:00:00.000Z",
  completedAt: "2026-09-17T02:04:00.000Z",
  status: "synced",
  snapshotCompleteness: "complete",
  itemCount: 35890,
  authoritative: true,
  reason: null,
  snapshotReference: "snap-r17",
};

const R18: ProviderRefresh = {
  refreshId: "plex-r18",
  provider: "plex",
  startedAt: "2026-09-18T02:00:00.000Z",
  completedAt: "2026-09-18T02:01:00.000Z",
  status: "sync_error",
  snapshotCompleteness: "partial",
  itemCount: null,
  authoritative: false,
  reason: "connection lost mid-fetch",
  snapshotReference: null,
};

const TRAP_STATE: ProviderRefreshState = {
  provider: "plex",
  lastAttemptedRefresh: R18,
  lastSuccessfulRefresh: R17,
  currentAuthoritativeRefresh: R17,
};

const DISAPPEARANCE_CLAIMS = [
  /items? (?:have|has) disappeared/i,
  /(?:were|was|are|is) (?:deleted|removed|gone)/i,
  /no longer (?:present|exists?|available)/i,
  /lost (?:your |the )?(?:items?|media|files?)/i,
];

function trapPrompt(): string {
  const facts = buildRefreshFacts(TRAP_STATE);
  const context = {
    generatedAt: "2026-09-18T02:05:00.000Z",
    overview: {},
    workload: {},
    reconciliation: {},
    refresh: { plex: TRAP_STATE, jellyfin: {} },
  } as unknown as ArchiveContext;
  return buildArchiveContextSystemPrompt(context, facts);
}

test("trap: facts encode the full authority chain, with item counts", () => {
  const facts = buildRefreshFacts(TRAP_STATE);

  const interpretation = facts.find((f) => f.subjectId === "plex");
  assert.ok(interpretation);
  assert.match(interpretation.statement, /incomplete, not empty/);
  assert.match(interpretation.statement, /Authority remains refresh plex-r17 \(35,890 items observed\)\./);
  assert.equal(interpretation.evidence.refreshId, "plex-r17");

  const attempt = facts.find((f) => f.subjectId === "plex:plex-r18");
  assert.ok(attempt);
  assert.match(attempt.statement, /status sync_error/);
  assert.match(attempt.statement, /partial snapshot completeness/);
  assert.match(attempt.statement, /not authoritative/);
  assert.equal(attempt.evidence.refreshId, "plex-r18");

  for (const claim of DISAPPEARANCE_CLAIMS) {
    for (const fact of facts) {
      assert.doesNotMatch(fact.statement, claim, `fact must not assert disappearance: ${fact.statement}`);
    }
  }
});

test("trap: the prompt handed to the reasoner arms the correct chain", () => {
  const prompt = trapPrompt();

  // Step 1+2: r18 is incomplete and not authoritative — as a cited fact.
  assert.match(prompt, /plex-r18 has status sync_error with partial snapshot completeness and is not authoritative\./);
  // Step 3: r17 remains authoritative, with the 35,890-item snapshot cited.
  assert.match(prompt, /Authority remains refresh plex-r17 \(35,890 items observed\)\./);
  // Citations a correct answer can be traced to.
  assert.match(prompt, /refreshId=plex-r17/);
  assert.match(prompt, /refreshId=plex-r18/);
  // Step 4: the connective rule is stated, not implied.
  assert.match(prompt, /Absence of an item from an incomplete or non-authoritative snapshot is not evidence that the item is absent from the archive/);
  // Step 5: uncertainty must be surfaced, not papered over.
  assert.match(prompt, /If evidence is missing, say so explicitly instead of guessing/);

  for (const claim of DISAPPEARANCE_CLAIMS) {
    assert.doesNotMatch(prompt, claim, `prompt must not assert disappearance (${claim})`);
  }
});

test("trap: the boundary row — the prompt forbids action directives", () => {
  const prompt = trapPrompt();
  assert.match(prompt, /you own interpretation and explanation only/i);
  assert.match(prompt, /Do not claim to have changed the archive/);
  assert.match(prompt, /Do not execute, schedule, or promise filesystem, provider, review, or approval operations/);
  assert.match(prompt, /Do not issue action directives/);
  assert.match(prompt, /approve this operation/);
  assert.match(prompt, /they decide/);
});

test("trap: a complete+authoritative latest state carries the observed size too", () => {
  const settled: ProviderRefreshState = {
    provider: "plex",
    lastAttemptedRefresh: R17,
    lastSuccessfulRefresh: R17,
    currentAuthoritativeRefresh: R17,
  };
  const facts = buildRefreshFacts(settled);
  assert.equal(facts.length, 1, "no divergence fact when attempt and authority agree");
  assert.match(facts[0].statement, /Plex refresh plex-r17 is authoritative and complete \(35,890 items observed\)\./);
  assert.doesNotMatch(facts[0].statement, /incomplete|not authoritative|attempt failed/);
});
