# Gate 7 — temporal-window seam investigation

> **Date:** 2026-09-19 · **Base:** `05742a3` · **Upstream pin:** `imlochie/SomeSafePortablesoftware@b5ca1647883cc06c9180015b07470a7880d1a56a`
> **Status:** investigation only. Nothing implemented. No machinery, extractor,
> contract, fixture, or upstream file was changed. Verdict presented for owner
> decision before any slice is cut.
>
> **Question (owner, verbatim):** Can the existing upstream producer-authored
> evidence legitimately provide a temporal window identity that Gate 7 can
> inspect, and if not, what is the smallest authoritative upstream contract
> change required?
>
> **Answer: no to (1), no to (2), yes to (3) — with the smallest change being
> producer emission of window *bounds* the producer's own authored adapter
> contract already calls for. No to (4): the gap is a missing bolt, not a
> deliberate boundary, and the evidence for that is upstream's own documents.**

## Method — trees, not reports

Inspected, verbatim at the pinned trees:

| Surface | Artifact |
|---|---|
| Arena window vocabulary | `src/lib/archive-reasoning/windows.ts` (`extractWindow`) |
| Arena temporal claim path | `src/lib/archive-reasoning/temporal.ts` (`temporalClaim`) |
| Real evidence receipt | `scripts/fixtures/real-evidence-upstream-capture.json` |
| Producer implementation | upstream `artifacts/api-server/src/services/behavioral-intelligence.ts`, `archive-analytics.ts` |
| Producer OpenAPI | `b5ca164` spec, component `BehavioralSignal` |
| Producer authored docs | upstream `docs/arena-personalisation-input-adapter-contract.md`, `docs/behavioral-intelligence-foundation.md` |

## The seam, precisely located

`extractWindow` anchors on **evidence-declared** window vocabulary only
(`windows.ts:25-43`):

- `coverage.label` / `coverage.window` — label-only identity;
- `coverage.startsAt` / `coverage.endsAt` — explicit bounds;
- `coverage.windowDays` (number) + the item's own `derivedAt` — composed
  rolling window, arithmetic over *declared* values, never a clock.

The real producer's `coverage` object carries a **disjoint vocabulary**
(`behavioral-intelligence.ts`, `coverageFor`):

```
{ historicalCoverageStart: null, collectingSince: "2026-09-19",
  source: "Archive Assistant analytics coverage" }
```

Zero field overlap. `extractWindow` returns `null`; `temporalClaim` throws
`lineage_incomplete` with exactly the right sentence ("the coverage record
carries none"). This is real-evidence row 14 of
`docs/e2e-gate7-real-evidence.md` — a correctly detected absence, not a
calculus defect.

## Why the candidate fields do not define the window

**`coverage.collectingSince` / `historicalCoverageStart`** — these are
*ingestion-era* descriptors, not measurement windows. They live in the
per-owner `analytics_coverage` table, are written only at watch ingestion
(`archive-analytics.ts:224-232`), and the producer itself uses
`collecting_since` solely as an epistemic limiter
(`coverage-limited` status, `archive-analytics.ts:352`). As a window start
it would actively *contradict* the evidence: the capture has
`watchesLast90Days = 2` counting an `2026-08-01` event, while
`collectingSince = 2026-09-19` — a "window" starting then cannot contain
its own metric. Reading it as a window bound would be Arena upgrading
evidence. Refused.

**`value.comparisonWindowDays: 90`** — the closest candidate, and still not
a window identity. In the producer it is a hardcoded literal sitting beside
the filter constants (`behavioral-intelligence.ts:58-68`):
`now - viewed_at <= 30 * 86400000` / `90 * 86400000`, and the value blob
`{ watchesLast30Days, watchesLast90Days, lastWatchedAt, comparisonWindowDays: 90 }`.
It is a day-*count* inside an untyped blob (`value: { type: object,
additionalProperties: true }`), with no declared anchor, no bounds, and no
stated day-length — and the same item carries a second sub-window (30d)
embedded only in a metric *name*. To compose a window from it, Arena would
have to import three facts that exist only as upstream code literals, not
declared semantics: (i) that `comparisonWindowDays` names this item's
envelope window; (ii) that a day is exactly 86,400,000 ms; (iii) that the
window ends at `derivedAt`. Each import is Arena manufacturing producer
meaning — precisely the §9 upgrade. Refused.

(Proviso: those literals mean the composable window would be *correct*
today. Correct-by-inspection-of-implementation is not the same as
inspectable-by-contract; the producer could inline change `90` tomorrow
and Arena's assumption would go silently stale. Meaning must cross the
contract, not the codebase.)

## The deliberate-boundary hypothesis (4) — rejected by upstream's own pen

`docs/arena-personalisation-input-adapter-contract.md` §10, *author: the
producer*, addressed to Arena:

> The adapter preserves temporal data rather than creating a static
> preference. It should carry, **where available**: observedAt;
> firstActivityAt; lastActivityAt; **recent window boundaries and counts**;
> long-term window boundaries; rewatch intervals; coverage boundaries;
> signal generation time.

And `docs/behavioral-intelligence-foundation.md` documents the profile
semantics: "`recent`: 30/90-day activity windows". The runtime currently
carries the *counts* but not the *boundaries* — i.e., the producer is
already failing to emit one line item of its own authored adapter contract.
The boundary is missing evidence, not withheld evidence. (4) is out.

## (3) — the smallest authoritative change

**Producer emits an explicit window identity on `recent_activity` temporal
signals. Arena changes nothing.**

Rationale for bounds over a count:

- **What:** two ISO strings — the window's `startsAt` and `endsAt` — placed
  on the signal, computed from the *same* `now` the rolling filters used.
  A label (`rolling_90d`) is optional sugar; bounds alone carry full
  identity (`windowIdentity` and the interval-overlap path need no label).
- **Why bounds, not `windowDays`:** a count would force Arena to re-anchor
  at `derivedAt` — and the capture exhibits a genuine producer fidelity
  fault there: `insertSignal` writes `derived_at = new Date()`
  (`behavioral-intelligence.ts:37`) — a *second* clock call — while the
  windows are filtered on the injected `now` parameter. The capture's own
  rows testify to the skew: the harness derived the context at
  `2026-09-19T00:00:00.000Z`, yet every signal row's `derivedAt` is the
  runtime wall instant `10:22:53.7xxZ`. Bounds-taken-at-filter-time are
  immune to this; a count is hostage to it. Emitting bounds therefore also
  *requires* (one line) that the producer stamp `derived_at` from the same
  instant — worth doing either way.
- **Why Arena-side zero change:** `extractWindow`'s explicit-bounds branch
  already ingests exactly this shape and is already test-covered
  (`temporal.test.ts`). No extractor edit, no calculus edit, no Gate-7
  surface motion of any kind.
- **Contract delta, smallest form:** upstream OpenAPI `BehavioralSignal`
  currently types `coverage` as an untyped object
  (`additionalProperties: true`). The authoritative delta is: name the
  emitted window fields in that schema (three optional string properties —
  and, while the pen is out, typing the existing `collectingSince` /
  `historicalCoverageStart` / `source` it already emits), plus one sentence
  in §10-style language stating: *recent-activity signals carry their
  measurement window as explicit bounds anchored at the derivation
  instant.* No new endpoint, no new evidence class, no field on any other
  signal kind.
- **Scope note (kept deliberately small):** the item also contains a 30-day
  sub-window embedded in a metric name. Emitting only the envelope (90d)
  bounds is honest — Gate 7 claims one window per item, and any later
  30d-vs-90d comparison across overlapping windows is refused by the
  existing overlap guard. Per-metric windows are a separate, deferred
  question, not part of this fix.

**What this does *not* change:** no temporal *reasoning* is unlocked beyond
what 7.3 already certifies — a single temporal signal inside its own
evidence window, as-of evidence time. Trends still need ≥2 genuinely
non-overlapping windows of the same subject; the real surface still has
one temporal signal. No taste model, no scoring, no inference, no new
conclusion kinds.

## Verification state of this investigation

No code moved. The claim "the coverage record carries none" is reproducible
byte-for-byte by `scripts/e2e-gate7-real-evidence-driver.mjs` row 14 at
`05742a3`. All producer-side quotations above are from the pinned upstream
tree; all Arena-side quotations from this commit. If the owner approves
the §(3) change upstream, the experiment is: land it → recapture through
the existing harness → regenerate the pinned contract → re-run the
real-evidence driver — where row 14 must flip from `lineage_incomplete` to
a certified `temporal_claim` whose window is *evidence-derived*, and every
other row must stay exactly as it is (the determinism row included).
Nothing else is licensed to move.

> *Provenance establishes lineage, not meaning. The window meaning already
> exists — in the producer's filters and in its own adapter contract. The
> seam is missing only its emission.*
