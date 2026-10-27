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
import type { ProviderRefreshState } from "./generated/types";
import {
  PLEX_AUTHORITY,
  PLEX_ORDINARY_AUTHORITY,
  PLEX_STATE_ORDINARY_AUTHORITY,
  PLEX_STATE_PARTIAL_FAILURE,
} from "./fixtures";

/* The exact scenario from the evaluation matrix lives in fixtures.ts:
 * R17 = PLEX_AUTHORITY (synced/complete/authoritative, 35,890 items),
 * R18 = PLEX_FAILED_PARTIAL_ATTEMPT (sync_error/partial, non-authoritative),
 * trap state = PLEX_STATE_PARTIAL_FAILURE. */
const R17 = PLEX_AUTHORITY;
const TRAP_STATE = PLEX_STATE_PARTIAL_FAILURE;

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

/* ------------------------------------------------------------------------ */
/* Run B — the "ordinary" contrast state (same interrogation, twice)         */
/* ------------------------------------------------------------------------ */

function ordinaryPrompt(): string {
  const facts = buildRefreshFacts(PLEX_STATE_ORDINARY_AUTHORITY);
  const context = {
    generatedAt: "2026-09-18T11:06:00.000Z",
    overview: {},
    workload: {},
    reconciliation: {},
    refresh: { plex: PLEX_STATE_ORDINARY_AUTHORITY, jellyfin: {} },
  } as unknown as ArchiveContext;
  return buildArchiveContextSystemPrompt(context, facts);
}

function factLines(prompt: string): string {
  return prompt.split("\n").filter((l) => l.startsWith("- ")).join("\n");
}

test("ordinary: fixture coherence — r19 occupies every slot of the state", () => {
  assert.equal(PLEX_STATE_ORDINARY_AUTHORITY.lastAttemptedRefresh?.refreshId, "plex-r19");
  assert.equal(PLEX_STATE_ORDINARY_AUTHORITY.lastSuccessfulRefresh?.refreshId, "plex-r19");
  assert.equal(PLEX_STATE_ORDINARY_AUTHORITY.currentAuthoritativeRefresh?.refreshId, "plex-r19");
  assert.equal(PLEX_ORDINARY_AUTHORITY.itemCount, 35802);
  assert.ok((PLEX_AUTHORITY.itemCount ?? 0) > PLEX_ORDINARY_AUTHORITY.itemCount!, "r19 must observe fewer items than r17 for the contrast to exist");
});

test("ordinary: authority fact states current truth with the observed size", () => {
  const facts = buildRefreshFacts(PLEX_STATE_ORDINARY_AUTHORITY);
  assert.equal(facts.length, 1, "attempt and authority agree: exactly one fact");
  assert.match(facts[0].statement, /Plex refresh plex-r19 is authoritative and complete \(35,802 items observed\)\./);
  assert.doesNotMatch(facts[0].statement, /sync_error|incomplete|not authoritative/);
  assert.equal(facts[0].classification, "complete");
  assert.equal(facts[0].evidence.refreshId, "plex-r19");
});

test("differential: the same builder arms materially different evidence per state", () => {
  const trap = factLines(trapPrompt());
  const ordinary = factLines(ordinaryPrompt());

  // Trap state arms the incomplete-observation chain...
  assert.match(trap, /incomplete, not empty/);
  assert.match(trap, /plex-r18 has status sync_error with partial snapshot completeness and is not authoritative/);
  assert.match(trap, /Authority remains refresh plex-r17 \(35,890 items observed\)/);
  assert.match(trap, /refreshId=plex-r17/);
  assert.match(trap, /refreshId=plex-r18/);

  // ...while the ordinary state arms authoritative current truth — with
  // NONE of the trap-scoped language present in the FACT LINES (the safety
  // rules mention those words by design; evidence lines must not).
  assert.doesNotMatch(ordinary, /sync_error/);
  assert.doesNotMatch(ordinary, /partial snapshot/);
  assert.doesNotMatch(ordinary, /incomplete, not empty/);
  assert.doesNotMatch(ordinary, /not authoritative/);
  assert.match(ordinary, /Plex refresh plex-r19 is authoritative and complete \(35,802 items observed\)/);
  assert.match(ordinary, /refreshId=plex-r19/);
  assert.doesNotMatch(ordinary, /refreshId=plex-r17/);

  // Rules are state-independent: the disappearance distinction holds in both.
  for (const prompt of [trapPrompt(), ordinaryPrompt()]) {
    assert.match(prompt, /Absence of an item from an incomplete or non-authoritative snapshot is not evidence/);
    assert.match(prompt, /Only the currentAuthoritativeRefresh snapshot is authoritative/);
  }
});

test("ordinary: no disappearance language is asserted here either — evidence is left to speak", () => {
  for (const claim of DISAPPEARANCE_CLAIMS) {
    assert.doesNotMatch(factLines(ordinaryPrompt()), claim);
  }
});

/* The v2 grading criterion (lab-001): a complete authoritative snapshot
 * licenses "absence from this snapshot" but a DISAPPEARANCE of item X
 * requires presence-then plus authoritative-absence-now. Run-B evidence is
 * deliberately snapshot-level: it must establish trust in r19 while
 * establishing NO item's disappearance. Locking that here makes bench
 * failure attribution deterministic — if the real model names a specific
 * vanished item, the evidence block is provably not where it came from. */
test("attribution: ordinary evidence is snapshot-level — it licenses trust in r19, not any item's disappearance", () => {
  const lines = factLines(ordinaryPrompt()).split("\n");

  // Every mention of the current authority lives in exactly one aggregate
  // fact about the snapshot itself (count + completeness + authority).
  const r19Lines = lines.filter((l) => l.includes("plex-r19"));
  assert.equal(r19Lines.length, 1, "r19 appears in exactly the aggregate authority fact");
  assert.match(
    r19Lines[0],
    /Plex refresh plex-r19 is authoritative and complete \(35,802 items observed\)/,
  );

  // No per-item absence statement about any refresh exists anywhere in the
  // delivered evidence.
  const PER_ITEM_ABSENCE = [
    /absent from/i,
    /missing from/i,
    /not present in/i,
    /no longer in/i,
    /removed from/i,
  ];
  for (const line of lines) {
    for (const claim of PER_ITEM_ABSENCE) {
      assert.doesNotMatch(line, claim, `evidence must establish no per-item absence: ${line}`);
    }
  }
});
