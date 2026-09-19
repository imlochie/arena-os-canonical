/**
 * Gate 7, slice 7.2 tests: restatement + aggregation synthesizers.
 *
 * The mandate (owner): 7.2 may not be smarter than 7.1. It performs
 * bounded arithmetic and faithful re-voicing only —
 *
 *   "The archive records 4 plays."
 *       →  "The archive records 12 plays across these three observations."
 *
 * and never the semantic crossings ("you like this", "favourite",
 * "increasing interest"). The claim payloads here are STRUCTURAL data for
 * the (later) renderer: evidenceClass / subject / value / count / sum /
 * subjects / members — no prose, no affect, no trend vocabulary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReasoningRejectError } from "./lattice";
import {
  aggregateEvidence,
  restateEvidence,
} from "./synthesizers";
import { canonicalWire, emptyWire } from "../personalisation/fixtures";
import { normalizePersonalisationContext } from "../personalisation/context";
import type { PersonalisationContext } from "../personalisation/generated/types";

function packOf(wire: unknown = canonicalWire()) {
  return normalizePersonalisationContext(wire as PersonalisationContext);
}

const WINDOW_30D = { label: "rolling_30d", startsAt: "2026-08-20T00:00:00.000Z", endsAt: "2026-09-19T00:00:00.000Z" };
const WINDOW_ALL = { label: "all_ingested" };

/* ------------------------------ restatement ------------------------------ */

test("7.2 restatement: faithful re-voicing of one item — class, subject, value verbatim", () => {
  const pack = packOf();
  const c = restateEvidence(pack, { collection: "temporalSignals", index: 0 }, { window: WINDOW_30D });
  assert.equal(c.kind, "restatement");
  assert.equal(c.epistemicStatus, "derived"); // computed ceiling = the item's own status
  assert.equal(c.scopeIdentity, "plex:account-main:tv"); // derived from the item's declared scope
  assert.deepEqual(c.window, WINDOW_30D);
  assert.deepEqual(c.claim, {
    restates: { collection: "temporalSignals", index: 0 },
    evidenceClass: "temporal_signal",
    subject: "show:example-show",
    value: { playsLast30d: 4, playsLast90d: 7,
      window: { startsAt: "2026-08-20T05:00:00.000Z", endsAt: "2026-09-19T05:00:00.000Z" } },
  });
  assert.equal(c.derivation.rule, "restate.v1");
});

test("7.2 restatement: observed fact keeps observed status; unknown fact is void (no positive slippage)", () => {
  const pack = packOf();
  const observed = restateEvidence(pack, { collection: "facts", index: 0 }, {
    window: WINDOW_ALL,
    scopeIdentity: "archive",
  });
  assert.equal(observed.epistemicStatus, "observed");
  assert.equal(observed.claim.subject, "total_plays");

  assert.throws(
    () => restateEvidence(pack, { collection: "facts", index: 3 }, { window: WINDOW_ALL, scopeIdentity: "archive" }),
    (error: unknown) => error instanceof ReasoningRejectError
      && (error as ReasoningRejectError).rejectKind === "void_claim",
  );
});

test("7.2 restatement: no affect or preference nouns exist anywhere in the claim payload", () => {
  const pack = packOf();
  for (const ref of [
    { collection: "observedSignals", index: 0 },
    { collection: "observedSignals", index: 1 },
    { collection: "collectionFacts", index: 0 },
  ] as const) {
    const c = restateEvidence(pack, ref, { window: WINDOW_ALL });
    const json = JSON.stringify(c.claim);
    for (const noun of ["like", "enjoy", "love", "prefer", "favourite", "favorite", "taste", "interest", "score", "rank"]) {
      assert.ok(!json.toLowerCase().includes(noun), `restatement claim must not contain "${noun}"`);
    }
  }
});

/* ------------------------------ aggregation ------------------------------ */

test("7.2 aggregation count: same-class members over one window; ceiling is the minimum member status", () => {
  const pack = packOf();
  const c = aggregateEvidence(pack, [
    { collection: "observedSignals", index: 0 },
    { collection: "observedSignals", index: 1 },
  ], { mode: "count", window: WINDOW_ALL });
  assert.equal(c.kind, "aggregation");
  assert.deepEqual(c.claim, {
    mode: "count",
    count: 2,
    members: [
      { collection: "observedSignals", index: 0 },
      { collection: "observedSignals", index: 1 },
    ],
  });
  assert.equal(c.epistemicStatus, "derived"); // both members derived
  assert.equal(c.scopeIdentity, "plex:account-main:tv");
});

test("7.2 aggregation sum: finite numeric values add up; ceiling drops with the weakest member", () => {
  const pack = packOf();
  // facts[0] observed 412 + facts[1] derived 87 → 499, ceiling derived.
  const c = aggregateEvidence(pack, [
    { collection: "facts", index: 0 },
    { collection: "facts", index: 1 },
  ], { mode: "sum", window: WINDOW_ALL, scopeIdentity: "archive" });
  assert.equal(c.claim.mode, "sum");
  assert.equal((c.claim as { sum: number }).sum, 499);
  assert.equal(c.epistemicStatus, "derived");

  // Including the coverage-limited fact is legitimate — and the ceiling
  // says exactly what that inclusion costs.
  const limited = aggregateEvidence(pack, [
    { collection: "facts", index: 0 },
    { collection: "facts", index: 2 },
  ], { mode: "count", window: WINDOW_ALL, scopeIdentity: "archive" });
  assert.equal(limited.epistemicStatus, "coverage-limited");
});

test("7.2 aggregation sum: a non-numeric member rejects the sum (no silent skipping, no zero-filling)", () => {
  const pack = packOf();
  // facts[2] has value {} — nothing numeric is there, and nothing is invented.
  assert.throws(
    () => aggregateEvidence(pack, [
      { collection: "facts", index: 0 },
      { collection: "facts", index: 2 },
    ], { mode: "sum", window: WINDOW_ALL, scopeIdentity: "archive" }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "void_claim",
  );
});

test("7.2 aggregation: mixed collections are rejected as mixed_class — same-class is structural", () => {
  const pack = packOf();
  assert.throws(
    () => aggregateEvidence(pack, [
      { collection: "observedSignals", index: 1 },
      { collection: "observedSignals", index: 0 },
      { collection: "temporalSignals", index: 0 },
    ], { mode: "subjects", window: WINDOW_ALL }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "mixed_class",
  );

  // The proper subjects aggregation over one collection:
  const ok = aggregateEvidence(pack, [
    { collection: "observedSignals", index: 1 },
    { collection: "observedSignals", index: 0 },
  ], { mode: "subjects", window: WINDOW_ALL });
  const claim = ok.claim as { subjects: readonly string[]; count: number };
  assert.deepEqual(claim.subjects, ["show:example-show"]); // deduped, sorted
  assert.equal(claim.count, 2); // members count, not subject count
});

test("7.2 aggregation: cross-scope evidence refuses (no scope creep via aggregation)", () => {
  const wire = {
    ...emptyWire(),
    observedSignals: [
      {
        ...canonicalWire().observedSignals[0],
        scopeIdentity: "plex:account-main:tv",
      },
      {
        ...canonicalWire().observedSignals[0],
        signalId: "sig-other-scope",
        scopeIdentity: "jellyfin:account-main:tv",
      },
    ],
  };
  const pack = packOf(wire);
  assert.throws(
    () => aggregateEvidence(pack, [
      { collection: "observedSignals", index: 0 },
      { collection: "observedSignals", index: 1 },
    ], { mode: "count", window: WINDOW_ALL }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "scope_merge",
  );
});

test("7.2 aggregation: empty membership, determinism, and frozen output", () => {
  const pack = packOf();
  assert.throws(
    () => aggregateEvidence(pack, [], { mode: "count", window: WINDOW_ALL }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "lineage_incomplete",
  );

  const args = [
    { collection: "observedSignals", index: 0 },
    { collection: "observedSignals", index: 1 },
  ] as const;
  const a = aggregateEvidence(pack, [...args], { mode: "subjects", window: WINDOW_ALL });
  const b = aggregateEvidence(pack, [...args], { mode: "subjects", window: WINDOW_ALL });
  assert.deepEqual(a, b);
  assert.ok(Object.isFrozen(a.claim));
  assert.ok(Object.isFrozen((a.claim as { members: readonly unknown[] }).members));

  // Unknown-grounded members still void a positive aggregation (C2 end-to-end).
  assert.throws(
    () => aggregateEvidence(pack, [
      { collection: "facts", index: 0 },
      { collection: "facts", index: 3 },
    ], { mode: "count", window: WINDOW_ALL, scopeIdentity: "archive" }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "void_claim",
  );
});
