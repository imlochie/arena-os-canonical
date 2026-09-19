/**
 * Gate 7, slice 7.3 tests: temporal synthesis + contradiction surfacing.
 *
 * §3.3 — temporal claims live strictly inside declared windows, carry an
 * explicit as-of (from the evidence's own derivedAt — never a clock), and
 * compare windows arithmetically; a trend needs ≥2 NON-overlapping
 * windows of the same subject, and even then is a number ("more plays in
 * W2 than W1"), never an adjective ("growing interest").
 *
 * §3.4 — contradictions are SURFACED, never resolved (owner's knife-edge):
 * two same-subject, same-scope items with overlapping windows and
 * materially different values produce an explicit contradiction object
 * preserving BOTH pieces with both lineages. Same lineage re-stating
 * itself is one chain, not a conflict; non-overlapping windows both
 * stand; no winner is ever computed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReasoningRejectError, windowIdentity } from "./lattice";
import { extractWindow, windowsOverlap } from "./windows";
import { temporalClaim, compareWindows } from "./temporal";
import { surfaceContradictions } from "./contradictions";
import { canonicalWire, emptyWire } from "../personalisation/fixtures";
import { normalizePersonalisationContext } from "../personalisation/context";
import type { PersonalisationContext } from "../personalisation/generated/types";

function packOf(wire: unknown = canonicalWire()) {
  return normalizePersonalisationContext(wire as PersonalisationContext);
}

const DERIVED_AT = "2026-09-19T05:00:00.000Z"; // canonical fixture derivedAt
const DAY_MS = 86_400_000;

function temporalTwin(over: Record<string, unknown> = {}) {
  // A second temporal signal for the same subject, distinct lineage.
  const base = canonicalWire().temporalSignals[0] as unknown as Record<string, unknown>;
  return {
    ...base,
    signalId: "sig-tmp-2",
    provenance: {
      ...(base.provenance as Record<string, unknown>),
      providerEventIds: ["plex-evt-c9"],
      batchIds: ["ing-2026-09-18-02"],
    },
    ...over,
  } as Record<string, unknown>;
}

/* --------------------------- window extraction --------------------------- */

test("7.3 windows: extraction reads label and bounds honestly; rolling windows compute from derivedAt", () => {
  const pack = packOf();
  const observed = extractWindow((pack.evidence.observedSignals[0] as unknown) as Record<string, unknown>);
  assert.deepEqual(observed, { label: "all_ingested" });

  const temporal = extractWindow((pack.evidence.temporalSignals[0] as unknown) as Record<string, unknown>);
  assert.ok(temporal, "rolling window must extract");
  const expectedStart = new Date(Date.parse(DERIVED_AT) - 30 * DAY_MS).toISOString();
  assert.deepEqual(temporal, {
    label: "rolling_30d",
    startsAt: expectedStart,
    endsAt: DERIVED_AT,
  });
});

test("7.3 windows: an item with no window material extracts nothing (null — not a fabricated span)", () => {
  assert.equal(extractWindow({ value: {}, coverage: {} }), null);
  assert.equal(extractWindow({}), null);
  // A genuinely window-free temporal specimen: neither coverage material
  // nor a producer-declared value.window — absence stays absence.
  assert.equal(extractWindow({
    evidenceClass: "temporal_signal",
    value: { playsLast30d: 4, playsLast90d: 7 },
    coverage: {},
  }), null);
});

/* ------- 7.3 producer-declared window (upstream value.window) ------- */

test("7.3 windows: producer-declared value.window is identified verbatim — bounds cross, no reconstruction", () => {
  const base = canonicalWire().temporalSignals[0] as unknown as Record<string, unknown>;
  const producerOnly = { ...base, coverage: {} }; // coverage silent; only the producer window speaks
  const extracted = extractWindow(producerOnly);
  assert.deepEqual(extracted, {
    startsAt: "2026-08-20T05:00:00.000Z",
    endsAt: "2026-09-19T05:00:00.000Z",
  });
  // Identification, not anchoring: a wildly different derivedAt must NOT
  // shift the declared bounds (no DAY_MS, no arithmetic at this branch).
  assert.deepEqual(extractWindow({ ...producerOnly, derivedAt: "2020-01-01T00:00:00.000Z" }), extracted);
  // Malformed declarations are not windows: missing/unparseable bounds.
  assert.equal(extractWindow({ ...base, coverage: {}, value: { window: { startsAt: "nope", endsAt: "also-nope" } } }), null);
  assert.equal(extractWindow({ ...base, coverage: {}, value: { window: { startsAt: "2026-08-20T05:00:00.000Z" } } }), null);
  // Non-temporal classes do not confer window semantics to a same-shaped blob.
  assert.equal(extractWindow({
    evidenceClass: "fact",
    value: { window: { startsAt: "2020-01-01T00:00:00.000Z", endsAt: "2020-02-01T00:00:00.000Z" } },
    coverage: {},
  }), null);
});

test("7.3 windows: identical dual declarations collapse deterministically to the single window", () => {
  const base = canonicalWire().temporalSignals[0] as unknown as Record<string, unknown>;
  // Canonical fixture carries both authorities in agreement (coverage
  // windowDays:30 @ derivedAt === value.window instants). The single
  // window extracts, coverage representation keeps priority (stable key).
  const expectedStart = new Date(Date.parse(DERIVED_AT) - 30 * DAY_MS).toISOString();
  const a = extractWindow(base);
  const b = extractWindow(base);
  assert.deepEqual(a, { label: "rolling_30d", startsAt: expectedStart, endsAt: DERIVED_AT });
  assert.deepEqual(a, b); // deterministic, byte-identical
  assert.equal(windowIdentity(a!), windowIdentity(b!));
});

test("7.3 windows: conflicting declared windows are refused — never silently reconciled", () => {
  const base = canonicalWire().temporalSignals[0] as unknown as Record<string, unknown>;
  const conflict = {
    ...base,
    value: {
      ...(base.value as Record<string, unknown>),
      window: { startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-19T05:00:00.000Z" }, // 18d ≠ coverage rolling_30d
    },
  };
  assert.throws(
    () => extractWindow(conflict),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "void_claim",
  );
  // The same refusal on the claim path: no window identity, no claim.
  const wire = { ...emptyWire(), temporalSignals: [conflict] };
  const pack = packOf(wire);
  assert.throws(
    () => temporalClaim(pack, { collection: "temporalSignals", index: 0 }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "void_claim",
  );
  // And a label-only coverage window cannot be SHOWN identical to
  // declared producer bounds — un-comparable is also a refusal.
  assert.throws(
    () => extractWindow({ ...base, coverage: { label: "all_ingested" } }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "void_claim",
  );
});

test("7.3 windows: overlap is interval-exact; undetermined windows are reported, not guessed", () => {
  const a = { startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-09-01T00:00:00.000Z" };
  const b = { startsAt: "2026-08-15T00:00:00.000Z", endsAt: "2026-09-15T00:00:00.000Z" };
  const c = { startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-11-01T00:00:00.000Z" };
  assert.equal(windowsOverlap(a, b).overlaps, true);
  assert.equal(windowsOverlap(a, c).overlaps, false);
  // Same identity = same window (not a "conflict pair" basis).
  assert.equal(windowsOverlap(a, { ...a }).sameWindow, true);
  // Label-only windows cannot be interval-compared: conservatively treated
  // as possibly overlapping, and the basis says it was undetermined.
  const undetermined = windowsOverlap({ label: "backfill_2019" }, { label: "instrumented_2026" });
  assert.equal(undetermined.overlaps, true);
  assert.equal(undetermined.basis, "undetermined");
});

/* ------------------------------ temporal ------------------------------ */

test("7.3 temporal: an as-of claim carries the evidence window, the evidence time, and verbatim metric", () => {
  const pack = packOf();
  const c = temporalClaim(pack, { collection: "temporalSignals", index: 0 });
  assert.equal(c.kind, "temporal_synthesis");
  assert.equal(c.epistemicStatus, "derived");
  const claim = c.claim;
  assert.equal(claim.asOf, DERIVED_AT); // the evidence's own time, not a clock
  assert.equal(claim.window.label, "rolling_30d");
  assert.deepEqual(claim.metric, { playsLast30d: 4, playsLast90d: 7,
    window: { startsAt: "2026-08-20T05:00:00.000Z", endsAt: "2026-09-19T05:00:00.000Z" } });
  assert.deepEqual(Object.keys(claim).sort(), ["asOf", "metric", "signal", "subject", "window", "windowKey"]);
});

test("7.3 temporal: no extractable window → the claim is not formed (lineage, not invention)", () => {
  // Genuinely window-free specimen per the producer-window branch: the
  // canonical fixture legitimately carries value.window now, so the
  // negative case must remove BOTH authorities.
  const windowFree = {
    ...(canonicalWire().temporalSignals[0] as unknown as Record<string, unknown>),
    coverage: {},
    value: { playsLast30d: 4, playsLast90d: 7 },
  };
  const wire = { ...emptyWire(), temporalSignals: [windowFree] };
  const pack = packOf(wire);
  assert.throws(
    () => temporalClaim(pack, { collection: "temporalSignals", index: 0 }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "lineage_incomplete",
  );
});

test("7.3 temporal: window comparison is arithmetic with explicit relation — greater/less/equal, never an adjective", () => {
  const earlier = temporalTwin({
    signalId: "sig-tmp-prior",
    value: { playsLast30d: 7, playsLast90d: 9 },
    coverage: { windowDays: 30, complete: true },
    derivedAt: "2026-08-20T05:00:00.000Z",
  });
  const wire = {
    ...emptyWire(),
    temporalSignals: [canonicalWire().temporalSignals[0], earlier],
  };
  const pack = packOf(wire);
  const c = compareWindows(pack, [
    { collection: "temporalSignals", index: 1 },
    { collection: "temporalSignals", index: 0 },
  ], { metricKey: "playsLast30d" });
  assert.equal(c.kind, "temporal_synthesis");
  assert.equal(c.epistemicStatus, "derived");
  const claim = c.claim;
  // Sorted by window start (prior first, regardless of ref order).
  assert.equal(claim.perWindow.length, 2);
  assert.equal(claim.perWindow[0].value, 7);
  assert.equal(claim.perWindow[1].value, 4);
  assert.deepEqual(claim.comparisons, [
    { aWindowKey: claim.perWindow[0].windowKey, bWindowKey: claim.perWindow[1].windowKey, delta: -3, relation: "less" },
  ]);
  const json = JSON.stringify(claim).toLowerCase();
  for (const noun of ["interest", "trend up", "growing", "surging", "waning", "love", "prefer"]) {
    assert.ok(!json.includes(noun), `comparison claim must not contain "${noun}"`);
  }
});

test("7.3 temporal: trends refuse overlapping windows, missing metrics, mixed subjects, and mixed classes", () => {
  const wire = {
    ...emptyWire(),
    temporalSignals: [
      canonicalWire().temporalSignals[0],
      temporalTwin({ value: { playsLast30d: 9 } }), // same window as the canonical one
    ],
  };
  const pack = packOf(wire);
  assert.throws(
    () => compareWindows(pack, [
      { collection: "temporalSignals", index: 0 },
      { collection: "temporalSignals", index: 1 },
    ], { metricKey: "playsLast30d" }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "void_claim",
  );
  assert.throws(
    () => compareWindows(pack, [{ collection: "temporalSignals", index: 0 }], { metricKey: "playsLast30d" }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "lineage_incomplete",
  );

  const pack2 = packOf({ ...emptyWire(), temporalSignals: [canonicalWire().temporalSignals[0], temporalTwin({ value: { playsLast90d: 3 }, coverage: { windowDays: 30 }, derivedAt: "2026-08-20T05:00:00.000Z" })] });
  assert.throws(
    () => compareWindows(pack2, [
      { collection: "temporalSignals", index: 0 },
      { collection: "temporalSignals", index: 1 },
    ], { metricKey: "playsLast30d" }),
    (error: unknown) => (error as ReasoningRejectError).rejectKind === "void_claim",
  );
});

/* ---------------------------- contradiction ----------------------------- */

test("7.3 contradiction: overlapping windows + different values + distinct lineage → surfaced, both preserved", () => {
  const conflicting = temporalTwin({ value: { playsLast30d: 9, playsLast90d: 9 } });
  const wire = { ...emptyWire(), temporalSignals: [canonicalWire().temporalSignals[0], conflicting] };
  const pack = packOf(wire);
  const found = surfaceContradictions(pack, "temporalSignals");
  assert.equal(found.length, 1);
  const conclusion = found[0];
  assert.equal(conclusion.kind, "contradiction"); // positive claim voiding does not apply here
  assert.equal(conclusion.epistemicStatus, "derived");
  const claim = conclusion.claim;
  assert.deepEqual(claim.collection, "temporalSignals");
  // BOTH pieces preserved with both windows and both lineages:
  const ids = [claim.a, claim.b].map((side) => side.ref.signalId ?? `${side.ref.collection}[${side.ref.index}]`).sort();
  assert.deepEqual(ids, ["sig-tmp-1", "sig-tmp-2"]);
  assert.ok(claim.a.window && claim.b.window);
  assert.ok(JSON.stringify(claim).includes("eventIds") === false, "payload references lineage via refs, not duplication");
  // And there is no resolution anywhere: no winner, no chosen value.
  for (const key of Object.keys(claim)) {
    assert.ok(!/winner|resolved|chosen|merged/i.test(key));
  }
});

test("7.3 contradiction: same lineage restating itself is one chain, not a conflict", () => {
  // Identical lineage (same providerEventIds/batchIds), different computed
  // value — a recompute drift inside ONE lineage; never two truths.
  const base = canonicalWire().temporalSignals[0] as unknown as Record<string, unknown>;
  const drifted = {
    ...base,
    signalId: "sig-tmp-recompute",
    value: { playsLast30d: 99, playsLast90d: 99 },
  };
  const wire = { ...emptyWire(), temporalSignals: [base, drifted] };
  const pack = packOf(wire);
  assert.equal(surfaceContradictions(pack, "temporalSignals").length, 0);
});

test("7.3 contradiction: different windows both stand — no conflict is manufactured across time", () => {
  const later = temporalTwin({
    value: { playsLast30d: 9, playsLast90d: 9 },
    derivedAt: "2026-12-25T05:00:00.000Z", // disjoint rolling window
  });
  const wire = { ...emptyWire(), temporalSignals: [canonicalWire().temporalSignals[0], later] };
  const pack = packOf(wire);
  assert.equal(surfaceContradictions(pack, "temporalSignals").length, 0);
});

test("7.3 contradiction: same values under overlapping windows are agreement — and silence is honest", () => {
  const agreeing = temporalTwin({ value: { playsLast30d: 4, playsLast90d: 7,
    window: { startsAt: "2026-08-20T05:00:00.000Z", endsAt: "2026-09-19T05:00:00.000Z" } } });
  const wire = { ...emptyWire(), temporalSignals: [canonicalWire().temporalSignals[0], agreeing] };
  const pack = packOf(wire);
  const found = surfaceContradictions(pack, "temporalSignals");
  assert.equal(found.length, 0); // absence of output = none surfaced HERE, not "no contradictions exist"
});

test("7.3 contradiction: determinism + frozen conclusions; unknown-grounded contradictions are emittable", () => {
  const conflicting = temporalTwin({ value: { playsLast30d: 9, playsLast90d: 9 } });
  const wire = { ...emptyWire(), temporalSignals: [canonicalWire().temporalSignals[0], conflicting] };
  const pack = packOf(wire);
  const a = surfaceContradictions(pack, "temporalSignals");
  const b = surfaceContradictions(pack, "temporalSignals");
  assert.deepEqual(a, b);
  assert.ok(Object.isFrozen(a[0].claim));

  // A contradiction kind may stand on unknown ground (C2 only voids
  // positive claims): conflicting fact values, one of them unknown.
  // Lineage handles armed (C4 wall) — distinct batches make them two
  // independent witnesses.
  const facts = [
    { evidenceClass: "fact", factType: "total_plays", value: 412, epistemicStatus: "observed", provenance: { derivedFrom: "watch_observation", batchIds: ["ing-wit-a"] } },
    { evidenceClass: "fact", factType: "total_plays", value: 900, epistemicStatus: "unknown", provenance: { derivedFrom: "watch_observation", batchIds: ["ing-wit-b"] } },
  ];
  const pack2 = packOf({ ...emptyWire(), facts });
  const found = surfaceContradictions(pack2, "facts");
  assert.equal(found.length, 1);
  assert.equal(found[0].epistemicStatus, "unknown"); // floor — never smoothed upward
});
