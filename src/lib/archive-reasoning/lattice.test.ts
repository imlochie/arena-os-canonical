/**
 * Gate 7, slice 7.1 tests: the epistemic lattice, executable.
 *
 * The calculus rules under test (docs/archive-reasoning-layer.md §2):
 *
 *   C1 · ceiling — a conclusion's status is the MINIMUM of its
 *        load-bearing evidence statuses;
 *   C2 · unknown ground — no positive claim may stand on `unknown`;
 *   C3 · coverage inheritance — windows are never merged; scopes never
 *        exceed their evidence;
 *   C4 · provenance completeness — no lineage, no conclusion;
 *   C5 · no new nouns — evidence references stay within the seven
 *        evidence collections of the frozen pack.
 *
 * Plus the type-system tripwires: the conclusion envelope and the
 * closed category unions must resist silent extension (a seventh kind,
 * an eighth collection, a spare key on the envelope).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildConclusion,
  minStatus,
  rankStatus,
  statusOf,
  unionWindow,
  windowIdentity,
  ReasoningRejectError,
  CONCLUSION_KINDS,
  EVIDENCE_COLLECTION_KEYS,
} from "./lattice";
import {
  canonicalWire,
  minimalWire,
} from "../personalisation/fixtures";
import { normalizePersonalisationContext } from "../personalisation/context";
import type { PersonalisationContext } from "../personalisation/generated/types";

function packOf(wire: unknown = canonicalWire()) {
  return normalizePersonalisationContext(wire as PersonalisationContext);
}

const WINDOW_30D = { label: "rolling_30d", startsAt: "2026-08-20T00:00:00.000Z", endsAt: "2026-09-19T00:00:00.000Z" };
const WINDOW_ALL = { label: "all_ingested" };

/* ------------------------------ C1 · ceiling ----------------------------- */

test("7.1 lattice: status ranks are ordered observed > derived > coverage-limited > unknown", () => {
  assert.ok(rankStatus("observed") > rankStatus("derived"));
  assert.ok(rankStatus("derived") > rankStatus("coverage-limited"));
  assert.ok(rankStatus("coverage-limited") > rankStatus("unknown"));
});

test("7.1 lattice: minStatus returns the least certain element; duplicates and order are irrelevant", () => {
  assert.equal(minStatus(["observed"]), "observed");
  assert.equal(minStatus(["coverage-limited", "observed", "derived"]), "coverage-limited");
  assert.equal(minStatus(["derived", "derived"]), "derived");
  assert.equal(minStatus(["unknown", "observed", "derived", "coverage-limited"]), "unknown");
  assert.equal(minStatus(["observed", "derived", "derived"]), "derived");
});

test("7.1 lattice: the ceiling of a conclusion is computed, never supplied", () => {
  const pack = packOf();
  // Load-bearing: an observed fact + a derived signal → ceiling is derived.
  const conclusion = buildConclusion({
    kind: "restatement",
    pack,
    rule: "restate.v1",
    loadBearing: [
      { collection: "facts", index: 0 },
      { collection: "temporalSignals", index: 0 },
    ],
    window: WINDOW_30D,
    claim: { activity: "present", windowKey: windowIdentity(WINDOW_30D) },
  });
  assert.equal(conclusion.epistemicStatus, "derived");
  // And the builder's job spec: no `status` argument exists to pass —
  // callers cannot nominate a ceiling (type-level; runtime assert below).
  assert.deepEqual(Object.keys(conclusion).sort(), [
    "claim",
    "derivation",
    "epistemicStatus",
    "kind",
    "scopeIdentity",
    "window",
  ]);
});

/* ---------------------- C2 · unknown ground → no claim ------------------- */

test("7.1 lattice: a positive kind standing on unknown evidence is void", () => {
  const pack = packOf();
  // facts[3] carries epistemicStatus "unknown" in the canonical pack.
  assert.throws(
    () =>
      buildConclusion({
        kind: "restatement",
        pack,
        rule: "restate.v1",
        loadBearing: [{ collection: "facts", index: 3 }],
        scopeIdentity: "archive",
        window: WINDOW_ALL,
        claim: { watchlistPresence: "asserted" },
      }),
    (error: unknown) => error instanceof ReasoningRejectError
      && (error as ReasoningRejectError).rejectKind === "void_claim",
  );
});

test("7.1 lattice: unknown-grounded material is legitimate only as an open uncertainty", () => {
  const pack = packOf();
  const uncertainty = buildConclusion({
    kind: "absence_qualified",
    pack,
    rule: "qualify.v1",
    loadBearing: [{ collection: "facts", index: 3 }],
    scopeIdentity: "archive",
    window: WINDOW_ALL,
    claim: { open: "watchlist_presence" },
  });
  assert.equal(uncertainty.epistemicStatus, "unknown");
  assert.equal(uncertainty.kind, "absence_qualified");
});

/* -------------------- C3 · no window merge, no scope creep ---------------- */

test("7.1 lattice: windows union only when identical; differing windows refuse silently-merged claims", () => {
  assert.deepEqual(unionWindow([WINDOW_30D, { ...WINDOW_30D }]), WINDOW_30D);
  assert.deepEqual(unionWindow([WINDOW_ALL]), WINDOW_ALL);
  assert.throws(
    () => unionWindow([WINDOW_30D, { ...WINDOW_30D, endsAt: "2026-09-18T00:00:00.000Z" }]),
    (error: unknown) => error instanceof ReasoningRejectError
      && (error as ReasoningRejectError).rejectKind === "window_merge",
  );
  assert.throws(
    () => unionWindow([WINDOW_30D, WINDOW_ALL]),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "window_merge",
  );
  // Window identity is content-based, not order-based.
  assert.equal(
    windowIdentity({ endsAt: WINDOW_30D.endsAt, label: WINDOW_30D.label, startsAt: WINDOW_30D.startsAt }),
    windowIdentity(WINDOW_30D),
  );
});

test("7.1 lattice: a conclusion cannot claim more scope than its evidence declares", () => {
  const pack = packOf();
  // The canonical signals declare scope plex:account-main:tv.
  assert.throws(
    () =>
      buildConclusion({
        kind: "aggregation",
        pack,
        rule: "aggregate.v1",
        scopeIdentity: "plex:account-main:all",
        loadBearing: [{ collection: "observedSignals", index: 0 }],
        window: WINDOW_ALL,
        claim: { subjectCount: 1 },
      }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "scope_merge",
  );
  // Matching scope is accepted and recorded.
  const scoped = buildConclusion({
    kind: "aggregation",
    pack,
    rule: "aggregate.v1",
    loadBearing: [
      { collection: "observedSignals", index: 0 },
      { collection: "observedSignals", index: 1 },
    ],
    window: WINDOW_ALL,
    claim: { subjectCount: 2 },
  });
  assert.equal(scoped.scopeIdentity, "plex:account-main:tv");
});

/* ----------------------- C4 · no lineage, no conclusion ------------------- */

test("7.1 lattice: empty load-bearing, dangling refs, and mismatched signalIds are all rejected", () => {
  const pack = packOf();
  assert.throws(
    () => buildConclusion({
      kind: "restatement", pack, rule: "restate.v1",
      loadBearing: [], window: WINDOW_ALL, claim: {},
    }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "lineage_incomplete",
  );
  assert.throws(
    () => buildConclusion({
      kind: "restatement", pack, rule: "restate.v1",
      loadBearing: [{ collection: "observedSignals", index: 99 }],
      window: WINDOW_ALL, claim: {},
    }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "bad_reference",
  );
  assert.throws(
    () => buildConclusion({
      kind: "restatement", pack, rule: "restate.v1",
      loadBearing: [{ collection: "observedSignals", index: 0, signalId: "sig-WRONG" }],
      window: WINDOW_ALL, claim: {},
    }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "bad_reference",
  );
  assert.throws(
    () => buildConclusion({
      kind: "restatement", pack, rule: "", // no named rule, no derivation path
      loadBearing: [{ collection: "facts", index: 0 }],
      window: WINDOW_ALL, claim: {},
    }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "lineage_incomplete",
  );
});

/* ---------------- C5 · categories stay closed (tripwires) ----------------- */

test("7.1 tripwires: five conclusion kinds, seven evidence collections, no silent seventh", () => {
  assert.equal(CONCLUSION_KINDS.length, 5);
  assert.deepEqual([...CONCLUSION_KINDS].sort(), [
    "absence_qualified",
    "aggregation",
    "contradiction",
    "restatement",
    "temporal_synthesis",
  ]);
  assert.equal(EVIDENCE_COLLECTION_KEYS.length, 7);
  // constraints are transport constraints, never load-bearing evidence.
  assert.ok(!EVIDENCE_COLLECTION_KEYS.includes("constraints" as never));
});

/* -------------------- never-upgrade, determinism, freeze ------------------ */

test("7.1 lattice: missing epistemicStatus on evidence floors to unknown — it is never upgraded", () => {
  assert.equal(statusOf({ epistemicStatus: "derived" }), "derived");
  assert.equal(statusOf({}), "unknown");
  assert.equal(statusOf({ epistemicStatus: "confirmed" }), "unknown");
  // And end-to-end: an explicitPreferences item (no status field in the
  // current contract) cannot ground a positive claim yet.
  const pack = packOf();
  assert.throws(
    () => buildConclusion({
      kind: "restatement", pack, rule: "restate.v1",
      loadBearing: [{ collection: "explicitPreferences", index: 0 }],
      scopeIdentity: "archive",
      window: WINDOW_ALL, claim: { preference: "recorded" },
    }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "void_claim",
  );
});

test("7.1 lattice: conclusions are deterministic and frozen", () => {
  const pack = packOf();
  const args = {
    kind: "restatement" as const,
    pack,
    rule: "restate.v1",
    loadBearing: [{ collection: "temporalSignals" as const, index: 0 }],
    window: WINDOW_30D,
    claim: { activity: "present", windowKey: windowIdentity(WINDOW_30D) },
  };
  const a = buildConclusion(args);
  const b = buildConclusion(args);
  assert.deepEqual(a, b); // no clocks, no randomness in the calculus
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.derivation));
  assert.ok(Object.isFrozen(a.derivation.loadBearing));

  // Minimal-pack honesty: an unknown-only pack still yields its
  // uncertainty without touching positive kinds.
  const minimal = packOf(minimalWire());
  assert.doesNotThrow(() =>
    buildConclusion({
      kind: "absence_qualified",
      pack: minimal,
      rule: "qualify.v1",
      loadBearing: [{ collection: "uncertainties", index: 0 }],
      scopeIdentity: "archive",
      window: WINDOW_ALL,
      claim: { open: "delivery_carries_no_statused_evidence" },
    }),
  );
});
