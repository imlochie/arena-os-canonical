/**
 * Gate 7, slice 7.4 tests: the renderer contract — the mouth, not the brain.
 *
 * The renderer turns a CERTIFIED structured conclusion into language
 * without adding information. It must not calculate, infer, select
 * evidence, raise a ceiling, invent temporal language, or "make it more
 * natural" with affect vocabulary. It renders only what the calculus
 * already decided, from the conclusion envelope alone (never the raw
 * pile), and it fails closed on any claim shape it does not recognize.
 *
 * Wording that describes evidence mechanics (window names, statuses,
 * lineage refs) is declared, not invented: it comes from the certified
 * envelope. Affect is scanned for on template text — quoted subjects
 * are DATA ("movie:love-actually" is a title, not an emotion).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderConclusion, assertRendererVocabulary, RenderError } from "./render";
import { buildConclusion } from "./lattice";
import { restateEvidence, aggregateEvidence } from "./synthesizers";
import { temporalClaim, compareWindows } from "./temporal";
import { surfaceContradictions } from "./contradictions";
import { canonicalWire, emptyWire } from "../personalisation/fixtures";
import { normalizePersonalisationContext } from "../personalisation/context";
import type { PersonalisationContext } from "../personalisation/generated/types";

function packOf(wire: unknown = canonicalWire()) {
  return normalizePersonalisationContext(wire as PersonalisationContext);
}

const WINDOW_30D = { label: "rolling_30d", startsAt: "2026-08-20T00:00:00.000Z", endsAt: "2026-09-19T00:00:00.000Z" };
const WINDOW_ALL = { label: "all_ingested" };
const AFFECT = /\b(love|like|enjoy|favourite|favorite|prefer|adorable|taste|obsessed|recommend|suggest|interest|score|rank)\b|you(r)?\b/i;

/* ------------------------------ restatement ------------------------------ */

test("7.4 render: restatement of a fact is a faithful sentence with a certified attribution", () => {
  const pack = packOf();
  const conclusion = restateEvidence(pack, { collection: "facts", index: 0 }, {
    window: WINDOW_ALL, scopeIdentity: "archive",
  });
  const rendered = renderConclusion(conclusion);
  assert.equal(rendered.kind, "restatement");
  assert.match(rendered.statement, /^The archive records 412 for "total_plays" in the all_ingested window\.$/);
  // The certificate travels with the sentence — status/scope/window/lineage:
  assert.equal(rendered.epistemicStatus, "observed");
  assert.equal(rendered.scopeIdentity, "archive");
  assert.match(rendered.attribution, /status observed/);
  assert.match(rendered.attribution, /scope archive/);
  assert.match(rendered.attribution, /rule restate\.v1/);
  assert.match(rendered.attribution, /facts\[0\]/);
});

test("7.4 render: restated signal renders verbatim metrics without adjectives", () => {
  const pack = packOf();
  const conclusion = restateEvidence(pack, { collection: "temporalSignals", index: 0 }, { window: WINDOW_30D });
  const rendered = renderConclusion(conclusion);
  assert.match(rendered.statement, /playsLast30d=4/);
  assert.match(rendered.statement, /playsLast90d=7/);
  assert.match(rendered.statement, /"show:example-show"/);
  assert.ok(!AFFECT.test(rendered.statement), `statement must not wear affect: ${rendered.statement}`);
  assert.equal(rendered.epistemicStatus, "derived"); // never raised
});

test("7.4 render: class-only restatements do not parrot upstream prose", () => {
  const pack = packOf();
  const conclusion = restateEvidence(pack, { collection: "interpretations", index: 0 }, { window: WINDOW_ALL, scopeIdentity: "archive" });
  const rendered = renderConclusion(conclusion);
  assert.match(rendered.statement, /class "interpretation"/);
  assert.ok(!rendered.statement.includes("Viewing recurs weekly"), "the renderer does not echo interpretation prose");
});

/* ------------------------------ aggregation ------------------------------ */

test("7.4 render: aggregation statements are the certified arithmetic, nothing more", () => {
  const pack = packOf();
  const sum = renderConclusion(aggregateEvidence(pack, [
    { collection: "facts", index: 0 },
    { collection: "facts", index: 1 },
  ], { mode: "sum", window: WINDOW_ALL, scopeIdentity: "archive" }));
  assert.match(sum.statement, /total of 499 across 2 facts/);
  assert.ok(!AFFECT.test(sum.statement));

  const subjects = renderConclusion(aggregateEvidence(pack, [
    { collection: "observedSignals", index: 0 },
    { collection: "observedSignals", index: 1 },
  ], { mode: "subjects", window: WINDOW_ALL }));
  assert.match(subjects.statement, /1 distinct subject/);
  assert.match(subjects.statement, /"show:example-show"/);
  assert.equal(subjects.epistemicStatus, "derived");
});

/* ------------------------------- temporal -------------------------------- */

test("7.4 render: an as-of statement speaks evidence time, never wall-clock time", () => {
  const pack = packOf();
  const conclusion = temporalClaim(pack, { collection: "temporalSignals", index: 0 });
  const a = renderConclusion(conclusion);
  const b = renderConclusion(conclusion);
  assert.deepEqual(a, b); // replayable: no clock inside the mouth either
  assert.match(a.statement, /^As of 2026-09-19T05:00:00\.000Z,/);
  assert.match(a.statement, /rolling_30d/);
  assert.ok(!AFFECT.test(a.statement));
});

test("7.4 render: window comparison renders numbers and relation words only", () => {
  const prior = {
    ...canonicalWire().temporalSignals[0],
    signalId: "sig-tmp-prior",
    value: { playsLast30d: 7, playsLast90d: 9 },
    coverage: { windowDays: 30, complete: true },
    derivedAt: "2026-08-20T05:00:00.000Z",
  };
  const pack = packOf({ ...emptyWire(), temporalSignals: [canonicalWire().temporalSignals[0], prior] });
  const conclusion = compareWindows(pack, [
    { collection: "temporalSignals", index: 0 },
    { collection: "temporalSignals", index: 1 },
  ], { metricKey: "playsLast30d" });
  const rendered = renderConclusion(conclusion);
  assert.match(rendered.statement, /7/);
  assert.match(rendered.statement, /4/);
  assert.match(rendered.statement, /less by 3/);
  const prohibited = /\b(growing|increasing|surging|waning|trending|interest)\b/i;
  assert.ok(!prohibited.test(rendered.statement));
});

/* ----------------------------- contradiction ----------------------------- */

test("7.4 render: a contradiction sentence preserves both sides and disclaims resolution", () => {
  const conflicting = {
    ...canonicalWire().temporalSignals[0],
    signalId: "sig-tmp-2",
    value: { playsLast30d: 9, playsLast90d: 9 },
    provenance: {
      ...(canonicalWire().temporalSignals[0].provenance as Record<string, unknown>),
      providerEventIds: ["plex-evt-c9"],
      batchIds: ["ing-2"],
    },
  };
  const pack = packOf({ ...emptyWire(), temporalSignals: [canonicalWire().temporalSignals[0], conflicting] });
  const [conclusion] = surfaceContradictions(pack, "temporalSignals");
  const rendered = renderConclusion(conclusion);
  assert.match(rendered.statement, /sig-tmp-1/);
  assert.match(rendered.statement, /sig-tmp-2/);
  assert.match(rendered.statement, /\b4\b/);
  assert.match(rendered.statement, /\b9\b/);
  assert.match(rendered.statement, /[Nn]o resolution is made/);
  assert.ok(!/\b(winner|correct value|most likely|we take|prefer the)\b/i.test(rendered.statement));
});

/* --------------------------- absence-qualified --------------------------- */

test("7.4 render: absence is always delivered with its qualifier attached", () => {
  const pack = packOf();
  const conclusion = buildConclusion({
    kind: "absence_qualified",
    pack,
    rule: "qualify.v1",
    loadBearing: [{ collection: "facts", index: 3 }],
    scopeIdentity: "archive",
    window: WINDOW_ALL,
    claim: { open: "watchlist_presence" },
  });
  const rendered = renderConclusion(conclusion);
  assert.match(rendered.statement, /watchlist_presence/);
  assert.match(rendered.statement, /remains open/);
  assert.match(rendered.statement, /no positive evidence/);
  assert.match(rendered.statement, /in this evidence delivery/);
  // The forbidden form — a bare universal negative — must never appear.
  assert.ok(!/^There is no watchlist/.test(rendered.statement));
});

/* -------------------- the vocabulary guard (direct) ---------------------- */

test("7.4 render: the vocabulary guard throws on affect and upgrades — including 'love' outside quotes", () => {
  assert.throws(() => assertRendererVocabulary("you will love this"), RenderError);
  assert.throws(() => assertRendererVocabulary("your favourite"), RenderError);
  assert.throws(() => assertRendererVocabulary("this is trending"), RenderError);
  assert.doesNotThrow(() => assertRendererVocabulary("The archive records 4 plays in the rolling_30d window."));
});

test("7.4 render: quoted subjects are data — a title containing 'love' renders without tripping the guard", () => {
  const wire = {
    ...emptyWire(),
    observedSignals: [{ ...canonicalWire().observedSignals[0], subjectIdentity: "movie:love-actually" }],
  };
  const pack = packOf(wire);
  const conclusion = restateEvidence(pack, { collection: "observedSignals", index: 0 }, { window: WINDOW_ALL });
  const rendered = renderConclusion(conclusion);
  assert.match(rendered.statement, /"movie:love-actually"/);
});

/* ------------------- fail closed, determinism, freeze --------------------- */

test("7.4 render: unrecognized claim shapes fail closed — the mouth does not improvise", () => {
  const pack = packOf();
  const good = restateEvidence(pack, { collection: "facts", index: 0 }, { window: WINDOW_ALL, scopeIdentity: "archive" });
  const mangled = { ...good, claim: { somethingUnexpected: true } };
  assert.throws(() => renderConclusion(mangled as never), (error: unknown) =>
    error instanceof RenderError && (error as RenderError).renderKind === "unsupported_claim",
  );
});

test("7.4 render: rendered verdicts are frozen and byte-stable; status is never raised", () => {
  const pack = packOf();
  const conclusion = aggregateEvidence(pack, [
    { collection: "facts", index: 0 },
    { collection: "facts", index: 2 },
  ], { mode: "count", window: WINDOW_ALL, scopeIdentity: "archive" });
  assert.equal(conclusion.epistemicStatus, "coverage-limited");
  const rendered = renderConclusion(conclusion);
  assert.equal(rendered.epistemicStatus, "coverage-limited"); // mouth does not touch ceilings
  assert.ok(Object.isFrozen(rendered));
  assert.deepEqual(renderConclusion(conclusion), rendered);
});
